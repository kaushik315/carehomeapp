import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { withTenant } from "@/lib/db/client";
import { getDefaultTenant } from "@/lib/rota/tenant";
import { rotaStaff } from "@/db/schema/rota";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid body." }, { status: 400 });
  }

  const patch: Partial<typeof rotaStaff.$inferInsert> = {};
  if (typeof body.isActive === "boolean") patch.isActive = body.isActive;
  if (typeof body.officeHours === "boolean") patch.officeHours = body.officeHours;
  if (typeof body.contractHours === "number" && body.contractHours >= 0) patch.contractHours = body.contractHours.toString();
  if (typeof body.maxDays === "number" && body.maxDays >= 0) patch.maxDays = body.maxDays;

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
  }
  patch.updatedAt = new Date();

  const tenant = await getDefaultTenant();
  const staff = await withTenant(tenant.id, async (tx) => {
    const [staff] = await tx.update(rotaStaff).set(patch).where(eq(rotaStaff.id, id)).returning();
    return staff;
  });

  if (!staff) return NextResponse.json({ error: "Not found." }, { status: 404 });

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
