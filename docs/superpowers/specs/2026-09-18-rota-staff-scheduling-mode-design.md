# Rota: per-staff scheduling mode (generated / fixed / manual)

Status: approved design, awaiting implementation plan.

## Context

Two data corrections surfaced a missing model concept in the rota module
(`app/rota/page.tsx`, `/api/rota/*`, `lib/rota/*`, `db/migrations/`):

1. Brian K's role in the seed is wrong — he's a Driver (takes residents on
   outings), seeded as Kitchen.
2. Gail (Dom) works a fixed 09:00–13:00 Monday to Friday, off weekends, and this
   never varies except for annual leave. Today the only way to represent
   "never varies" is the `officeHours` boolean, which is itself a hardcoded
   special-case in the generator (Mon–Fri `IN`, weekends `D/O`) used only for
   Sumy.

Rather than adding a second special-case for Gail (and a third down the line),
this introduces a general **scheduling mode** per staff member:

- **generated** (default) — the solver assigns them, as today.
- **fixed** — a set weekly pattern, laid down on every build; a leave override
  (which locks automatically, per existing rota behaviour) wins over the
  pattern for that day; the solver never picks them for other slots.
- **manual** — always left blank after a build, for Sumy to fill in by hand;
  the solver never picks them for other slots either.

Fixed and manual staff still count toward cover totals and hours once their
cells hold a real assignment (pattern-derived or hand-entered) — this falls
out of how totals are already computed from `rota_assignments`, no separate
mechanism needed.

## Decisions

- The existing `officeHours` boolean is folded into this concept rather than
  kept alongside it. Anyone with `officeHours = true` today (currently only
  Sumy) becomes `scheduling_mode = 'fixed'` with a pattern that reproduces the
  old hardcoded behaviour exactly (`IN` Mon–Fri, `D/O` weekends) — one
  mechanism instead of two, and no change in what Sumy sees.
- Fixed-pattern rows reuse the same `kind` (`shift` | `code`) shape as
  `rota_assignments` and `rota_availability`'s shift keys, rather than
  inventing a second way to describe a shift. Gail's 09:00–13:00 slot needs a
  new shift definition (`dom`) since it matches none of the existing four.
  There's no admin UI for shift definitions yet (they only ever came from
  `db/seed.ts`); adding one is out of scope here — the new shift definition
  goes in as a one-off manual SQL insert against the live database, and into
  `db/seed.ts` for fresh environments.
- Role and scheduling mode become editable per staff member in the Staff
  panel (role was previously only set at creation; scheduling mode replaces
  the old office-hours toggle there). This is also how Brian K's role and
  Gail's mode actually get corrected on the live system — not a data
  migration, since the seed script only ever runs once and must never
  clobber data that's since been edited in the app.

## Data model

`db/migrations/0004_rota_scheduling_mode.sql`:

```sql
ALTER TABLE rota_staff ADD COLUMN scheduling_mode text NOT NULL DEFAULT 'generated'
    CHECK (scheduling_mode IN ('generated', 'fixed', 'manual'));

-- Anyone currently on office_hours becomes 'fixed' — same idea, one mechanism.
UPDATE rota_staff SET scheduling_mode = 'fixed' WHERE office_hours = true;

CREATE TABLE rota_fixed_patterns (
    tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    staff_id    uuid NOT NULL REFERENCES rota_staff(id) ON DELETE CASCADE,
    day_of_week smallint NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
    kind        text NOT NULL CHECK (kind IN ('shift', 'code')),
    shift_key   text,
    code        text,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (staff_id, day_of_week),
    CHECK ((kind = 'shift' AND shift_key IS NOT NULL) OR (kind = 'code' AND code IS NOT NULL))
);

ALTER TABLE rota_fixed_patterns ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON rota_fixed_patterns
    USING (tenant_id = current_setting('app.tenant_id')::uuid);

-- Backfill: replicate the old hardcoded office-hours behaviour (IN Mon-Fri,
-- D/O weekends) as real pattern rows, so migrating Sumy changes nothing
-- about what she sees.
INSERT INTO rota_fixed_patterns (tenant_id, staff_id, day_of_week, kind, code)
SELECT tenant_id, id, d, 'code', CASE WHEN d < 5 THEN 'IN' ELSE 'D/O' END
FROM rota_staff, generate_series(0, 6) AS d
WHERE scheduling_mode = 'fixed';

ALTER TABLE rota_staff DROP COLUMN office_hours;
```

`db/schema/rota.ts` — drop `officeHours` from `rotaStaff`, add `schedulingMode`
(text, not null, default `"generated"`); add a matching `rotaFixedPatterns`
Drizzle table.

## Types (`lib/rota/types.ts`)

```ts
export type SchedulingMode = "generated" | "fixed" | "manual";

export interface FixedPatternEntry {
  kind: "shift" | "code";
  shiftKey: string | null;
  code: string | null;
}

// key: `${staffId}|${day}`
export type FixedPatternMap = Record<string, FixedPatternEntry>;
```

- `StaffMember.officeHours: boolean` → `StaffMember.schedulingMode: SchedulingMode`.
- `RotaConfig` gains `fixedPatterns: FixedPatternMap` (tenant-wide, all staff,
  all days — same load-everything-up-front pattern as `availability`).
- `ROLES` gains `"Driver"`. `CLAUDE.md`'s roles list gets the same one-line
  addition so the documented domain vocabulary doesn't go stale.

## Generator (`lib/rota/generator.ts`)

- `GenerateRotaInput` gains `fixedPatterns: FixedPatternMap`.
- Before the solver runs, merge fixed-pattern entries into the same
  pre-assigned map that `locked` currently seeds: for `scheduling_mode ===
  "fixed"` staff, for each day **not** already present in `locked` (a leave
  override wins over the pattern for that day), take their `fixedPatterns`
  entry. This merged map feeds:
  - the initial `assignments` object,
  - `noteExisting` (so hours/days/weekend/rest-interval state is correct),
  - the `already`-covered count used when computing `need` per slot — so a
    fixed shift reduces cover demand exactly like a locked assignment does
    today.
- All three existing `!s.officeHours` exclusion checks (candidate pool in the
  main slot loop, the `pool()` scarcity helper, and the sleepover-eligibility
  filter) become `s.schedulingMode === "generated"` — fixed and manual staff
  are never solver candidates for anyone else's slots, and can't be picked for
  a sleepover either.
- End-of-build fill loop (currently: office-hours → `IN`/`D/O`, everyone else
  → `D/O` if still unassigned): replaced with — `manual` staff get no row at
  all (blank cell, matches "always left blank for Sumy to fill in by hand");
  `fixed` staff are already filled by the pre-assignment step above, so this
  loop skips them; `generated` staff keep today's `D/O` fallback unchanged.
  The old hardcoded "office hours" block is deleted.

## API

- `app/api/rota/staff/[id]/route.ts` PATCH — accept `schedulingMode`
  (validated against the three values) and `role` (validated against
  `ROLES`); drop the `officeHours` field.
- `app/api/rota/staff/route.ts` POST — drop the explicit `officeHours: false`;
  `schedulingMode` defaults to `"generated"` from the column default.
- `app/api/rota/config/route.ts` — add `fixedPatterns` to the response; swap
  `officeHours` for `schedulingMode` in the staff mapping.
- New `app/api/rota/fixed-pattern/route.ts` — `PUT`, upserts one staff/day
  cell (`kind` + `shiftKey`/`code`), same shape and `applyToWeek` "copy to the
  whole week" convenience as `app/api/rota/availability/route.ts` — cheap to
  add, and directly useful for a Mon–Fri pattern like Gail's.
- `weeks/[weekStart]/build/route.ts` — load all `rota_fixed_patterns` rows
  (day-of-week table, no date range needed) into a `FixedPatternMap`, pass to
  `generateRota`.

All new/changed queries go through `withTenant`, matching every existing rota
route.

## UI (`app/rota/page.tsx`)

- `StaffPanel`: each existing staff row gets a `role` `<select>` (previously
  role was only chosen when adding a new staff member) and a three-way
  scheduling-mode control (segmented buttons: Generated / Fixed pattern /
  Manual) replacing the old "Office hours" toggle button. This is the actual
  mechanism for correcting Brian K's role and setting Gail's (and anyone's)
  mode on the live system.
- `AvailabilityTab`: each staff card branches on `schedulingMode`:
  - `generated` — today's weekly availability grid, unchanged.
  - `fixed` — a parallel 7-day grid, same visual language, where each day
    cycles Off (`D/O`) → pick a shift → pick a leave code, writing through
    the new fixed-pattern endpoint instead of availability.
  - `manual` — no grid; a single line explaining the solver never assigns
    them and Sumy fills every cell by hand each week.

## Seed (`db/seed.ts`)

- `SEED_STAFF`'s `officeHours: boolean` column becomes a `schedulingMode`
  value. Sumy → `"fixed"`. Brian K → role `"Driver"`, `"manual"`. Gail →
  `"fixed"`.
- New shift definition: `{ key: "dom", name: "Dom", startTime: "09:00", endTime: "13:00" }`.
- Seed fixed-pattern rows for Sumy (`IN` Mon–Fri, `D/O` weekends) and Gail
  (`dom` shift Mon–Fri, `D/O` weekends), so a fresh environment is correct out
  of the box.
- This only affects fresh environments — `main()` exits immediately once the
  tenant already exists, so none of this retroactively touches the live
  database.

## Applying this to the live database

Three things don't self-apply from a code deploy alone:

1. The migration handles Sumy automatically (`office_hours = true` →
   `scheduling_mode = 'fixed'` + `IN`/`D/O` pattern backfill) — no manual
   step.
2. One manual SQL insert for the new `dom` shift definition — a single
   `INSERT INTO rota_shift_definitions (...) VALUES (...)` run once against
   the live database, supplied alongside the implementation.
3. Brian K's role/mode and Gail's mode + pattern are set through the new
   Staff-panel and Availability-tab UI after deploy, not through a data
   migration — this is also what makes the same kind of correction self-serve
   from now on instead of a one-off fix.

## Testing

- Generator-level: a fixed staff member's pattern is laid down and untouched
  by the solver across a rebuild; their fixed shift reduces `need` for that
  slot the same as a locked assignment; a manual staff member receives no
  assignment at all from a build; the `office_hours` → `fixed` migration
  produces behaviour identical to today for anyone who had it set (same `IN`
  Mon–Fri / `D/O` weekends outcome).
- Manual, in the browser: set Brian K to Driver/manual, confirm his row stays
  blank across rebuilds and is freely hand-editable; set Gail to fixed with
  her pattern, confirm it reappears identically on every rebuild, and that
  giving her `AL` on a Wednesday (which locks automatically) survives a
  rebuild instead of being overwritten back to the pattern.

## Out of scope

- No shift-definition management UI — the one new shift definition this
  needs is a manual SQL step.
- No bulk "convert several staff to fixed/manual at once" — one at a time via
  the Staff panel, matching how every other per-staff edit works today.
