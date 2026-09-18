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
