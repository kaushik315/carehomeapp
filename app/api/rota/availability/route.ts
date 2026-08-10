import { NextRequest, NextResponse } from "next/server";
import { withTenant } from "@/lib/db/client";
import { getDefaultTenant } from "@/lib/rota/tenant";
import { rotaAvailability } from "@/db/schema/rota";

// Upserts one staff/day cell, or — when `applyToWeek` is set — the same
// mode+shifts across all seven days (the prototype's "double tap to copy
// to the whole week").
export async function PUT(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const staffId = body?.staffId;
  const mode = body?.mode;
  const shifts = Array.isArray(body?.shifts) ? body.shifts : [];
  const applyToWeek = body?.applyToWeek === true;
  const days: number[] = applyToWeek ? [0, 1, 2, 3, 4, 5, 6] : [body?.day];

  if (typeof staffId !== "string" || !["any", "shifts", "off"].includes(mode) || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    return NextResponse.json({ error: "Invalid body." }, { status: 400 });
  }

  const tenant = await getDefaultTenant();

  await withTenant(tenant.id, async (tx) => {
    for (const day of days) {
      await tx
        .insert(rotaAvailability)
        .values({ tenantId: tenant.id, staffId, dayOfWeek: day, mode, shiftKeys: shifts })
        .onConflictDoUpdate({
          target: [rotaAvailability.staffId, rotaAvailability.dayOfWeek],
          set: { mode, shiftKeys: shifts, updatedAt: new Date() },
        });
    }
  });

  return NextResponse.json({ ok: true });
}
