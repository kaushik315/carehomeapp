import { NextRequest, NextResponse } from "next/server";
import { withTenant } from "@/lib/db/client";
import { getDefaultTenant } from "@/lib/rota/tenant";
import { rotaFixedPatterns } from "@/db/schema/rota";

// Upserts one staff/day fixed-pattern cell, or — when `applyToWeek` is set —
// the same kind across all seven days. Mirrors availability/route.ts.
export async function PUT(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const staffId = body?.staffId;
  const kind = body?.kind;
  const shiftKey = typeof body?.shiftKey === "string" ? body.shiftKey : null;
  const code = typeof body?.code === "string" ? body.code : null;
  const applyToWeek = body?.applyToWeek === true;
  const days: number[] = applyToWeek ? [0, 1, 2, 3, 4, 5, 6] : [body?.day];

  const validKind = kind === "shift" ? Boolean(shiftKey) : kind === "code" ? Boolean(code) : false;
  if (typeof staffId !== "string" || !validKind || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    return NextResponse.json({ error: "Invalid body." }, { status: 400 });
  }

  const tenant = await getDefaultTenant();

  await withTenant(tenant.id, async (tx) => {
    for (const day of days) {
      await tx
        .insert(rotaFixedPatterns)
        .values({
          tenantId: tenant.id,
          staffId,
          dayOfWeek: day,
          kind,
          shiftKey: kind === "shift" ? shiftKey : null,
          code: kind === "code" ? code : null,
        })
        .onConflictDoUpdate({
          target: [rotaFixedPatterns.staffId, rotaFixedPatterns.dayOfWeek],
          set: { kind, shiftKey: kind === "shift" ? shiftKey : null, code: kind === "code" ? code : null, updatedAt: new Date() },
        });
    }
  });

  return NextResponse.json({ ok: true });
}
