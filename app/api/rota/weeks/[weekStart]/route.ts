import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { withTenant } from "@/lib/db/client";
import { getDefaultTenant } from "@/lib/rota/tenant";
import { rotaWeeks, rotaAssignments } from "@/db/schema/rota";
import type { AssignmentMap, AssignmentValue, UnfilledEntry, WeekData } from "@/lib/rota/types";

function isValidWeekStart(weekStart: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(weekStart);
}

async function loadWeek(tenantId: string, weekStart: string): Promise<WeekData> {
  return withTenant(tenantId, async (tx) => {
    const [week] = await tx.select().from(rotaWeeks).where(eq(rotaWeeks.weekStart, weekStart)).limit(1);
    if (!week) {
      return { weekStart, built: false, onCallStaffId: null, unfilled: [], assignments: {} };
    }

    const rows = await tx.select().from(rotaAssignments).where(eq(rotaAssignments.weekId, week.id));
    const assignments: AssignmentMap = {};
    for (const row of rows) {
      const key = `${row.staffId}|${row.dayOfWeek}`;
      assignments[key] =
        row.kind === "shift"
          ? { kind: "shift", shiftKey: row.shiftKey!, sleepover: row.sleepover, locked: row.locked }
          : { kind: "code", code: row.code!, locked: row.locked };
    }

    return {
      weekStart,
      built: week.built,
      onCallStaffId: week.onCallStaffId,
      unfilled: week.unfilled as UnfilledEntry[],
      assignments,
    };
  });
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ weekStart: string }> }) {
  const { weekStart } = await params;
  if (!isValidWeekStart(weekStart)) return NextResponse.json({ error: "Invalid week." }, { status: 400 });

  const tenant = await getDefaultTenant();
  return NextResponse.json(await loadWeek(tenant.id, weekStart));
}

interface CellEdit {
  staffId: string;
  day: number;
  value: AssignmentValue | null;
}

// Manual edits: single-cell writes/deletes, on-call, unlock-all. Never
// touches other cells — a full rebuild is a separate endpoint.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ weekStart: string }> }) {
  const { weekStart } = await params;
  if (!isValidWeekStart(weekStart)) return NextResponse.json({ error: "Invalid week." }, { status: 400 });

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Invalid body." }, { status: 400 });

  const cell: CellEdit | undefined = body.cell;
  if (cell && (typeof cell.staffId !== "string" || !Number.isInteger(cell.day) || cell.day < 0 || cell.day > 6)) {
    return NextResponse.json({ error: "Invalid cell edit." }, { status: 400 });
  }

  const tenant = await getDefaultTenant();

  await withTenant(tenant.id, async (tx) => {
    const [existingWeek] = await tx.select().from(rotaWeeks).where(eq(rotaWeeks.weekStart, weekStart)).limit(1);
    const week = existingWeek ?? (await tx.insert(rotaWeeks).values({ tenantId: tenant.id, weekStart }).returning())[0];

    if ("onCallStaffId" in body) {
      await tx
        .update(rotaWeeks)
        .set({ onCallStaffId: body.onCallStaffId || null, updatedAt: new Date() })
        .where(eq(rotaWeeks.id, week.id));
    }

    if (body.unlockAll === true) {
      await tx.update(rotaAssignments).set({ locked: false, updatedAt: new Date() }).where(eq(rotaAssignments.weekId, week.id));
    }

    if (cell) {
      if (cell.value === null) {
        await tx
          .delete(rotaAssignments)
          .where(and(eq(rotaAssignments.weekId, week.id), eq(rotaAssignments.staffId, cell.staffId), eq(rotaAssignments.dayOfWeek, cell.day)));
      } else {
        const v = cell.value;
        const row =
          v.kind === "shift"
            ? { kind: "shift" as const, shiftKey: v.shiftKey, sleepover: v.sleepover, code: null, locked: v.locked }
            : { kind: "code" as const, shiftKey: null, sleepover: false, code: v.code, locked: v.locked };

        await tx
          .insert(rotaAssignments)
          .values({ tenantId: tenant.id, weekId: week.id, staffId: cell.staffId, dayOfWeek: cell.day, ...row })
          .onConflictDoUpdate({
            target: [rotaAssignments.weekId, rotaAssignments.staffId, rotaAssignments.dayOfWeek],
            set: { ...row, updatedAt: new Date() },
          });
      }
    }
  });

  return NextResponse.json(await loadWeek(tenant.id, weekStart));
}
