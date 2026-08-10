// Port of the generator in prototypes/rota-builder.jsx onto the real data
// shapes. Behaviour is unchanged: hard rules are never broken — an
// unfillable slot is left open and reported, never fudged. Soft rules are
// scored, lower is better. See CLAUDE.md "Rota generator — how it works".
import type { AssignmentMap, AssignmentValue, AvailabilityMap, DemandMap, ShiftDef, StaffMember, UnfilledEntry } from "@/lib/rota/types";

function mulberry32(seed: number) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function toMin(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function shiftHours(sh: { start: string; end: string }): number {
  let len = toMin(sh.end) - toMin(sh.start);
  if (len <= 0) len += 1440;
  return len / 60;
}

function absStart(day: number, sh: { start: string }): number {
  return day * 24 + toMin(sh.start) / 60;
}

function absEnd(day: number, sh: { start: string; end: string }): number {
  return absStart(day, sh) + shiftHours(sh);
}

interface StaffState {
  hours: number;
  days: number;
  weekend: number;
  intervals: [number, number][];
  byDay: Record<number, string>;
}

export interface GenerateRotaInput {
  staff: StaffMember[];
  shifts: ShiftDef[];
  availability: AvailabilityMap;
  demand: DemandMap;
  locked: AssignmentMap; // only the cells to preserve as-is
  seed: number;
}

export interface GenerateRotaResult {
  assignments: AssignmentMap;
  unfilled: UnfilledEntry[];
}

export function generateRota({ staff, shifts, availability, demand, locked, seed }: GenerateRotaInput): GenerateRotaResult {
  const rnd = mulberry32(seed);
  const shiftBy = Object.fromEntries(shifts.map((s) => [s.key, s]));
  const assignments: AssignmentMap = { ...locked };
  const unfilled: UnfilledEntry[] = [];

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

  Object.entries(locked).forEach(([k, a]) => {
    const [staffId, day] = k.split("|");
    noteExisting(staffId, Number(day), a);
  });

  const isLocked = (staffId: string, day: number) => Boolean(locked[`${staffId}|${day}`]);

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
      const already = Object.entries(locked).filter(([k, a]) => {
        const [, d] = k.split("|");
        return Number(d) === day && a.kind === "shift" && a.shiftKey === sh.key;
      }).length;
      for (let i = 0; i < need - already; i++) slots.push({ day, sh });
    });
  }

  const pool = (day: number, sh: ShiftDef) => staff.filter((s) => s.isActive && !s.officeHours && !reject(s, day, sh)).length;
  slots.sort((a, b) => {
    const scarcity = pool(a.day, a.sh) - pool(b.day, b.sh);
    if (scarcity !== 0) return scarcity;
    return (a.sh.key === "night" ? 0 : 1) - (b.sh.key === "night" ? 0 : 1);
  });

  slots.forEach(({ day, sh }) => {
    const reasons: Record<string, number> = {};
    const candidates: { s: StaffMember; sc: number }[] = [];
    staff.forEach((s) => {
      if (!s.isActive || s.officeHours) return;
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

  // office-hours staff and days off
  staff.forEach((s) => {
    for (let day = 0; day < 7; day++) {
      const key = `${s.id}|${day}`;
      if (assignments[key]) continue;
      const av = availability[key] || { mode: "any" as const, shifts: [] };
      if (s.officeHours && day < 5 && av.mode !== "off") {
        assignments[key] = { kind: "code", code: "IN", locked: false };
        continue;
      }
      assignments[key] = { kind: "code", code: "D/O", locked: false };
    }
  });

  return { assignments, unfilled };
}
