import { NextRequest, NextResponse } from "next/server";
import { withTenant } from "@/lib/db/client";
import { getDefaultTenant } from "@/lib/rota/tenant";
import { rotaStaff, rotaAvailability } from "@/db/schema/rota";
import { ROLES } from "@/lib/rota/types";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const role = typeof body?.role === "string" ? body.role : "";
  if (!name || !ROLES.includes(role)) {
    return NextResponse.json({ error: "A name and a valid role are required." }, { status: 400 });
  }

  const tenant = await getDefaultTenant();

  const staff = await withTenant(tenant.id, async (tx) => {
    const [staff] = await tx
      .insert(rotaStaff)
      .values({ tenantId: tenant.id, name, role, contractHours: "30", maxDays: 5, officeHours: false })
      .returning();

    await tx.insert(rotaAvailability).values(
      Array.from({ length: 7 }, (_, day) => ({
        tenantId: tenant.id,
        staffId: staff.id,
        dayOfWeek: day,
        mode: "any" as const,
        shiftKeys: [] as string[],
      })),
    );

    return staff;
  });

  return NextResponse.json({
    id: staff.id,
    name: staff.name,
    role: staff.role,
    contractHours: Number(staff.contractHours),
    maxDays: staff.maxDays,
    officeHours: staff.officeHours,
    isActive: staff.isActive,
  });
}
