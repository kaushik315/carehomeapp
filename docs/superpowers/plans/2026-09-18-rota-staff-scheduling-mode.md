# Rota Staff Scheduling Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-staff `scheduling_mode` (`generated` / `fixed` / `manual`) to the rota module, folding in the existing `officeHours` special-case, so Gail's fixed Dom pattern and Brian K's hand-filled Driver slot are both expressible without special-casing the generator.

**Architecture:** One new DB table (`rota_fixed_patterns`) plus one new column on `rota_staff`, threaded through the existing config-load / build / cell-edit request flow exactly like `rota_availability` and `rota_assignments` already are. The generator gets a pre-assignment step (fixed patterns behave like `locked` cells: protected, counted toward cover, never touched) and an exclusion change (fixed/manual staff are never solver candidates). No new architectural pattern — this reuses the tenant/RLS/`withTenant` shape already established in `db/migrations/0002_rota.sql`.

**Tech Stack:** Next.js route handlers, Drizzle ORM, Postgres (RLS), React (no framework state library). Tests use Node's built-in test runner (`node:test`) via `tsx` — no new dependency, matches this repo's existing "boring solution" bias and its zero test files today.

**Spec:** `docs/superpowers/specs/2026-09-18-rota-staff-scheduling-mode-design.md`

## Global Constraints

- Every new/changed query goes through `withTenant` (`lib/db/client.ts`) — never query `db` directly for tenant-owned tables.
- Every new tenant-owned table gets `tenant_id`, RLS enabled, and the `tenant_isolation` policy, following `db/migrations/0002_rota.sql`'s exact pattern.
- Staff are never deleted, only deactivated — unaffected by this plan, but don't introduce a delete path.
- UI copy: plain verbs, sentence case, the vocabulary the home actually uses (`CLAUDE.md`).
- No new npm dependencies. `tsx` (already a devDependency) runs both the app and the new tests.

---

## Task 1: Migration — `rota_staff.scheduling_mode` + `rota_fixed_patterns`

**Files:**
- Create: `db/migrations/0003_rota_scheduling_mode.sql`
- Modify: `DEPLOYMENT.md` (document the one manual step this migration needs)

**Interfaces:**
- Produces: column `rota_staff.scheduling_mode text NOT NULL DEFAULT 'generated' CHECK (... IN ('generated','fixed','manual'))`; table `rota_fixed_patterns(tenant_id, staff_id, day_of_week, kind, shift_key, code, updated_at)` with `PRIMARY KEY (staff_id, day_of_week)` and RLS `tenant_isolation`. `rota_staff.office_hours` is dropped.

- [ ] **Step 1: Write the migration file**

```sql
-- ============================================================
-- Care Records — Migration 0003: Rota staff scheduling mode
-- Postgres 15+. Requires 0002_rota.sql.
--
-- Folds the officeHours special-case into a general per-staff
-- scheduling mode:
--   generated (default) — the solver assigns them, as today.
--   fixed                — a weekly pattern, laid down on every
--                          build; a locked leave override wins;
--                          the solver never picks them.
--   manual               — always left blank for hand-entry; the
--                          solver never picks them.
-- See CLAUDE.md and docs/superpowers/specs/2026-09-18-rota-staff-
-- scheduling-mode-design.md.
-- ============================================================

ALTER TABLE rota_staff ADD COLUMN scheduling_mode text NOT NULL DEFAULT 'generated'
    CHECK (scheduling_mode IN ('generated', 'fixed', 'manual'));

-- Anyone currently on office_hours becomes 'fixed' — same idea, one
-- mechanism instead of two.
UPDATE rota_staff SET scheduling_mode = 'fixed' WHERE office_hours = true;

-- ------------------------------------------------------------
-- FIXED PATTERNS — one row per staff per day-of-week, same shape
-- as an assignment cell (kind + shift_key, or kind + code). Only
-- meaningful for staff with scheduling_mode = 'fixed'.
-- ------------------------------------------------------------
CREATE TABLE rota_fixed_patterns (
    tenant_id   uuid        NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    staff_id    uuid        NOT NULL REFERENCES rota_staff(id) ON DELETE CASCADE,
    day_of_week smallint    NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
    kind        text        NOT NULL CHECK (kind IN ('shift', 'code')),
    shift_key   text,
    code        text,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (staff_id, day_of_week),
    CHECK ((kind = 'shift' AND shift_key IS NOT NULL) OR (kind = 'code' AND code IS NOT NULL))
);

ALTER TABLE rota_fixed_patterns ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON rota_fixed_patterns
    USING (tenant_id = current_setting('app.tenant_id')::uuid);

-- Backfill: replicate the old hardcoded office-hours behaviour (IN
-- Mon-Fri, D/O weekends) as real pattern rows, so migrating anyone
-- who had office_hours = true changes nothing about what they see.
INSERT INTO rota_fixed_patterns (tenant_id, staff_id, day_of_week, kind, code)
SELECT tenant_id, id, d, 'code', CASE WHEN d < 5 THEN 'IN' ELSE 'D/O' END
FROM rota_staff, generate_series(0, 6) AS d
WHERE scheduling_mode = 'fixed';

ALTER TABLE rota_staff DROP COLUMN office_hours;
```

- [ ] **Step 2: Add the operational note to DEPLOYMENT.md**

Insert a new section right after "## What happens on deploy" (before "## On-prem"):

```markdown
## One-off manual steps

Most schema changes are fully handled by `db:migrate`. One migration isn't:

- **`0003_rota_scheduling_mode.sql`** adds a `dom` shift definition's worth
  of scheduling (09:00–13:00) that Gail's fixed pattern needs, but there's
  no admin UI for shift definitions yet. After this migration has run, run
  once against the database:

  ```sql
  INSERT INTO rota_shift_definitions (tenant_id, key, name, start_time, end_time, sort_order)
  SELECT id, 'dom', 'Dom', '09:00', '13:00', 4 FROM tenants WHERE slug = 'linkfield'
  ON CONFLICT (tenant_id, key) DO NOTHING;
  ```
```

- [ ] **Step 3: Verify against the live/dev database**

This step needs a reachable `DATABASE_URL` and is not run inside this repo checkout automatically — see "Applying this locally" at the end of this plan, which walks through running `npm run db:migrate`, confirming `apply 0003_rota_scheduling_mode.sql` then `done.` in the output, and running the `dom` shift insert above.

- [ ] **Step 4: Commit**

```bash
git add db/migrations/0003_rota_scheduling_mode.sql DEPLOYMENT.md
git commit -m "Add rota_staff.scheduling_mode and rota_fixed_patterns"
```

---

## Task 2: Drizzle schema

**Files:**
- Modify: `db/schema/rota.ts:36-51` (the `rotaStaff` table)
- Modify: `db/schema/rota.ts` (add `rotaFixedPatterns` after `rotaAvailability`)

**Interfaces:**
- Consumes: nothing new.
- Produces: `rotaStaff` with `schedulingMode: text("scheduling_mode")` replacing `officeHours`; `rotaFixedPatterns` Drizzle table with columns `tenantId, staffId, dayOfWeek, kind, shiftKey, code, updatedAt` and `unique().on(t.staffId, t.dayOfWeek)` (mirrors how `rotaAvailability` represents its composite primary key today — see `db/schema/rota.ts:53-64`).

- [ ] **Step 1: Update `rotaStaff`**

In `db/schema/rota.ts`, replace:

```ts
    officeHours: boolean("office_hours").notNull().default(false),
```

with:

```ts
    schedulingMode: text("scheduling_mode").notNull().default("generated"),
```

- [ ] **Step 2: Add `rotaFixedPatterns`**

Directly after the `rotaAvailability` table definition, add:

```ts
export const rotaFixedPatterns = pgTable(
  "rota_fixed_patterns",
  {
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    staffId: uuid("staff_id").notNull().references(() => rotaStaff.id),
    dayOfWeek: smallint("day_of_week").notNull(),
    kind: text("kind").notNull(), // shift | code
    shiftKey: text("shift_key"),
    code: text("code"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.staffId, t.dayOfWeek)],
);
```

`boolean` is no longer used in this file once `officeHours` is gone — check whether it's still imported for another column before removing the import (`rotaAssignments.sleepover`, `rotaAssignments.locked`, `rotaShiftDefinitions.isActive`, `rotaStaff.isActive` all use `boolean`, so the import stays; do not remove it).

- [ ] **Step 3: Type-check**

Run: `npx tsc`
Expected: fails elsewhere (every file still referencing `officeHours` or the old `GenerateRotaInput` shape hasn't been updated yet) — that's expected at this point in the plan. Confirm the *specific* errors are only about `officeHours`/`rotaStaff`/`generateRota` call sites in files this plan hasn't reached yet, not about `db/schema/rota.ts` itself.

- [ ] **Step 4: Commit**

```bash
git add db/schema/rota.ts
git commit -m "Add schedulingMode and rotaFixedPatterns to the Drizzle schema"
```

---

## Task 3: Shared types + roles

**Files:**
- Modify: `lib/rota/types.ts`
- Modify: `CLAUDE.md` (roles list)

**Interfaces:**
- Produces:
  - `export type SchedulingMode = "generated" | "fixed" | "manual";`
  - `export interface FixedPatternEntry { kind: "shift" | "code"; shiftKey: string | null; code: string | null; }`
  - `export type FixedPatternMap = Record<string, FixedPatternEntry>;` (key `${staffId}|${day}`)
  - `StaffMember` gains `schedulingMode: SchedulingMode`, loses `officeHours: boolean`.
  - `RotaConfig` gains `fixedPatterns: FixedPatternMap`.
  - `ROLES` gains `"Driver"`.

- [ ] **Step 1: Edit `lib/rota/types.ts`**

Replace:

```ts
export interface StaffMember {
  id: string;
  name: string;
  role: string;
  contractHours: number;
  maxDays: number;
  officeHours: boolean;
  isActive: boolean;
}
```

with:

```ts
export type SchedulingMode = "generated" | "fixed" | "manual";

export interface StaffMember {
  id: string;
  name: string;
  role: string;
  contractHours: number;
  maxDays: number;
  schedulingMode: SchedulingMode;
  isActive: boolean;
}

export interface FixedPatternEntry {
  kind: "shift" | "code";
  shiftKey: string | null;
  code: string | null;
}

// key: `${staffId}|${day}`
export type FixedPatternMap = Record<string, FixedPatternEntry>;
```

Then add `fixedPatterns: FixedPatternMap;` to `RotaConfig`:

```ts
export interface RotaConfig {
  tenantName: string;
  shifts: ShiftDef[];
  staff: StaffMember[];
  availability: AvailabilityMap;
  demand: DemandMap;
  fixedPatterns: FixedPatternMap;
}
```

Then update `ROLES`:

```ts
export const ROLES = ["Manager", "Deputy", "SCO", "CO", "BCO", "WCO", "Kitchen", "Dom", "Driver"];
```

- [ ] **Step 2: Update `CLAUDE.md`'s roles line**

In the "Domain notes" section, change:

```
- **Roles:** Manager, Deputy, SCO (Senior Care Officer), CO (Care Officer),
  BCO (Bank Care Officer), WCO (Waking Night Officer), Dom (Domestic), Kitchen.
```

to:

```
- **Roles:** Manager, Deputy, SCO (Senior Care Officer), CO (Care Officer),
  BCO (Bank Care Officer), WCO (Waking Night Officer), Dom (Domestic), Kitchen,
  Driver.
```

- [ ] **Step 3: Type-check**

Run: `npx tsc`
Expected: errors now concentrated in `lib/rota/generator.ts`, the API routes under `app/api/rota/`, `app/rota/page.tsx`, and `db/seed.ts` — all still referencing `officeHours` or the old `generateRota` input shape. `lib/rota/types.ts` itself should show no errors.

- [ ] **Step 4: Commit**

```bash
git add lib/rota/types.ts CLAUDE.md
git commit -m "Add SchedulingMode, FixedPatternMap, and the Driver role"
```

---

## Task 4: Generator logic + tests

**Files:**
- Modify: `lib/rota/generator.ts`
- Create: `lib/rota/generator.test.ts`
- Modify: `package.json` (add a `test` script)

**Interfaces:**
- Consumes: `SchedulingMode`, `FixedPatternEntry`, `FixedPatternMap` from `lib/rota/types.ts` (Task 3).
- Produces: `GenerateRotaInput` gains `fixedPatterns: FixedPatternMap`. `generateRota`'s exported signature and `GenerateRotaResult` shape are otherwise unchanged — later tasks (API routes) call it as `generateRota({ staff, shifts, availability, demand, locked, fixedPatterns, seed })`.

- [ ] **Step 1: Write the failing tests**

Create `lib/rota/generator.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateRota } from "./generator";
import type { ShiftDef, StaffMember } from "./types";

const EARLY: ShiftDef = { key: "early", name: "Early", start: "07:00", end: "15:00" };

function staffMember(overrides: Partial<StaffMember> & { id: string }): StaffMember {
  return {
    name: overrides.id,
    role: "CO",
    contractHours: 30,
    maxDays: 5,
    isActive: true,
    schedulingMode: "generated",
    ...overrides,
  };
}

test("a fixed-mode staff member's pattern is laid down even with no demand, and is not reassignable", () => {
  const result = generateRota({
    staff: [staffMember({ id: "f", schedulingMode: "fixed" })],
    shifts: [EARLY],
    availability: {},
    demand: {},
    locked: {},
    fixedPatterns: { "f|1": { kind: "shift", shiftKey: "early", code: null } },
    seed: 1,
  });
  assert.deepEqual(result.assignments["f|1"], { kind: "shift", shiftKey: "early", sleepover: false, locked: false });
});

test("a fixed shift reduces the need for that slot, same as a locked assignment", () => {
  const result = generateRota({
    staff: [
      staffMember({ id: "f", schedulingMode: "fixed" }),
      staffMember({ id: "a", schedulingMode: "generated" }),
    ],
    shifts: [EARLY],
    availability: {},
    demand: { 0: { early: 1 } },
    locked: {},
    fixedPatterns: { "f|0": { kind: "shift", shiftKey: "early", code: null } },
    seed: 1,
  });
  assert.equal(result.unfilled.length, 0);
  const a = result.assignments["a|0"];
  assert.equal(a.kind, "code");
  assert.equal(a.kind === "code" ? a.code : undefined, "D/O");
});

test("a manual-mode staff member receives no assignment from a build", () => {
  const result = generateRota({
    staff: [staffMember({ id: "m", schedulingMode: "manual" })],
    shifts: [EARLY],
    availability: {},
    demand: {},
    locked: {},
    fixedPatterns: {},
    seed: 1,
  });
  for (let day = 0; day < 7; day++) {
    assert.equal(result.assignments[`m|${day}`], undefined);
  }
});

test("a locked leave override wins over a fixed-mode staff member's pattern for that day", () => {
  const result = generateRota({
    staff: [staffMember({ id: "f", schedulingMode: "fixed" })],
    shifts: [EARLY],
    availability: {},
    demand: {},
    locked: { "f|2": { kind: "code", code: "AL", locked: true } },
    fixedPatterns: { "f|2": { kind: "shift", shiftKey: "early", code: null } },
    seed: 1,
  });
  assert.deepEqual(result.assignments["f|2"], { kind: "code", code: "AL", locked: true });
});
```

Add to `package.json`'s `"scripts"`:

```json
    "test": "tsx --test lib/rota/generator.test.ts",
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npm test`
Expected: FAIL — `generateRota` doesn't accept `fixedPatterns` yet (TypeScript error) and `StaffMember` fixtures use `schedulingMode`, which the current `generator.ts` doesn't read, so the "reduces the need" and "manual receives no assignment" cases would fail even if it type-checked. Confirm real failures, not a silently-passing run.

- [ ] **Step 3: Implement**

Replace the full body of `lib/rota/generator.ts` from the import line through the end of `generateRota` (i.e. everything except the trailing `mulberry32`/`toMin`/`shiftHours`/`absStart`/`absEnd` helpers, which are unchanged) with:

```ts
import type { AssignmentMap, AssignmentValue, AvailabilityMap, DemandMap, FixedPatternMap, ShiftDef, StaffMember, UnfilledEntry } from "@/lib/rota/types";
```

(update the existing import line at the top of the file to add `FixedPatternMap`)

```ts
export interface GenerateRotaInput {
  staff: StaffMember[];
  shifts: ShiftDef[];
  availability: AvailabilityMap;
  demand: DemandMap;
  locked: AssignmentMap; // cells to preserve as-is — leave overrides, manual locks
  fixedPatterns: FixedPatternMap; // scheduling_mode = 'fixed' staff's weekly pattern
  seed: number;
}

export interface GenerateRotaResult {
  assignments: AssignmentMap;
  unfilled: UnfilledEntry[];
}

export function generateRota({ staff, shifts, availability, demand, locked, fixedPatterns, seed }: GenerateRotaInput): GenerateRotaResult {
  const rnd = mulberry32(seed);
  const shiftBy = Object.fromEntries(shifts.map((s) => [s.key, s]));
  const unfilled: UnfilledEntry[] = [];

  // preAssigned = locked cells (leave overrides, manual locks) plus each
  // fixed-mode staff member's pattern for any day not already locked. Both
  // are protected from the solver and count toward cover the same way.
  const preAssigned: AssignmentMap = { ...locked };
  staff.forEach((s) => {
    if (s.schedulingMode !== "fixed") return;
    for (let day = 0; day < 7; day++) {
      const key = `${s.id}|${day}`;
      if (preAssigned[key]) continue; // a leave override wins over the pattern
      const pattern = fixedPatterns[key];
      if (!pattern) continue;
      preAssigned[key] =
        pattern.kind === "shift"
          ? { kind: "shift", shiftKey: pattern.shiftKey!, sleepover: false, locked: false }
          : { kind: "code", code: pattern.code!, locked: false };
    }
  });

  const assignments: AssignmentMap = { ...preAssigned };

  const state: Record<string, StaffState> = {};
  staff.forEach((s) => {
    state[s.id] = { hours: 0, days: 0, weekend: 0, intervals: [], byDay: {} };
  });

  const noteExisting = (staffId: string, day: number, a: AssignmentValue) => {
    const st = state[staffId];
    if (!st || a.kind !== "shift") return;
    const sh = shiftBy[a.shiftKey];
    if (!sh) return;
    st.hours += shiftHours(sh);
    st.days += 1;
    if (day >= 5) st.weekend += 1;
    st.byDay[day] = a.shiftKey;
    st.intervals.push([absStart(day, sh), absEnd(day, sh) + (a.sleepover ? 8 : 0)]);
  };

  Object.entries(preAssigned).forEach(([k, a]) => {
    const [staffId, day] = k.split("|");
    noteExisting(staffId, Number(day), a);
  });

  const isLocked = (staffId: string, day: number) => Boolean(preAssigned[`${staffId}|${day}`]);

  function reject(s: StaffMember, day: number, sh: ShiftDef): string | null {
    const st = state[s.id];
    if (isLocked(s.id, day) || st.byDay[day] !== undefined) return "already on that day";
    const av = availability[`${s.id}|${day}`] || { mode: "any" as const, shifts: [] };
    if (av.mode === "off") return "not available";
    if (av.mode === "shifts" && !av.shifts.includes(sh.key)) return "does not work this shift";
    if (st.days + 1 > (s.maxDays || 7)) return "at their maximum days";
    const len = shiftHours(sh);
    const cap = Math.min(48, (s.contractHours || 37.5) * 1.25);
    if (st.hours + len > cap) return "would go over their hours";
    const start = absStart(day, sh);
    const end = absEnd(day, sh);
    for (const [a, b] of st.intervals) {
      if (start < b + 11 && a - 11 < end) {
        return start < b && end > a ? "overlaps another shift" : "under 11 hours rest";
      }
    }
    return null;
  }

  function score(s: StaffMember, day: number, sh: ShiftDef): number {
    const st = state[s.id];
    const av = availability[`${s.id}|${day}`] || { mode: "any" as const, shifts: [] };
    let sc = 0;
    const contract = s.contractHours || 37.5;
    sc -= (contract - st.hours) * 2.2;
    if (av.mode === "shifts" && av.shifts.includes(sh.key)) sc -= 6;
    if (sh.key === "night" && s.role === "WCO") sc -= 8;
    if (sh.key === "night" && (s.role === "Manager" || s.role === "Deputy")) sc += 14;
    if (st.byDay[day - 1] === sh.key) sc -= 4;
    if (day >= 5) sc += st.weekend * 3;
    if (s.role === "BCO") sc += 4;
    sc += rnd() * 2.5;
    return sc;
  }

  const slots: { day: number; sh: ShiftDef }[] = [];
  for (let day = 0; day < 7; day++) {
    shifts.forEach((sh) => {
      const need = demand[day]?.[sh.key] || 0;
      const already = Object.entries(preAssigned).filter(([k, a]) => {
        const [, d] = k.split("|");
        return Number(d) === day && a.kind === "shift" && a.shiftKey === sh.key;
      }).length;
      for (let i = 0; i < need - already; i++) slots.push({ day, sh });
    });
  }

  const pool = (day: number, sh: ShiftDef) =>
    staff.filter((s) => s.isActive && s.schedulingMode === "generated" && !reject(s, day, sh)).length;
  slots.sort((a, b) => {
    const scarcity = pool(a.day, a.sh) - pool(b.day, b.sh);
    if (scarcity !== 0) return scarcity;
    return (a.sh.key === "night" ? 0 : 1) - (b.sh.key === "night" ? 0 : 1);
  });

  slots.forEach(({ day, sh }) => {
    const reasons: Record<string, number> = {};
    const candidates: { s: StaffMember; sc: number }[] = [];
    staff.forEach((s) => {
      if (!s.isActive || s.schedulingMode !== "generated") return;
      const why = reject(s, day, sh);
      if (why) {
        reasons[why] = (reasons[why] || 0) + 1;
        return;
      }
      candidates.push({ s, sc: score(s, day, sh) });
    });
    if (!candidates.length) {
      unfilled.push({ day, shiftKey: sh.key, shiftName: sh.name, reasons });
      return;
    }
    candidates.sort((a, b) => a.sc - b.sc);
    const pick = candidates[0].s;
    const value: AssignmentValue = { kind: "shift", shiftKey: sh.key, sleepover: false, locked: false };
    assignments[`${pick.id}|${day}`] = value;
    noteExisting(pick.id, day, value);
  });

  // sleepovers: someone already on a late shift stays over
  for (let day = 0; day < 7; day++) {
    let need = demand[day]?.sleepover || 0;
    const have = staff.filter((s) => {
      const a = assignments[`${s.id}|${day}`];
      return a?.kind === "shift" && a.sleepover;
    }).length;
    need -= have;
    if (need <= 0) continue;

    const eligible = staff.filter((s) => {
      if (s.schedulingMode !== "generated") return false;
      if (isLocked(s.id, day)) return false;
      const a = assignments[`${s.id}|${day}`];
      if (!a || a.kind !== "shift" || a.sleepover) return false;
      const sh = shiftBy[a.shiftKey];
      if (!sh || toMin(sh.end) < 20 * 60 || sh.key === "night") return false;
      const next = assignments[`${s.id}|${day + 1}`];
      if (next?.kind === "shift") {
        const ns = shiftBy[next.shiftKey];
        if (ns && absStart(day + 1, ns) < absEnd(day, sh) + 8 + 11) return false;
      }
      return true;
    });

    eligible.slice(0, need).forEach((s) => {
      const a = assignments[`${s.id}|${day}`];
      if (a?.kind === "shift") assignments[`${s.id}|${day}`] = { ...a, sleepover: true };
    });
    if (eligible.length < need) {
      unfilled.push({ day, shiftKey: "sleepover", shiftName: "Sleepover", reasons: { "nobody on a late shift is free to stay": 1 } });
    }
  }

  // days off — everyone still on 'generated' who wasn't assigned a shift.
  // 'fixed' staff were already filled from their pattern above; 'manual'
  // staff are left blank for Sumy to fill in by hand.
  staff.forEach((s) => {
    if (s.schedulingMode === "manual") return;
    for (let day = 0; day < 7; day++) {
      const key = `${s.id}|${day}`;
      if (assignments[key]) continue;
      assignments[key] = { kind: "code", code: "D/O", locked: false };
    }
  });

  return { assignments, unfilled };
}
```

`interface StaffState` stays exactly as it is today — unchanged, don't touch it.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npm test`
Expected: PASS — 4 passing tests, 0 failing.

- [ ] **Step 5: Commit**

```bash
git add lib/rota/generator.ts lib/rota/generator.test.ts package.json
git commit -m "Add scheduling-mode support to the rota generator"
```

---

## Task 5: Staff API routes

**Files:**
- Modify: `app/api/rota/staff/route.ts`
- Modify: `app/api/rota/staff/[id]/route.ts`

**Interfaces:**
- Consumes: `ROLES` from `lib/rota/types.ts` (Task 3), `rotaStaff.schedulingMode` from `db/schema/rota.ts` (Task 2).
- Produces: `POST /api/rota/staff` and `PATCH /api/rota/staff/[id]` both return `{ id, name, role, contractHours, maxDays, schedulingMode, isActive }` (no `officeHours`). PATCH additionally accepts `role` and `schedulingMode` in the request body.

- [ ] **Step 1: Update `app/api/rota/staff/route.ts`**

Remove `officeHours: false` from the `.values(...)` call (the column default of `'generated'` covers it), and change the response object's `officeHours: staff.officeHours` line to `schedulingMode: staff.schedulingMode`.

- [ ] **Step 2: Update `app/api/rota/staff/[id]/route.ts`**

Add the import:

```ts
import { ROLES } from "@/lib/rota/types";
```

Replace the `officeHours` patch line:

```ts
  if (typeof body.officeHours === "boolean") patch.officeHours = body.officeHours;
```

with:

```ts
  if (typeof body.role === "string" && ROLES.includes(body.role)) patch.role = body.role;
  if (typeof body.schedulingMode === "string" && ["generated", "fixed", "manual"].includes(body.schedulingMode)) {
    patch.schedulingMode = body.schedulingMode;
  }
```

Replace the response's `officeHours: staff.officeHours` line with `schedulingMode: staff.schedulingMode`.

- [ ] **Step 3: Type-check**

Run: `npx tsc`
Expected: no errors in either of these two files.

- [ ] **Step 4: Commit**

```bash
git add app/api/rota/staff/route.ts "app/api/rota/staff/[id]/route.ts"
git commit -m "Support role and schedulingMode edits on the staff API"
```

---

## Task 6: Config API route

**Files:**
- Modify: `app/api/rota/config/route.ts`

**Interfaces:**
- Consumes: `rotaFixedPatterns` (Task 2), `RotaConfig`/`SchedulingMode` (Task 3).
- Produces: `GET /api/rota/config` response gains `fixedPatterns: FixedPatternMap`; `staff[].officeHours` becomes `staff[].schedulingMode`.

- [ ] **Step 1: Edit the route**

Update the import line:

```ts
import { rotaShiftDefinitions, rotaStaff, rotaAvailability, rotaDemand, rotaFixedPatterns } from "@/db/schema/rota";
```

After the `demandRows` query, add:

```ts
    const fixedPatternRows = await tx.select().from(rotaFixedPatterns);
```

After the `demand` reduction block, add:

```ts
    const fixedPatterns: RotaConfig["fixedPatterns"] = {};
    for (const row of fixedPatternRows) {
      fixedPatterns[`${row.staffId}|${row.dayOfWeek}`] = {
        kind: row.kind as "shift" | "code",
        shiftKey: row.shiftKey,
        code: row.code,
      };
    }
```

In the returned object, change `officeHours: s.officeHours,` to `schedulingMode: s.schedulingMode as RotaConfig["staff"][number]["schedulingMode"],` inside the `staff.map(...)`, and add `fixedPatterns,` as a new top-level field alongside `availability` and `demand`.

- [ ] **Step 2: Type-check**

Run: `npx tsc`
Expected: no errors in `app/api/rota/config/route.ts`.

- [ ] **Step 3: Commit**

```bash
git add app/api/rota/config/route.ts
git commit -m "Return fixedPatterns and schedulingMode from the config API"
```

---

## Task 7: Fixed-pattern API route (new)

**Files:**
- Create: `app/api/rota/fixed-pattern/route.ts`

**Interfaces:**
- Consumes: `withTenant` (`lib/db/client.ts`), `getDefaultTenant` (`lib/rota/tenant.ts`), `rotaFixedPatterns` (Task 2).
- Produces: `PUT /api/rota/fixed-pattern` — body `{ staffId: string, day: number, kind: "shift" | "code", shiftKey?: string, code?: string, applyToWeek?: boolean }`, returns `{ ok: true }`. This is the endpoint the Availability tab's fixed-pattern grid (Task 12) calls.

- [ ] **Step 1: Write the route**

```ts
import { NextRequest, NextResponse } from "next/server";
import { withTenant } from "@/lib/db/client";
import { getDefaultTenant } from "@/lib/rota/tenant";
import { rotaFixedPatterns } from "@/db/schema/rota";

// Upserts one staff/day fixed-pattern cell, or — when `applyToWeek` is set —
// the same kind across all seven days. Mirrors availability/route.ts.
export async function PUT(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const staffId = body?.staffId;
  const kind = body?.kind;
  const shiftKey = typeof body?.shiftKey === "string" ? body.shiftKey : null;
  const code = typeof body?.code === "string" ? body.code : null;
  const applyToWeek = body?.applyToWeek === true;
  const days: number[] = applyToWeek ? [0, 1, 2, 3, 4, 5, 6] : [body?.day];

  const validKind = kind === "shift" ? Boolean(shiftKey) : kind === "code" ? Boolean(code) : false;
  if (typeof staffId !== "string" || !validKind || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    return NextResponse.json({ error: "Invalid body." }, { status: 400 });
  }

  const tenant = await getDefaultTenant();

  await withTenant(tenant.id, async (tx) => {
    for (const day of days) {
      await tx
        .insert(rotaFixedPatterns)
        .values({
          tenantId: tenant.id,
          staffId,
          dayOfWeek: day,
          kind,
          shiftKey: kind === "shift" ? shiftKey : null,
          code: kind === "code" ? code : null,
        })
        .onConflictDoUpdate({
          target: [rotaFixedPatterns.staffId, rotaFixedPatterns.dayOfWeek],
          set: { kind, shiftKey: kind === "shift" ? shiftKey : null, code: kind === "code" ? code : null, updatedAt: new Date() },
        });
    }
  });

  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc`
Expected: no errors in `app/api/rota/fixed-pattern/route.ts`.

- [ ] **Step 3: Commit**

```bash
git add app/api/rota/fixed-pattern/route.ts
git commit -m "Add the fixed-pattern upsert API route"
```

---

## Task 8: Build route integration

**Files:**
- Modify: `app/api/rota/weeks/[weekStart]/build/route.ts`

**Interfaces:**
- Consumes: `rotaFixedPatterns` (Task 2), `FixedPatternMap` (Task 3), `generateRota`'s new `fixedPatterns` input field (Task 4).
- Produces: the build route now loads fixed patterns and passes them into the generator — no change to the route's own response shape.

- [ ] **Step 1: Edit the route**

Update the import line:

```ts
import { rotaShiftDefinitions, rotaStaff, rotaAvailability, rotaDemand, rotaWeeks, rotaAssignments, rotaFixedPatterns } from "@/db/schema/rota";
import type { AssignmentMap, AvailabilityMap, DemandMap, FixedPatternMap, ShiftDef, StaffMember } from "@/lib/rota/types";
```

In the `staff` mapping, change `officeHours: s.officeHours,` to `schedulingMode: s.schedulingMode as StaffMember["schedulingMode"],`.

After the `demandRows` block, add:

```ts
    const fixedPatternRows = await tx.select().from(rotaFixedPatterns);
    const fixedPatterns: FixedPatternMap = {};
    for (const row of fixedPatternRows) {
      fixedPatterns[`${row.staffId}|${row.dayOfWeek}`] = { kind: row.kind as "shift" | "code", shiftKey: row.shiftKey, code: row.code };
    }
```

Change the `generateRota` call to:

```ts
    const { assignments, unfilled } = generateRota({ staff, shifts, availability, demand, locked, fixedPatterns, seed });
```

- [ ] **Step 2: Type-check**

Run: `npx tsc`
Expected: no errors in `app/api/rota/weeks/[weekStart]/build/route.ts`.

- [ ] **Step 3: Commit**

```bash
git add "app/api/rota/weeks/[weekStart]/build/route.ts"
git commit -m "Load fixed patterns into the rota build"
```

---

## Task 9: Seed data

**Files:**
- Modify: `db/seed.ts`

**Interfaces:**
- Consumes: `rotaFixedPatterns` (Task 2), `SchedulingMode` (Task 3).
- Produces: fresh environments get Brian K as Driver/manual, Gail and Sumy as fixed with correct patterns, and the new `dom` shift definition — no effect on an already-seeded database (the script still exits immediately once the tenant exists).

- [ ] **Step 1: Edit `db/seed.ts`**

Update the import line:

```ts
import { rotaShiftDefinitions, rotaStaff, rotaAvailability, rotaDemand, rotaFixedPatterns } from "@/db/schema/rota";
import type { SchedulingMode } from "@/lib/rota/types";
```

Add the new shift definition to `SHIFTS`:

```ts
const SHIFTS = [
  { key: "early", name: "Early", startTime: "07:00", endTime: "15:00", sortOrder: 0 },
  { key: "mid", name: "Mid", startTime: "13:00", endTime: "21:00", sortOrder: 1 },
  { key: "back", name: "Back", startTime: "15:00", endTime: "23:00", sortOrder: 2 },
  { key: "night", name: "Night", startTime: "21:00", endTime: "07:00", sortOrder: 3 },
  { key: "dom", name: "Dom", startTime: "09:00", endTime: "13:00", sortOrder: 4 },
];
```

Replace the `SEED_STAFF` declaration and its `officeHours` column with `schedulingMode`, and fix Brian K's role:

```ts
// [name, role, contractHours, schedulingMode]
const SEED_STAFF: [string, string, number, SchedulingMode][] = [
  ["Sumy", "Manager", 37.5, "fixed"],
  ["Tracey", "Deputy", 37.5, "generated"],
  ["Eliza", "SCO", 37.5, "generated"],
  ["Roma", "CO", 24, "generated"],
  ["Ayo", "CO", 37.5, "generated"],
  ["Olu", "CO", 37.5, "generated"],
  ["Janet", "CO", 30, "generated"],
  ["Vincent", "CO", 18, "generated"],
  ["Kaushik", "CO", 16, "generated"],
  ["Victoria", "CO", 20, "generated"],
  ["Raghul", "BCO", 30, "generated"],
  ["Ola", "BCO", 10, "generated"],
  ["Divin", "BCO", 24, "generated"],
  ["Esther", "WCO", 30, "generated"],
  ["Brian K", "Driver", 24, "manual"],
  ["Gail", "Dom", 20, "fixed"],
];

// Weekly pattern for staff seeded as scheduling_mode = 'fixed'.
const FIXED_PATTERNS: Record<string, { day: number; kind: "shift" | "code"; shiftKey?: string; code?: string }[]> = {
  Sumy: [0, 1, 2, 3, 4]
    .map((day) => ({ day, kind: "code" as const, code: "IN" }))
    .concat([5, 6].map((day) => ({ day, kind: "code" as const, code: "D/O" }))),
  Gail: [0, 1, 2, 3, 4]
    .map((day) => ({ day, kind: "shift" as const, shiftKey: "dom" }))
    .concat([5, 6].map((day) => ({ day, kind: "code" as const, code: "D/O" }))),
};
```

In the staff loop, change:

```ts
  for (const [name, role, contractHours, officeHours] of SEED_STAFF) {
```

to:

```ts
  for (const [name, role, contractHours, schedulingMode] of SEED_STAFF) {
```

and change the `.values({...})` call inside it from `officeHours,` to `schedulingMode,`.

Immediately after the availability loop (`for (let day = 0; day < 7; day++) { ... }` that ends the per-staff block), add:

```ts
    for (const p of FIXED_PATTERNS[name] ?? []) {
      await db
        .insert(rotaFixedPatterns)
        .values({
          tenantId: tenant.id,
          staffId,
          dayOfWeek: p.day,
          kind: p.kind,
          shiftKey: p.kind === "shift" ? p.shiftKey! : null,
          code: p.kind === "code" ? p.code! : null,
        })
        .onConflictDoUpdate({
          target: [rotaFixedPatterns.staffId, rotaFixedPatterns.dayOfWeek],
          set: { kind: p.kind, shiftKey: p.kind === "shift" ? p.shiftKey! : null, code: p.kind === "code" ? p.code! : null },
        });
    }
```

- [ ] **Step 2: Type-check**

Run: `npx tsc`
Expected: no errors in `db/seed.ts`.

- [ ] **Step 3: Commit**

```bash
git add db/seed.ts
git commit -m "Seed Brian K as Driver/manual and Gail/Sumy as fixed pattern"
```

---

## Task 10: Staff panel UI — role and scheduling-mode editing

**Files:**
- Modify: `app/rota/page.tsx` (the `StaffPanel` function)

**Interfaces:**
- Consumes: `ROLES` (already imported), `StaffMember.schedulingMode` (Task 3), the existing `updateStaff(id, patch)` handler (unchanged signature — `Partial<StaffMember>` already covers the new field).
- Produces: existing staff rows can have their role and scheduling mode changed from the Staff panel — this is the actual mechanism for correcting Brian K and setting Gail's mode.

- [ ] **Step 1: Replace the static role label with a role select**

In `StaffPanel`, inside the `config.staff.map((s) => ...)` block, replace:

```tsx
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 560 }}>{s.name}</div>
                  <div style={{ fontSize: 10, letterSpacing: ".1em", color: T.muted, textTransform: "uppercase" }}>{s.role}</div>
                </div>
```

with:

```tsx
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 560 }}>{s.name}</div>
                  <select
                    value={s.role}
                    onChange={(e) => updateStaff(s.id, { role: e.target.value })}
                    style={{ fontSize: 10, letterSpacing: ".1em", color: T.muted, textTransform: "uppercase", border: "none", background: "transparent", padding: 0, marginTop: 2, cursor: "pointer" }}
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>{r}</option>
                    ))}
                  </select>
                </div>
```

- [ ] **Step 2: Replace the "Office hours" toggle with a scheduling-mode control**

Replace:

```tsx
                <button
                  onClick={() => updateStaff(s.id, { officeHours: !s.officeHours })}
                  style={{ fontSize: 11.5, padding: "5px 9px", borderRadius: 6, cursor: "pointer", border: `1px solid ${s.officeHours ? T.accent : T.rule}`, background: s.officeHours ? T.accentBg : T.surface, color: s.officeHours ? T.accent : T.muted }}
                >
                  Office hours
                </button>
```

with:

```tsx
                <div style={{ display: "inline-flex", borderRadius: 6, overflow: "hidden", border: `1px solid ${T.rule}` }}>
                  {(["generated", "fixed", "manual"] as const).map((mode) => (
                    <button
                      key={mode}
                      onClick={() => updateStaff(s.id, { schedulingMode: mode })}
                      style={{
                        fontSize: 10.5, padding: "5px 8px", cursor: "pointer", border: "none", fontFamily: SANS,
                        background: s.schedulingMode === mode ? T.accent : T.surface,
                        color: s.schedulingMode === mode ? "#fff" : T.body,
                      }}
                    >
                      {mode === "generated" ? "Generated" : mode === "fixed" ? "Fixed pattern" : "Manual"}
                    </button>
                  ))}
                </div>
```

- [ ] **Step 3: Type-check**

Run: `npx tsc`
Expected: no errors in `app/rota/page.tsx` related to `StaffPanel`. (The `AvailabilityTab` section will still error until Task 12 — that's expected.)

- [ ] **Step 4: Commit**

```bash
git add app/rota/page.tsx
git commit -m "Make role and scheduling mode editable in the Staff panel"
```

---

## Task 11: Fixed-pattern grid component

**Files:**
- Modify: `app/rota/page.tsx` (add a new `FixedPatternGrid` function near `AvailabilityTab`)

**Interfaces:**
- Consumes: `ShiftDef`, `FixedPatternMap`, `LEAVE_CODES`, `DAYS`, `SHORT_DAYS`, `MONO`, `T` (all already in this file), `shiftLabel` (already imported from `lib/rota/date-utils`).
- Produces: `FixedPatternGrid({ staffId, shifts, patterns, setFixedPattern })` — a 7-day row of selects. `setFixedPattern`'s signature (defined and wired in Task 12) is `(staffId: string, day: number, entry: { kind: "shift" | "code"; shiftKey?: string; code?: string }, applyToWeek?: boolean) => void`.

- [ ] **Step 1: Add the component**

Add this function directly after `AvailabilityTab` (before `/* --------------------------- COVER TAB --------------------------- */`):

```tsx
function FixedPatternGrid({
  staffId, shifts, patterns, setFixedPattern,
}: {
  staffId: string; shifts: ShiftDef[]; patterns: FixedPatternMap;
  setFixedPattern: (staffId: string, day: number, entry: { kind: "shift" | "code"; shiftKey?: string; code?: string }, applyToWeek?: boolean) => void;
}) {
  const options: { value: string; label: string }[] = [
    { value: "code:D/O", label: "D/O — day off" },
    ...shifts.map((sh) => ({ value: `shift:${sh.key}`, label: shiftLabel(sh) })),
    ...Object.entries(LEAVE_CODES).map(([code, name]) => ({ value: `code:${code}`, label: name })),
  ];

  const valueFor = (day: number) => {
    const p = patterns[`${staffId}|${day}`];
    if (!p) return "code:D/O";
    return p.kind === "shift" ? `shift:${p.shiftKey}` : `code:${p.code}`;
  };

  const change = (day: number, raw: string, applyToWeek = false) => {
    const [kind, value] = raw.split(":");
    if (kind === "shift") setFixedPattern(staffId, day, { kind: "shift", shiftKey: value }, applyToWeek);
    else setFixedPattern(staffId, day, { kind: "code", code: value }, applyToWeek);
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 5 }}>
      {DAYS.map((_, d) => (
        <div key={d}>
          <div style={{ fontSize: 10, opacity: 0.75, textAlign: "center", marginBottom: 3, color: T.muted }}>{SHORT_DAYS[d].toUpperCase()}</div>
          <select
            value={valueFor(d)}
            onChange={(e) => change(d, e.target.value)}
            onDoubleClick={() => change(d, valueFor(d), true)}
            title="Pick what they do this day · double click to copy to the whole week"
            style={{ width: "100%", fontFamily: MONO, fontSize: 10, padding: "5px 2px", borderRadius: 6, border: `1px solid ${T.rule}`, background: T.surface, color: T.ink, cursor: "pointer" }}
          >
            {options.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc`
Expected: `FixedPatternGrid` itself type-checks. (It isn't called anywhere yet, so no new errors from this addition — the file's existing errors from earlier tasks in this UI file are still expected until Task 12.)

- [ ] **Step 3: Commit**

```bash
git add app/rota/page.tsx
git commit -m "Add the fixed-pattern grid component"
```

---

## Task 12: Wire scheduling mode into the Availability tab

**Files:**
- Modify: `app/rota/page.tsx` (top-level `RotaBuilderPage`, `AvailabilityTab`, its call site)

**Interfaces:**
- Consumes: `FixedPatternGrid` (Task 11), `/api/rota/fixed-pattern` (Task 7), `config.fixedPatterns` (Task 6).
- Produces: a working `setFixedPattern` handler on the page; `AvailabilityTab` renders the right editor per staff member's `schedulingMode`.

- [ ] **Step 1: Add the `setFixedPattern` handler**

In `RotaBuilderPage`, directly after the `setAvailability` function, add:

```tsx
  const setFixedPattern = async (staffId: string, day: number, entry: { kind: "shift" | "code"; shiftKey?: string; code?: string }, applyToWeek = false) => {
    try {
      await api("/api/rota/fixed-pattern", { method: "PUT", body: JSON.stringify({ staffId, day, ...entry, applyToWeek }) });
      await loadConfig();
    } catch (e) {
      flash(e instanceof Error ? e.message : "Could not save.");
    }
  };
```

- [ ] **Step 2: Pass it into `AvailabilityTab`**

Change the call site:

```tsx
        {tab === "availability" && <AvailabilityTab config={config} staff={staff} setAvailability={setAvailability} openStaff={() => setStaffPanel(true)} />}
```

to:

```tsx
        {tab === "availability" && (
          <AvailabilityTab config={config} staff={staff} setAvailability={setAvailability} setFixedPattern={setFixedPattern} openStaff={() => setStaffPanel(true)} />
        )}
```

- [ ] **Step 3: Update `AvailabilityTab`'s signature and per-staff-card branching**

Change the function signature:

```tsx
function AvailabilityTab({
  config, staff, setAvailability, setFixedPattern, openStaff,
}: {
  config: RotaConfig; staff: StaffMember[];
  setAvailability: (staffId: string, day: number, mode: string, shifts: string[], applyToWeek?: boolean) => void;
  setFixedPattern: (staffId: string, day: number, entry: { kind: "shift" | "code"; shiftKey?: string; code?: string }, applyToWeek?: boolean) => void;
  openStaff: () => void;
}) {
```

Inside the `staff.map((s) => ...)` block, replace the existing:

```tsx
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 5 }}>
              {DAYS.map((_, d) => {
                ...
              })}
            </div>
```

(the whole availability grid block, from `<div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)"` through its closing `</div>`) with:

```tsx
            {s.schedulingMode === "generated" && (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 5 }}>
                {DAYS.map((_, d) => {
                  const av = config.availability[`${s.id}|${d}`] || { mode: "any" as const, shifts: [] };
                  const tone = av.mode === "off" ? { fg: T.muted, bg: T.paper, bd: T.rule } : av.mode === "shifts" ? { fg: T.night, bg: T.nightBg, bd: T.night } : { fg: T.accent, bg: T.accentBg, bd: T.accent };
                  return (
                    <div key={d}>
                      <button
                        onClick={() => cycle(s.id, d)}
                        onDoubleClick={() => applyAll(s.id, d)}
                        title="Tap to change · double tap to copy to the whole week"
                        style={{ width: "100%", padding: "7px 2px", borderRadius: 6, cursor: "pointer", border: `1px solid ${tone.bd}`, background: tone.bg, color: tone.fg, fontSize: 10.5, fontWeight: 600, letterSpacing: ".06em" }}
                      >
                        <div style={{ fontSize: 10, opacity: 0.75 }}>{SHORT_DAYS[d].toUpperCase()}</div>
                        <div style={{ marginTop: 2 }}>{av.mode === "off" ? "OFF" : av.mode === "any" ? "ANY" : "SOME"}</div>
                      </button>
                      {av.mode === "shifts" && (
                        <div style={{ display: "grid", gap: 2, marginTop: 3 }}>
                          {config.shifts.map((sh) => {
                            const on = av.shifts.includes(sh.key);
                            return (
                              <button
                                key={sh.key}
                                onClick={() => toggleShift(s.id, d, sh.key)}
                                style={{ fontFamily: MONO, fontSize: 9, padding: "3px 1px", borderRadius: 4, cursor: "pointer", border: `1px solid ${on ? T.night : T.ruleSoft}`, background: on ? T.night : T.surface, color: on ? "#fff" : T.muted }}
                              >
                                {shortTime(sh.start)}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            {s.schedulingMode === "fixed" && (
              <FixedPatternGrid staffId={s.id} shifts={config.shifts} patterns={config.fixedPatterns} setFixedPattern={setFixedPattern} />
            )}
            {s.schedulingMode === "manual" && (
              <p style={{ fontSize: 12.5, color: T.muted, lineHeight: 1.5, margin: 0 }}>
                The solver never assigns them — Sumy fills every cell by hand each week.
              </p>
            )}
```

(This is a rename-in-place of the existing block's contents — the inner logic for the `generated` branch is unchanged from what's there today; only the wrapping `{s.schedulingMode === "generated" && (...)}` condition and the two new branches are new.)

- [ ] **Step 4: Type-check**

Run: `npx tsc`
Expected: no errors anywhere in `app/rota/page.tsx`.

- [ ] **Step 5: Commit**

```bash
git add app/rota/page.tsx
git commit -m "Branch the Availability tab on scheduling mode"
```

---

## Task 13: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Full type-check**

Run: `npx tsc`
Expected: zero errors, whole repo.

- [ ] **Step 2: Full test run**

Run: `npm test`
Expected: all 4 generator tests pass, 0 failures.

- [ ] **Step 3: Production build**

Run: `npm run build`
Expected: builds successfully. This does not require `DATABASE_URL` — the Postgres client is lazy (see `lib/db/client.ts`'s comment).

- [ ] **Step 4: Grep for leftover `officeHours` references**

Run: `grep -rn "officeHours" --include="*.ts" --include="*.tsx" app lib db`
Expected: no output — confirms every reference was migrated, not just the ones this plan explicitly touched. If anything shows up, fix it before moving on.

- [ ] **Step 5: Commit (only if Step 4 required a fix)**

If Step 4 found something and you fixed it:

```bash
git add -A
git commit -m "Remove remaining officeHours references"
```

---

## Applying this locally

Not a plan task — this is interactive, run once `DATABASE_URL` is set in `.env.local` (see `DEPLOYMENT.md`):

1. `npm run db:migrate` — applies `0003_rota_scheduling_mode.sql`. Expect `apply 0003_rota_scheduling_mode.sql` then `done.` in the output.
2. Run the one-off shift insert from Task 1 Step 2 against the same database (via `npm run db:studio`'s SQL runner, `psql`, or your Postgres host's query console):
   ```sql
   INSERT INTO rota_shift_definitions (tenant_id, key, name, start_time, end_time, sort_order)
   SELECT id, 'dom', 'Dom', '09:00', '13:00', 4 FROM tenants WHERE slug = 'linkfield'
   ON CONFLICT (tenant_id, key) DO NOTHING;
   ```
3. `npm run dev`, open `/rota`, log in.

Then, to correct Brian K and set up Gail:

- **Brian K → Driver, manual:** Rota tab → **Staff** button → find Brian K's row → change the role dropdown from Kitchen to **Driver** → click **Manual** in the three-button mode control next to it.
- **Gail → fixed, her pattern:** same Staff panel → find Gail's row → click **Fixed pattern**. Close the panel, switch to the **Who can work when** tab — Gail's card now shows seven day-selects instead of the usual availability buttons. Set Monday to **09–13** (from the shift list in the dropdown), then double-click that same Monday select to copy it across the whole week — this sets all seven days to `09–13`. Then click Saturday's and Sunday's selects individually and change them to **D/O — day off**.
- Build a week and confirm: Gail shows `09–13` Monday–Friday and `D/O` weekends every time you rebuild; Brian K's row is blank and freely editable; giving Gail `AL` on a Wednesday (via the normal cell editor, same as any other staff member) survives a rebuild instead of reverting to `09–13`.
