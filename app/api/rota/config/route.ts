import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { withTenant } from "@/lib/db/client";
import { getDefaultTenant } from "@/lib/rota/tenant";
import { rotaShiftDefinitions, rotaStaff, rotaAvailability, rotaDemand, rotaFixedPatterns } from "@/db/schema/rota";
import type { RotaConfig } from "@/lib/rota/types";

function hhmm(t: string): string {
  return t.slice(0, 5);
}

export async function GET() {
  const tenant = await getDefaultTenant();

  const config = await withTenant(tenant.id, async (tx) => {
    const shifts = await tx
      .select()
      .from(rotaShiftDefinitions)
      .where(eq(rotaShiftDefinitions.isActive, true))
      .orderBy(rotaShiftDefinitions.sortOrder);

    const staff = await tx.select().from(rotaStaff).orderBy(rotaStaff.name);
    const availabilityRows = await tx.select().from(rotaAvailability);
    const demandRows = await tx.select().from(rotaDemand);
    const fixedPatternRows = await tx.select().from(rotaFixedPatterns);

    const availability: RotaConfig["availability"] = {};
    for (const row of availabilityRows) {
      availability[`${row.staffId}|${row.dayOfWeek}`] = {
        mode: row.mode as "any" | "shifts" | "off",
        shifts: (row.shiftKeys as string[]) ?? [],
      };
    }

    const demand: RotaConfig["demand"] = {};
    for (const row of demandRows) {
      demand[row.dayOfWeek] ??= {};
      demand[row.dayOfWeek][row.shiftKey] = row.headcount;
    }

    const fixedPatterns: RotaConfig["fixedPatterns"] = {};
    for (const row of fixedPatternRows) {
      fixedPatterns[`${row.staffId}|${row.dayOfWeek}`] = {
        kind: row.kind as "shift" | "code",
        shiftKey: row.shiftKey,
        code: row.code,
      };
    }

    return {
      tenantName: tenant.name,
      shifts: shifts.map((s) => ({ key: s.key, name: s.name, start: hhmm(s.startTime), end: hhmm(s.endTime) })),
      staff: staff.map((s) => ({
        id: s.id,
        name: s.name,
        role: s.role,
        contractHours: Number(s.contractHours),
        maxDays: s.maxDays,
        schedulingMode: s.schedulingMode as RotaConfig["staff"][number]["schedulingMode"],
        eligibleShifts: (s.eligibleShifts as string[]) ?? [],
        isActive: s.isActive,
      })),
      availability,
      demand,
      fixedPatterns,
    } satisfies RotaConfig;
  });

  return NextResponse.json(config);
}
