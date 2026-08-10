import { NextRequest, NextResponse } from "next/server";
import { withTenant } from "@/lib/db/client";
import { getDefaultTenant } from "@/lib/rota/tenant";
import { rotaDemand } from "@/db/schema/rota";

// Upserts one day/shift headcount, or — when `applyToWeek` is set — the
// same headcount across all seven days for that shift key (the prototype's
// "copy a day across").
export async function PUT(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const shiftKey = body?.shiftKey;
  const headcount = body?.headcount;
  const applyToWeek = body?.applyToWeek === true;
  const days: number[] = applyToWeek ? [0, 1, 2, 3, 4, 5, 6] : [body?.day];

  if (
    typeof shiftKey !== "string" ||
    !Number.isInteger(headcount) ||
    headcount < 0 ||
    days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)
  ) {
    return NextResponse.json({ error: "Invalid body." }, { status: 400 });
  }

  const tenant = await getDefaultTenant();

  await withTenant(tenant.id, async (tx) => {
    for (const day of days) {
      await tx
        .insert(rotaDemand)
        .values({ tenantId: tenant.id, dayOfWeek: day, shiftKey, headcount })
        .onConflictDoUpdate({
          target: [rotaDemand.tenantId, rotaDemand.dayOfWeek, rotaDemand.shiftKey],
          set: { headcount },
        });
    }
  });

  return NextResponse.json({ ok: true });
}
