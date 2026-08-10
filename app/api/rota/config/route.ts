import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { withTenant } from "@/lib/db/client";
import { getDefaultTenant } from "@/lib/rota/tenant";
import { rotaShiftDefinitions, rotaStaff, rotaAvailability, rotaDemand } from "@/db/schema/rota";
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

    return {
      tenantName: tenant.name,
      shifts: shifts.map((s) => ({ key: s.key, name: s.name, start: hhmm(s.startTime), end: hhmm(s.endTime) })),
      staff: staff.map((s) => ({
        id: s.id,
        name: s.name,
        role: s.role,
        contractHours: Number(s.contractHours),
        maxDays: s.maxDays,
        officeHours: s.officeHours,
        isActive: s.isActive,
      })),
      availability,
      demand,
    } satisfies RotaConfig;
  });

  return NextResponse.json(config);
}
