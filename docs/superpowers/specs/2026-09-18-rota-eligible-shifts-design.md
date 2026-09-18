# Rota: per-staff eligible shifts (night-shift hard rule)

Status: approved design, awaiting implementation plan.

## Context

Waking nights (the 21:00–07:00 shift) are currently governed by soft scoring
nudges in `lib/rota/generator.ts`'s `score()` function: a bonus toward `WCO`
staff, a penalty against `Manager`/`Deputy`. Nothing actually stops any other
`generated`-mode staff member from being assigned a night shift — it's just
scored worse for some roles and untouched for everyone else. At Linkfield,
only four people may ever work nights (Esther, Ola, Ayo, Victoria), and two
of them (Esther, Ola) may *only* work nights, never a day shift. Neither
constraint exists today.

This also explains why Friday/Saturday night slots have been going unfilled:
`pool()` (the function that sorts slots by scarcity before filling them)
counts any non-rejected `generated` staff member as a viable night candidate,
since `reject()` has no night-specific hard check. That makes night shifts
look abundant, so they sort *late* in the fill order — by the time the
solver reaches Friday/Saturday nights, the few people who'd actually fit may
already be used elsewhere on shifts they were only nominally, not actually,
eligible for. A real eligibility list fixes the scarcity count, which fixes
the fill order.

## Decisions

- Modelled generally as **per-staff eligible shifts** (`eligible_shifts`,
  which shifts a person may ever be assigned), not hardcoded names or roles.
  The four named people are a one-time data backfill, not a rule baked into
  the generator.
- `eligible_shifts` is always a concrete, materialized array of shift keys —
  not a "null means unrestricted" sentinel. Unrestricted would wrongly
  include night for everyone; the actual default (everyone except the four
  named people) is "every active shift except night," which needs the
  tenant's real shift keys resolved at write time, not encoded as `null`.
  Same pattern as `rota_availability.shift_keys` — an explicit list, not a
  computed-on-read default.
- Replaces the two night-specific soft-scoring lines entirely — one
  mechanism (a hard eligibility check) instead of two overlapping ones (soft
  scoring + implicit unfilled reporting).
- Editable per staff member in the Staff panel, same place role and
  scheduling mode already live.
- Applies only to the solver's normal candidate selection (`reject()` /
  `score()` in the main slot-filling loop). Fixed-pattern staff's laid-down
  pattern and manual staff's hand-entered cells are Sumy's direct input and
  aren't constrained by this — matches how those modes already bypass the
  solver entirely.

## Data model

`db/migrations/0004_rota_eligible_shifts.sql`:

```sql
ALTER TABLE rota_staff ADD COLUMN eligible_shifts jsonb NOT NULL DEFAULT '[]'::jsonb;

-- One-time backfill, keyed to Linkfield's real staff: Esther and Ola are
-- night-only; Ayo and Victoria work every shift including night; everyone
-- else gets every active shift except night.
UPDATE rota_staff s
SET eligible_shifts = (
  SELECT COALESCE(jsonb_agg(d.key), '[]'::jsonb)
  FROM rota_shift_definitions d
  WHERE d.tenant_id = s.tenant_id AND d.is_active
    AND CASE
      WHEN s.name IN ('Esther', 'Ola') THEN d.key = 'night'
      WHEN s.name IN ('Ayo', 'Victoria') THEN true
      ELSE d.key <> 'night'
    END
);
```

This is a self-contained data migration — unlike the `dom` shift definition
in the previous feature, it needs no separate manual SQL step, because the
`UPDATE` is keyed directly to real names already present in the live
`rota_staff` table and runs as part of the migration itself.

`db/schema/rota.ts`: `rotaStaff` gains `eligibleShifts: jsonb("eligible_shifts").notNull().default([])`.

## Types (`lib/rota/types.ts`)

`StaffMember` gains `eligibleShifts: string[]`.

## Generator (`lib/rota/generator.ts`)

- `reject()`: immediately after the existing "already on that day" check
  (`isLocked(...) || st.byDay[day] !== undefined`), add:
  ```ts
  if (!s.eligibleShifts.includes(sh.key)) return "not eligible for this shift";
  ```
  A hard rule — flows into `unfilled[].reasons` through the same mechanism
  every other rejection reason already uses. No separate reporting change
  needed.
- `score()`: delete both night-specific lines —
  `if (sh.key === "night" && s.role === "WCO") sc -= 8;` and
  `if (sh.key === "night" && (s.role === "Manager" || s.role === "Deputy")) sc += 14;`.
  The hard rule in `reject()` now does this job; keeping the soft nudges
  alongside it would be exactly the two-mechanisms-for-one-job problem this
  change is meant to remove.
- No change to `pool()`, the candidate-selection loop, or the sleepover
  logic — they all call `reject()`, so the new hard check propagates through
  automatically, including into the scarcity sort that currently
  under-prioritises night slots.

## API

- `POST /api/rota/staff` (add new staff): after inserting the row, query
  `rota_shift_definitions` for active shifts and set `eligibleShifts` to
  every key except `"night"` — the same default the migration backfills for
  "everyone else," computed live so it stays correct if shift definitions
  change.
- `PATCH /api/rota/staff/[id]`: accept `eligibleShifts` as an array of
  strings and pass it straight through — no cross-reference validation
  against known shift keys, matching how `rota_availability.shift_keys` is
  handled today.
- `GET /api/rota/config` and the build route (`weeks/[weekStart]/build`):
  select `eligible_shifts` and include it in the mapped `StaffMember`
  objects, same as every other staff column.

## UI (Staff panel, `app/rota/page.tsx`)

A row of toggle buttons per staff member, one per `config.shifts` entry
(Early / Mid / Back / Night / Dom), visually matching the existing
shift-picker toggle buttons already used on the Availability tab's "only
certain shifts" mode. Toggling one adds/removes that key from
`eligibleShifts` via the existing `updateStaff` call.

## Seed (`db/seed.ts`)

Same name-keyed default logic as the migration (Esther/Ola → night only;
Ayo/Victoria → every shift; everyone else → every shift except night), so a
fresh environment matches the live one exactly.

## Testing

- Generator-level: a staff member without `"night"` in `eligibleShifts` is
  never selected for a night slot regardless of score, and produces a
  `"not eligible for this shift"` unfilled reason when they're the only
  reason a night slot can't be filled; a night-only staff member (`["night"]`)
  is rejected from every non-night shift; the removed soft-scoring lines no
  longer appear anywhere in `score()`.
- Manual, in the browser: toggle Night off for someone currently eligible,
  rebuild, confirm they're never picked for a night shift; build a week with
  Esther and Ola both on leave and confirm Ayo/Victoria now fill Friday and
  Saturday nights instead of the slots going unfilled.

## Out of scope

- No UI change to how sleepovers are assigned — unaffected by this change.
- No re-validation or migration of existing built/locked weeks — this only
  changes what a *future* build does.
