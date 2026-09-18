// Shared between the API routes and the client. Day of week: 0 = Monday .. 6 = Sunday.

export type AvailabilityMode = "any" | "shifts" | "off";

export interface ShiftDef {
  key: string;
  name: string;
  start: string; // "HH:MM"
  end: string; // "HH:MM"
}

export type SchedulingMode = "generated" | "fixed" | "manual";

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

export interface FixedPatternEntry {
  kind: "shift" | "code";
  shiftKey: string | null;
  code: string | null;
}

// key: `${staffId}|${day}`
export type FixedPatternMap = Record<string, FixedPatternEntry>;

export interface Availability {
  mode: AvailabilityMode;
  shifts: string[];
}

// key: `${staffId}|${day}`
export type AvailabilityMap = Record<string, Availability>;

// demand[day][shiftKey | "sleepover"] = headcount
export type DemandMap = Record<number, Record<string, number>>;

export type AssignmentValue =
  | { kind: "shift"; shiftKey: string; sleepover: boolean; locked: boolean }
  | { kind: "code"; code: string; locked: boolean };

// key: `${staffId}|${day}`
export type AssignmentMap = Record<string, AssignmentValue>;

export interface UnfilledEntry {
  day: number;
  shiftKey: string;
  shiftName: string;
  reasons: Record<string, number>;
}

export interface WeekData {
  weekStart: string; // YYYY-MM-DD, Monday
  built: boolean;
  onCallStaffId: string | null;
  unfilled: UnfilledEntry[];
  assignments: AssignmentMap;
}

export interface RotaConfig {
  tenantName: string;
  shifts: ShiftDef[];
  staff: StaffMember[];
  availability: AvailabilityMap;
  demand: DemandMap;
  fixedPatterns: FixedPatternMap;
}

export const LEAVE_CODES: Record<string, string> = {
  AL: "Annual leave",
  SL: "Sick",
  TR: "Training",
};

export const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
export const SHORT_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export const ROLES = ["Manager", "Deputy", "SCO", "CO", "BCO", "WCO", "Kitchen", "Dom", "Driver"];
