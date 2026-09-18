# Rota: flexible shift definitions, free-time cell entry, hourly demand

Status: approved design, awaiting implementation plan.

## Context

The rota module has always assumed a fixed set of four shifts
(early/mid/back/night). That doesn't match how Linkfield actually runs —
real shift patterns in use include 07-13, 07-15, 08-16, 10-18, 13-19, 13-21,
14-21, 15-21, 15-23, 18-23, 21-07, and Sumy needs to be able to add or change
these herself rather than waiting on a code change. Once shifts are an
open-ended set, two other things that currently assume "shift" means "one of
four known keys" break:

1. Hand-editing a cell only offers presets from the shift list — there's no
   way to give someone a genuinely one-off time.
2. Cover ("how many staff needed") is currently configured as headcount per
   named shift key. With an open-ended, overlapping set of patterns, that
   stops making sense — Sumy would have to manually reason about which
   combination of shift headcounts nets out to actual hour-by-hour coverage.
   Cover needs to become "how many staff, hour by hour," and the solver's
   job becomes covering that timeline using the defined patterns.

Two prototype files this brief has previously pointed at as references
(`prototypes/rota.jsx`'s "hour-by-hour cover ribbon") turned out not to
actually exist in the repo — only `prototypes/rota-builder.jsx` is present,
and its cell editor is presets-only. This design isn't ported from either
prototype; it's built fresh, following the real app's existing patterns.

## Decisions

- **Shift definitions**: no schema change — `rota_shift_definitions`
  already has everything needed (key/name/start/end/sort_order/is_active).
  Pure API + UI addition. Deactivate, never delete (existing rule, existing
  column).
- **Custom cell times**: a new `AssignmentValue` kind, `"custom"`, carrying
  its own start/end — *not* a throwaway `rota_shift_definitions` row. Adding
  it to the shared shift catalogue would pollute the curated pattern list
  (the ~11 named ones) with one-off exceptions like "07:23–15:10" used once,
  cluttering the Availability tab's shift pickers and the shift-definitions
  editor. A custom time lives only on the one assignment row that uses it.
- **Demand storage**: a 168-value week-relative hourly timeline
  (`day × 24 + hour`, 0–167) — the same absolute-hour convention
  `lib/rota/generator.ts`'s `absStart`/`absEnd` already use internally for
  rest-period math. This makes "overnight" one continuous span instead of
  two fragments split across a calendar-day boundary, with zero special-case
  midnight logic anywhere in the new code.
- **Demand storage shape**: per-hour rows, not range/block rows. Per-hour
  reads are unambiguous (`coverage at hour X = that row's value`) and need
  no overlap-resolution logic, ever. The authoring-tedium downside (168
  cells) is solved with a "fill a range" convenience action plus the
  existing "copy to whole week" convention already used elsewhere in this
  app, rather than by adding range storage and the validation it would
  need.
- **Sleepover count stays separate** from the hourly grid — it isn't an
  hour-coverage concept ("how many people stay over" isn't "how many staff
  during this hour"), so it isn't folded into the same table. Same shape as
  today, just no longer bundled with shift-key demand since demand is no
  longer shift-keyed.
- **Solver strategy**: translate-then-reuse, not a rewritten solver. A new
  pure function converts the hourly demand curve into the exact
  `Record<day, Record<shiftKey, headcount>>` shape the generator already
  consumes today, using only catalogue patterns (greedy interval covering).
  Everything downstream — slot building, `pool()`, `reject()`, `score()`,
  the fill loop — is **unchanged**. This was chosen over a joint
  pattern+person solver because the latter could occasionally produce
  cleverer substitutions (an equally-valid pattern nobody happened to be
  free for the "optimal" one), which is exactly the kind of unpredictable
  cleverness this project's stated preference (predictable output over
  optimal packing) rules out. An honest unfilled gap beats a solver getting
  creative.
- **Unfilled-hours reporting**: no new data structure. `UnfilledEntry`
  already carries `shiftKey`; the banner displays that shift's time range
  (already-existing `shiftLabel()` helper) instead of its name. A one-line
  UI change, not a new pipeline.
- **Old demand data resets**, not migrated. The old `rota_demand` table
  (shift-key headcount) is dropped and replaced; existing headcount numbers
  aren't automatically translated into the new hourly table. It's a handful
  of numbers, quick to re-enter through the new Cover tab; the wraparound
  math to auto-translate correctly isn't worth the risk for something this
  low-stakes and this easy to redo by hand.
- **Existing hard rules are untouched**: 11h rest, max days, hours caps,
  night eligibility (`eligible_shifts`), scheduling modes, fixed patterns
  all continue to work exactly as today — none of them are shift-key-shaped
  in a way this change disturbs.

## Data model

### Shift definitions — unchanged schema, new API + UI

No migration. `rota_shift_definitions` already supports everything an
editable, extensible pattern catalogue needs.

### `rota_assignments` — custom time kind

Migration adds to the existing table:

```sql
ALTER TABLE rota_assignments ADD COLUMN custom_start time;
ALTER TABLE rota_assignments ADD COLUMN custom_end time;

ALTER TABLE rota_assignments DROP CONSTRAINT rota_assignments_kind_check;
ALTER TABLE rota_assignments ADD CONSTRAINT rota_assignments_kind_check
    CHECK (kind IN ('shift', 'code', 'custom'));

-- replace the existing value-shape check to also allow 'custom'
ALTER TABLE rota_assignments DROP CONSTRAINT IF EXISTS rota_assignments_check;
ALTER TABLE rota_assignments ADD CONSTRAINT rota_assignments_check
    CHECK (
      (kind = 'shift'  AND shift_key IS NOT NULL) OR
      (kind = 'code'   AND code IS NOT NULL) OR
      (kind = 'custom' AND custom_start IS NOT NULL AND custom_end IS NOT NULL)
    );
```

(Exact constraint names will be confirmed against the live schema — Postgres
auto-names unnamed CHECK constraints, and the implementation plan will look
these up rather than guess.)

### Demand — new tables replacing the old one

```sql
DROP TABLE rota_demand;

CREATE TABLE rota_demand (
    tenant_id  uuid     NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    week_hour  smallint NOT NULL CHECK (week_hour BETWEEN 0 AND 167),
    headcount  smallint NOT NULL DEFAULT 0,
    PRIMARY KEY (tenant_id, week_hour)
);

CREATE TABLE rota_sleepover_demand (
    tenant_id   uuid     NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    day_of_week smallint NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
    headcount   smallint NOT NULL DEFAULT 0,
    PRIMARY KEY (tenant_id, day_of_week)
);

-- RLS: tenant_isolation policy on both, same pattern as every other rota table.
```

`week_hour = day * 24 + hour`, hour meaning the interval `[hour:00, hour+1:00)`.

## Types (`lib/rota/types.ts`)

```ts
export type AssignmentValue =
  | { kind: "shift"; shiftKey: string; sleepover: boolean; locked: boolean }
  | { kind: "code"; code: string; locked: boolean }
  | { kind: "custom"; start: string; end: string; sleepover: boolean; locked: boolean };

// key: week_hour (0–167) -> required headcount
export type HourlyDemandMap = Record<number, number>;

export interface RotaConfig {
  // ...unchanged fields...
  demand: HourlyDemandMap;       // replaces DemandMap
  sleeperDemand: Record<number, number>; // day -> headcount
}
```

`DemandMap` (the derived `Record<day, Record<shiftKey, number>>` shape) stays
as a type — it's still what `generateRota` consumes — but it's no longer
what's stored or edited directly; it's the *output* of `deriveShiftDemand`.

## Generator

### New file: `lib/rota/demand.ts`

```ts
export function deriveShiftDemand(hourlyDemand: HourlyDemandMap, shifts: ShiftDef[]): DemandMap
```

Greedy interval covering over the 168-hour week:

1. Compute remaining deficit per week-hour from `hourlyDemand` (starts equal
   to the required headcount).
2. While any hour has deficit > 0: take the leftmost such hour. Among shift
   patterns that cover it, pick the one covering the longest run of
   currently-deficient hours starting from it; ties broken by `sort_order`
   (ascending — gives Sumy an explicit lever by the order she creates
   patterns in).
3. Increment that pattern's headcount for its day in the output `DemandMap`;
   decrement the deficit for every hour it covers (floored at 0 — overlap
   between patterns can mean some hours end up over-covered, which is an
   accepted, explainable consequence of a simple greedy pass, not a bug).
4. If a deficient hour has no covering pattern at all, that's a config gap
   (no defined shift touches that hour) — surfaced as its own top-level
   warning, distinct from a staffing shortfall.
5. Repeat until no hour has positive deficit.

This function is pure and independently testable — the only new piece of
solver-adjacent logic in this change. Everything in
`lib/rota/generator.ts` — `reject()`, `score()`, the slot list, `pool()`,
the fill loop, sleepover assignment — is unchanged. `generateRota`'s
`demand: DemandMap` parameter is now populated by calling
`deriveShiftDemand()` first, in the build route, rather than loaded
directly from a shift-keyed table.

### Unfilled reporting

No change to `UnfilledEntry`'s shape. The Rota tab's banner
(`app/rota/page.tsx`, `RotaTab`) changes its display line from `u.shiftName`
to the shift's time range: `shiftLabel(shiftBy[u.shiftKey])` (already an
existing helper), satisfying "say which hours are short" with a one-line
UI change.

## API

- New `app/api/rota/shifts/route.ts` (POST — add a shift definition;
  `sort_order` computed server-side as `max(existing) + 1`, not
  client-supplied) and `app/api/rota/shifts/[id]/route.ts` (PATCH — edit
  name/start/end/is_active).
- `app/api/rota/demand/route.ts`: replaced — `PUT` now takes
  `{ weekHour, headcount }` (single-hour) or `{ weekHourStart, weekHourEnd, headcount }` (range fill, writing every covered hour in one transaction) instead of `{ day, shiftKey, headcount }`.
- New `app/api/rota/sleepover-demand/route.ts`: `PUT { day, headcount }`.
- `app/api/rota/config/route.ts`: `demand` becomes `HourlyDemandMap`, gains
  `sleeperDemand`, gains `shifts` reflecting the now-editable catalogue
  (already returns shifts today — no shape change there, just now backed by
  a mutable table instead of static seed data).
- `weeks/[weekStart]/build/route.ts`: loads the hourly demand + sleepover
  demand, calls `deriveShiftDemand()` before calling `generateRota()`.
- `weeks/[weekStart]/route.ts` (cell PATCH): accepts the new `"custom"`
  kind shape when saving a cell.

## UI (`app/rota/page.tsx`)

- **Cover tab**: reworked to one row per day (7 rows), 24 small hour-cells
  across each (flipped from today's rows=shift/columns=day layout — a
  24-column horizontal ribbon per day reads better as a timeline than 24
  rows would). Each cell keeps a direct +/− stepper (reusing the existing
  `Step` component). A small per-day "fill a range" form (from-hour,
  to-hour, headcount, Apply) — explicit number inputs, not click-drag
  painting, to avoid new mouse-tracking interaction code for a marginal UX
  gain. A per-day "Copy to whole week" button, same convention as today's
  bottom-row copy buttons. Sleepover keeps its own small 7-cell row below,
  visually separate from the hourly grid.
- **Shift-definitions editor**: new "Shifts" button next to "Staff" on the
  Rota tab toolbar, opening a panel shaped like the Staff panel (add row +
  list with inline edit + deactivate toggle). No manual `sort_order` field —
  new shifts append at the end. Deactivating a shift currently referenced by
  any staff member's fixed pattern shows a confirmation listing who's
  affected, rather than blocking outright.
- **Cell editor**: gains a "custom time" section alongside the existing
  preset buttons — two time inputs (start/end) plus the existing sleepover
  toggle, saving as `{ kind: "custom", start, end, sleepover }`.

## Testing

- `lib/rota/demand.ts` unit tests: a demand curve exactly matching one
  catalogue pattern derives headcount 1 for that pattern and nothing else;
  a curve needing two overlapping patterns to fully cover derives both with
  correct headcounts; an hour with no covering pattern at all produces the
  distinct "config gap" warning rather than being silently dropped or
  mis-reported as a staffing shortfall; tie-breaking by `sort_order` is
  deterministic across repeated runs with the same input.
- Manual, in the browser: add a new shift pattern (e.g. 13-21) via the new
  editor, set hourly cover requiring it, build, confirm it's used;
  hand-edit a cell to a custom time not in the catalogue, confirm it saves,
  displays, and counts toward hours/totals; deactivate a shift used by a
  fixed pattern, confirm the warning names the affected staff member.

## Out of scope

- No automatic migration of the old shift-keyed demand numbers — reset and
  re-enter (see Decisions).
- No drag-to-paint range selection on the hourly cover grid — explicit
  from/to/headcount inputs only.
- No manual reordering of shift definitions after creation (`sort_order` is
  append-only from the UI).
