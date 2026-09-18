# Rota Eligible Shifts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-staff `eligible_shifts` list to the rota module, replacing the soft night-shift scoring nudges (WCO bonus, Manager/Deputy penalty) with a hard eligibility rule, and backfill it for Linkfield's real staff (Esther/Ola night-only, Ayo/Victoria all shifts, everyone else all shifts except night).

**Architecture:** One new `jsonb` column on `rota_staff`, threaded through the same config-load / build / staff-edit paths every other staff field already follows. The generator gets one new hard check in `reject()` and loses two lines from `score()` — no other change to the solver's structure.

**Tech Stack:** Next.js route handlers, Drizzle ORM, Postgres, React. Tests use Node's built-in test runner (`node:test`) via `tsx`, extending the existing `lib/rota/generator.test.ts`.

**Spec:** `docs/superpowers/specs/2026-09-18-rota-eligible-shifts-design.md`

## Global Constraints

- Every new/changed query goes through `withTenant` (`lib/db/client.ts`).
- The new column follows the same tenant-owned pattern as every other `rota_staff` column — no separate table, no new RLS policy needed (it's a column on an already-RLS'd table).
- UI copy: plain verbs, sentence case, the vocabulary the home actually uses (`CLAUDE.md`).
- No new npm dependencies.

## Numbering note

The spec assumed this would be migration `0004`. That's still correct — `db/migrations/` currently stops at `0003_rota_scheduling_mode.sql`, and the flexible-shifts/hourly-demand work that was spec'd after this one hasn't been built yet, so `0004` is free.

---

## Task 1: Migration — `rota_staff.eligible_shifts`

**Files:**
- Create: `db/migrations/0004_rota_eligible_shifts.sql`

**Interfaces:**
- Produces: column `rota_staff.eligible_shifts jsonb NOT NULL DEFAULT '[]'::jsonb`, backfilled for every existing staff row.

- [ ] **Step 1: Write the migration file**

```sql
-- ============================================================
-- Care Records — Migration 0004: Rota eligible shifts
-- Postgres 15+. Requires 0003_rota_scheduling_mode.sql.
--
-- Replaces the generator's soft night-shift scoring nudges (WCO
-- bonus, Manager/Deputy penalty) with a hard per-staff eligible-
-- shifts list. See CLAUDE.md and docs/superpowers/specs/2026-09-18-
-- rota-eligible-shifts-design.md.
-- ============================================================

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

- [ ] **Step 2: Commit**

```bash
git add db/migrations/0004_rota_eligible_shifts.sql
git commit -m "Add rota_staff.eligible_shifts with a Linkfield-keyed backfill"
```

(Applying it to the live database happens interactively later, same as previous migrations — no `DATABASE_URL` in this checkout by default.)

---

## Task 2: Drizzle schema

**Files:**
- Modify: `db/schema/rota.ts:36-51` (the `rotaStaff` table)

**Interfaces:**
- Produces: `rotaStaff.eligibleShifts: jsonb("eligible_shifts")`.

- [ ] **Step 1: Add the column**

In `db/schema/rota.ts`, inside the `rotaStaff` table definition, add directly after `schedulingMode`:

```ts
    schedulingMode: text("scheduling_mode").notNull().default("generated"),
    eligibleShifts: jsonb("eligible_shifts").notNull().default([]),
```

`jsonb` is already imported in this file (used by `rotaAvailability.shiftKeys` and `rotaFixedPatterns`'s sibling tables) — no new import needed.

- [ ] **Step 2: Type-check**

Run: `npx tsc`
Expected: no new errors in `db/schema/rota.ts` itself. Errors will appear elsewhere (generator, API routes, seed, UI) referencing `StaffMember` before those are updated — expected at this point.

- [ ] **Step 3: Commit**

```bash
git add db/schema/rota.ts
git commit -m "Add eligibleShifts to the Drizzle schema"
```

---

## Task 3: Types

**Files:**
- Modify: `lib/rota/types.ts`

**Interfaces:**
- Produces: `StaffMember` gains `eligibleShifts: string[]`.

- [ ] **Step 1: Edit `StaffMember`**

In `lib/rota/types.ts`, change:

```ts
export interface StaffMember {
  id: string;
  name: string;
  role: string;
  contractHours: number;
  maxDays: number;
  schedulingMode: SchedulingMode;
  isActive: boolean;
}
```

to:

```ts
export interface StaffMember {
  id: string;
  name: string;
  role: string;
  contractHours: number;
  maxDays: number;
  schedulingMode: SchedulingMode;
  eligibleShifts: string[];
  isActive: boolean;
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc`
Expected: errors now appear everywhere a `StaffMember` object is constructed without `eligibleShifts` — `lib/rota/generator.test.ts`'s `staffMember()` helper, the config route, the build route, and `db/seed.ts` if it constructs one directly (it doesn't — seed only inserts rows, doesn't build `StaffMember` objects, so no error expected there).

- [ ] **Step 3: Commit**

```bash
git add lib/rota/types.ts
git commit -m "Add eligibleShifts to StaffMember"
```

---

## Task 4: Generator — hard rule, remove soft nudges, tests

**Files:**
- Modify: `lib/rota/generator.ts`
- Modify: `lib/rota/generator.test.ts`

**Interfaces:**
- Consumes: `StaffMember.eligibleShifts` (Task 3).
- Produces: no signature change to `generateRota` — `eligibleShifts` arrives as part of each `StaffMember` already in `GenerateRotaInput.staff`, nothing new to thread through separately.

- [ ] **Step 1: Update the test helper's default and write the failing tests**

In `lib/rota/generator.test.ts`, add `eligibleShifts: ["early"]` to the `staffMember()` helper's defaults (keeps all 4 existing tests passing unchanged, since none of them exercise eligibility and all of them use the `EARLY` shift):

```ts
function staffMember(overrides: Partial<StaffMember> & { id: string }): StaffMember {
  return {
    name: overrides.id,
    role: "CO",
    contractHours: 30,
    maxDays: 5,
    isActive: true,
    schedulingMode: "generated",
    eligibleShifts: ["early"],
    ...overrides,
  };
}
```

Add a `NIGHT` shift constant near the existing `EARLY` one:

```ts
const NIGHT: ShiftDef = { key: "night", name: "Night", start: "21:00", end: "07:00" };
```

Add two new tests at the end of the file:

```ts
test("a staff member without night in eligibleShifts is never assigned a night shift", () => {
  const result = generateRota({
    staff: [staffMember({ id: "a", eligibleShifts: ["early"] })],
    shifts: [NIGHT],
    availability: {},
    demand: { 0: { night: 1 } },
    locked: {},
    fixedPatterns: {},
    seed: 1,
  });
  assert.equal(result.assignments["a|0"].kind, "code");
  assert.equal(result.unfilled.length, 1);
  assert.equal(result.unfilled[0].reasons["not eligible for this shift"], 1);
});

test("a night-only staff member is rejected from every non-night shift", () => {
  const result = generateRota({
    staff: [staffMember({ id: "n", eligibleShifts: ["night"] })],
    shifts: [EARLY],
    availability: {},
    demand: { 0: { early: 1 } },
    locked: {},
    fixedPatterns: {},
    seed: 1,
  });
  assert.equal(result.assignments["n|0"].kind, "code");
  assert.equal(result.unfilled.length, 1);
  assert.equal(result.unfilled[0].reasons["not eligible for this shift"], 1);
});
```

- [ ] **Step 2: Run the tests and confirm the new two fail**

Run: `npm test`
Expected: the 4 existing tests still pass (helper default keeps them working); the 2 new tests FAIL — today's generator has no eligibility check, so both staff members get assigned the shift instead of being rejected.

- [ ] **Step 3: Implement**

In `lib/rota/generator.ts`, in `reject()`, add the eligibility check immediately after the "already on that day" line:

```ts
  function reject(s: StaffMember, day: number, sh: ShiftDef): string | null {
    const st = state[s.id];
    if (isLocked(s.id, day) || st.byDay[day] !== undefined) return "already on that day";
    if (!s.eligibleShifts.includes(sh.key)) return "not eligible for this shift";
    const av = availability[`${s.id}|${day}`] || { mode: "any" as const, shifts: [] };
```

In `score()`, delete these two lines entirely:

```ts
    if (sh.key === "night" && s.role === "WCO") sc -= 8;
    if (sh.key === "night" && (s.role === "Manager" || s.role === "Deputy")) sc += 14;
```

- [ ] **Step 4: Run the tests and confirm all pass**

Run: `npm test`
Expected: 6 passing tests (the original 4 plus the 2 new ones), 0 failing.

- [ ] **Step 5: Commit**

```bash
git add lib/rota/generator.ts lib/rota/generator.test.ts
git commit -m "Replace night soft-scoring with a hard eligible-shifts rule"
```

---

## Task 5: Staff API routes

**Files:**
- Modify: `app/api/rota/staff/route.ts`
- Modify: `app/api/rota/staff/[id]/route.ts`

**Interfaces:**
- Consumes: `rotaShiftDefinitions`, `rotaStaff.eligibleShifts` (Task 2).
- Produces: `POST /api/rota/staff` computes a default `eligibleShifts` (every active shift key except `"night"`) at creation and returns it; `PATCH /api/rota/staff/[id]` accepts `eligibleShifts: string[]` and returns it.

- [ ] **Step 1: Update `app/api/rota/staff/route.ts`**

Add the import:

```ts
import { rotaStaff, rotaAvailability, rotaShiftDefinitions } from "@/db/schema/rota";
```

(replacing the existing `import { rotaStaff, rotaAvailability } from "@/db/schema/rota";` line)

Inside the `withTenant` callback, before inserting the staff row, compute the default:

```ts
  const staff = await withTenant(tenant.id, async (tx) => {
    const activeShifts = await tx.select().from(rotaShiftDefinitions).where(eq(rotaShiftDefinitions.isActive, true));
    const defaultEligible = activeShifts.map((s) => s.key).filter((k) => k !== "night");

    const [staff] = await tx
      .insert(rotaStaff)
      .values({ tenantId: tenant.id, name, role, contractHours: "30", maxDays: 5, eligibleShifts: defaultEligible })
      .returning();
```

Add the `eq` import (needed for the new query): change `import { withTenant } from "@/lib/db/client";` block's neighbor — add `import { eq } from "drizzle-orm";` near the top if not already present (it isn't in this file today).

Add `eligibleShifts: staff.eligibleShifts,` to the returned JSON object, alongside `schedulingMode`.

- [ ] **Step 2: Update `app/api/rota/staff/[id]/route.ts`**

Add a patch handler for the array field:

```ts
  if (Array.isArray(body.eligibleShifts) && body.eligibleShifts.every((k: unknown) => typeof k === "string")) {
    patch.eligibleShifts = body.eligibleShifts;
  }
```

placed alongside the existing `schedulingMode` patch block.

Add `eligibleShifts: staff.eligibleShifts,` to the returned JSON object.

- [ ] **Step 3: Type-check**

Run: `npx tsc`
Expected: no errors in either file.

- [ ] **Step 4: Commit**

```bash
git add app/api/rota/staff/route.ts "app/api/rota/staff/[id]/route.ts"
git commit -m "Support eligibleShifts on the staff API, defaulted on creation"
```

---

## Task 6: Config API route

**Files:**
- Modify: `app/api/rota/config/route.ts`

**Interfaces:**
- Produces: `GET /api/rota/config`'s `staff[]` entries include `eligibleShifts`.

- [ ] **Step 1: Edit the route**

In the `staff.map(...)` block, add `eligibleShifts: (s.eligibleShifts as string[]) ?? [],` alongside `schedulingMode`.

- [ ] **Step 2: Type-check**

Run: `npx tsc`
Expected: no errors in this file.

- [ ] **Step 3: Commit**

```bash
git add app/api/rota/config/route.ts
git commit -m "Return eligibleShifts from the config API"
```

---

## Task 7: Build route

**Files:**
- Modify: `app/api/rota/weeks/[weekStart]/build/route.ts`

**Interfaces:**
- Produces: the `staff` array passed into `generateRota` includes `eligibleShifts`.

- [ ] **Step 1: Edit the route**

In the `staff` mapping (the `staffRows.map(...)` block), add `eligibleShifts: (s.eligibleShifts as string[]) ?? [],` alongside `schedulingMode`.

- [ ] **Step 2: Type-check**

Run: `npx tsc`
Expected: no errors in this file.

- [ ] **Step 3: Commit**

```bash
git add "app/api/rota/weeks/[weekStart]/build/route.ts"
git commit -m "Load eligibleShifts into the rota build"
```

---

## Task 8: Seed data

**Files:**
- Modify: `db/seed.ts`

**Interfaces:**
- Produces: a fresh environment's staff rows get the same name-keyed `eligibleShifts` the migration backfills for a live one.

- [ ] **Step 1: Edit `db/seed.ts`**

Add a helper function near `availabilityFor`:

```ts
function eligibleShiftsFor(name: string): string[] {
  const shiftKeys = SHIFTS.map((s) => s.key);
  if (name === "Esther" || name === "Ola") return ["night"];
  if (name === "Ayo" || name === "Victoria") return shiftKeys;
  return shiftKeys.filter((k) => k !== "night");
}
```

In the staff-insert `.values({...})` call, add `eligibleShifts: eligibleShiftsFor(name),`.

- [ ] **Step 2: Type-check**

Run: `npx tsc`
Expected: no errors in `db/seed.ts`.

- [ ] **Step 3: Commit**

```bash
git add db/seed.ts
git commit -m "Seed eligibleShifts matching the migration's Linkfield backfill"
```

---

## Task 9: Staff panel UI

**Files:**
- Modify: `app/rota/page.tsx` (the `StaffPanel` function)

**Interfaces:**
- Consumes: `config.shifts` (already available), `StaffMember.eligibleShifts` (Task 3), the existing `updateStaff(id, patch)` handler (unchanged signature).
- Produces: a row of toggle buttons per staff member, one per shift definition, editing `eligibleShifts`.

- [ ] **Step 1: Add the toggle row**

In `StaffPanel`, inside the `config.staff.map((s) => ...)` block, directly after the closing `</div>` of the row containing Contract hours / Max days / the scheduling-mode control (the `<div style={{ display: "flex", gap: 14, ... }}>...</div>` block), add a new row:

```tsx
              <div style={{ display: "flex", gap: 6, marginTop: 8, alignItems: "center", flexWrap: "wrap" }}>
                <span style={{ fontSize: 9.5, letterSpacing: ".12em", color: T.muted, textTransform: "uppercase" }}>Can work</span>
                {config.shifts.map((sh) => {
                  const on = s.eligibleShifts.includes(sh.key);
                  return (
                    <button
                      key={sh.key}
                      onClick={() =>
                        updateStaff(s.id, {
                          eligibleShifts: on ? s.eligibleShifts.filter((k) => k !== sh.key) : [...s.eligibleShifts, sh.key],
                        })
                      }
                      style={{
                        fontFamily: MONO, fontSize: 10, padding: "4px 7px", borderRadius: 5, cursor: "pointer",
                        border: `1px solid ${on ? T.night : T.ruleSoft}`,
                        background: on ? T.night : T.surface,
                        color: on ? "#fff" : T.muted,
                      }}
                    >
                      {shortTime(sh.start)}
                    </button>
                  );
                })}
              </div>
```

This reuses the exact visual style of the existing shift-toggle buttons in `AvailabilityTab`'s "only certain shifts" mode (`T.night` / `shortTime`), both already imported/defined in this file.

- [ ] **Step 2: Type-check**

Run: `npx tsc`
Expected: no errors in `app/rota/page.tsx`.

- [ ] **Step 3: Commit**

```bash
git add app/rota/page.tsx
git commit -m "Make eligible shifts toggleable per staff member in the Staff panel"
```

---

## Task 10: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Full type-check**

Run: `npx tsc`
Expected: zero errors, whole repo (aside from the pre-existing, unrelated `app/layout.tsx` `LayoutProps` message that only shows up under bare `tsc` and resolves under a real `next build` — confirmed harmless during the scheduling-mode work).

- [ ] **Step 2: Full test run**

Run: `npm test`
Expected: 6 passing tests, 0 failures.

- [ ] **Step 3: Production build**

Run: `npm run build`
Expected: builds successfully.

- [ ] **Step 4: Confirm the soft nudges are actually gone**

Run: `grep -n "WCO\|Manager.*Deputy" lib/rota/generator.ts`
Expected: no match inside `score()` — if anything shows up, it should only be the unrelated `ROLES` reference elsewhere, not a scoring line. (There is no such reference in this file today, so expect zero output.)

- [ ] **Step 5: Commit (only if Step 3 or 4 required a fix)**

```bash
git add -A
git commit -m "Fix eligible-shifts verification findings"
```

---

## Applying this locally / on deploy

Same pattern as the scheduling-mode migration: pushing this branch triggers Vercel's `vercel-build`, which runs `db:migrate` automatically — the migration's `UPDATE` is self-contained (keyed to real staff names already in the live `rota_staff` table), so no manual SQL step is needed this time, unlike the `dom` shift definition before it.

To verify in the browser afterward: open the Staff panel, confirm Esther and Ola each show only the `21` (night) toggle lit, Ayo and Victoria show every toggle lit, and everyone else shows every toggle except `21` lit. Build a week with Esther and Ola both on leave and confirm Ayo or Victoria fill Friday/Saturday night instead of the slots going unfilled.
