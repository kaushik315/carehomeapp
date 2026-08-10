import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { withTenant } from "@/lib/db/client";
import { getDefaultTenant } from "@/lib/rota/tenant";
import { rotaShiftDefinitions, rotaStaff, rotaAvailability, rotaDemand, rotaWeeks, rotaAssignments } from "@/db/schema/rota";
import { generateRota } from "@/lib/rota/generator";
import type { AssignmentMap, AvailabilityMap, DemandMap, ShiftDef, StaffMember } from "@/lib/rota/types";

function isValidWeekStart(weekStart: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(weekStart);
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ weekStart: string }> }) {
  const { weekStart } = await params;
  if (!isValidWeekStart(weekStart)) return NextResponse.json({ error: "Invalid week." }, { status: 400 });

  const body = await req.json().catch(() => ({}));
  const seed = Number.isFinite(body?.seed) ? Number(body.seed) : 1;

  const tenant = await getDefaultTenant();

  const result = await withTenant(tenant.id, async (tx) => {
    const shiftRows = await tx.select().from(rotaShiftDefinitions).where(eq(rotaShiftDefinitions.isActive, true));
    const shifts: ShiftDef[] = shiftRows.map((s) => ({ key: s.key, name: s.name, start: s.startTime.slice(0, 5), end: s.endTime.slice(0, 5) }));

    const staffRows = await tx.select().from(rotaStaff);
    const staff: StaffMember[] = staffRows.map((s) => ({
      id: s.id,
      name: s.name,
      role: s.role,
      contractHours: Number(s.contractHours),
      maxDays: s.maxDays,
      officeHours: s.officeHours,
      isActive: s.isActive,
    }));

    const availabilityRows = await tx.select().from(rotaAvailability);
    const availability: AvailabilityMap = {};
    for (const row of availabilityRows) {
      availability[`${row.staffId}|${row.dayOfWeek}`] = { mode: row.mode as "any" | "shifts" | "off", shifts: (row.shiftKeys as string[]) ?? [] };
    }

    const demandRows = await tx.select().from(rotaDemand);
    const demand: DemandMap = {};
    for (const row of demandRows) {
      demand[row.dayOfWeek] ??= {};
      demand[row.dayOfWeek][row.shiftKey] = row.headcount;
    }

    const [existingWeek] = await tx.select().from(rotaWeeks).where(eq(rotaWeeks.weekStart, weekStart)).limit(1);
    const week = existingWeek ?? (await tx.insert(rotaWeeks).values({ tenantId: tenant.id, weekStart }).returning())[0];

    const lockedRows = existingWeek ? await tx.select().from(rotaAssignments).where(eq(rotaAssignments.weekId, week.id)) : [];
    const locked: AssignmentMap = {};
    for (const row of lockedRows) {
      if (!row.locked) continue;
      const key = `${row.staffId}|${row.dayOfWeek}`;
      locked[key] =
        row.kind === "shift"
          ? { kind: "shift", shiftKey: row.shiftKey!, sleepover: row.sleepover, locked: true }
          : { kind: "code", code: row.code!, locked: true };
    }

    const { assignments, unfilled } = generateRota({ staff, shifts, availability, demand, locked, seed });

    await tx.delete(rotaAssignments).where(eq(rotaAssignments.weekId, week.id));
    const values = Object.entries(assignments).map(([key, a]) => {
      const [staffId, day] = key.split("|");
      return {
        tenantId: tenant.id,
        weekId: week.id,
        staffId,
        dayOfWeek: Number(day),
        kind: a.kind,
        shiftKey: a.kind === "shift" ? a.shiftKey : null,
        sleepover: a.kind === "shift" ? a.sleepover : false,
        code: a.kind === "code" ? a.code : null,
        locked: a.locked,
      };
    });
    if (values.length) await tx.insert(rotaAssignments).values(values);

    await tx.update(rotaWeeks).set({ built: true, builtAt: new Date(), unfilled, updatedAt: new Date() }).where(eq(rotaWeeks.id, week.id));

    return { weekStart, built: true, onCallStaffId: week.onCallStaffId, unfilled, assignments };
  });

  return NextResponse.json(result);
}
