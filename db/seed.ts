// First-run seed: the Linkfield tenant, its shift catalogue, and the
// staff/availability/demand from prototypes/rota-builder.jsx's SEED_STAFF,
// so /rota has real data to build a rota against.
//
// Runs on every deploy (see the vercel-build script) but seeds only ONCE:
// if the tenant already exists it stops immediately. Availability, cover
// numbers and contracts are edited in the app, and a redeploy must never
// reset them back to these defaults. Pass --force to seed anyway.
//
// Run with: npm run db:seed
import { eq, and } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { tenants } from "@/db/schema/foundation";
import { rotaShiftDefinitions, rotaStaff, rotaAvailability, rotaDemand } from "@/db/schema/rota";

const TENANT_SLUG = process.env.DEFAULT_TENANT_SLUG ?? "linkfield";

const SHIFTS = [
  { key: "early", name: "Early", startTime: "07:00", endTime: "15:00", sortOrder: 0 },
  { key: "mid", name: "Mid", startTime: "13:00", endTime: "21:00", sortOrder: 1 },
  { key: "back", name: "Back", startTime: "15:00", endTime: "23:00", sortOrder: 2 },
  { key: "night", name: "Night", startTime: "21:00", endTime: "07:00", sortOrder: 3 },
];

// [name, role, contractHours, officeHours]
const SEED_STAFF: [string, string, number, boolean][] = [
  ["Sumy", "Manager", 37.5, true],
  ["Tracey", "Deputy", 37.5, false],
  ["Eliza", "SCO", 37.5, false],
  ["Roma", "CO", 24, false],
  ["Ayo", "CO", 37.5, false],
  ["Olu", "CO", 37.5, false],
  ["Janet", "CO", 30, false],
  ["Vincent", "CO", 18, false],
  ["Kaushik", "CO", 16, false],
  ["Victoria", "CO", 20, false],
  ["Raghul", "BCO", 30, false],
  ["Ola", "BCO", 10, false],
  ["Divin", "BCO", 24, false],
  ["Esther", "WCO", 30, false],
  ["Brian K", "Kitchen", 24, false],
  ["Gail", "Dom", 20, false],
];

// day-of-week: 0 = Monday .. 6 = Sunday, matching the prototype.
function availabilityFor(name: string, role: string, day: number) {
  if (role === "WCO") return { mode: "shifts" as const, shiftKeys: ["night"] };
  if (role === "Deputy") return day < 5 ? { mode: "shifts" as const, shiftKeys: ["early"] } : { mode: "off" as const, shiftKeys: [] };
  if (name === "Vincent" || name === "Kaushik") return day === 0 || day >= 5 ? { mode: "any" as const, shiftKeys: [] } : { mode: "off" as const, shiftKeys: [] };
  if (name === "Ola" && day !== 1) return { mode: "off" as const, shiftKeys: [] };
  return { mode: "any" as const, shiftKeys: [] };
}

const DEMAND = { early: 3, mid: 1, back: 3, night: 1, sleepover: 1 };

async function main() {
  const force = process.argv.includes("--force");

  const existingTenant = await db.select().from(tenants).where(eq(tenants.slug, TENANT_SLUG)).limit(1);
  if (existingTenant.length && !force) {
    console.log(`tenant "${TENANT_SLUG}" already seeded — leaving existing data alone.`);
    process.exit(0);
  }

  const [tenant] = await db
    .insert(tenants)
    .values({ name: "Linkfield Residential Ltd", slug: TENANT_SLUG })
    .onConflictDoUpdate({ target: tenants.slug, set: { name: "Linkfield Residential Ltd" } })
    .returning();
  console.log(`tenant: ${tenant.name} (${tenant.id})`);

  for (const s of SHIFTS) {
    await db
      .insert(rotaShiftDefinitions)
      .values({ tenantId: tenant.id, ...s })
      .onConflictDoUpdate({
        target: [rotaShiftDefinitions.tenantId, rotaShiftDefinitions.key],
        set: { name: s.name, startTime: s.startTime, endTime: s.endTime, sortOrder: s.sortOrder },
      });
  }
  console.log(`shifts: ${SHIFTS.length}`);

  for (const [name, role, contractHours, officeHours] of SEED_STAFF) {
    const existing = await db
      .select({ id: rotaStaff.id })
      .from(rotaStaff)
      .where(and(eq(rotaStaff.tenantId, tenant.id), eq(rotaStaff.name, name)))
      .limit(1);

    const staffId =
      existing[0]?.id ??
      (
        await db
          .insert(rotaStaff)
          .values({
            tenantId: tenant.id,
            name,
            role,
            contractHours: contractHours.toString(),
            officeHours,
            maxDays: 5,
          })
          .returning({ id: rotaStaff.id })
      )[0].id;

    for (let day = 0; day < 7; day++) {
      const av = availabilityFor(name, role, day);
      await db
        .insert(rotaAvailability)
        .values({ tenantId: tenant.id, staffId, dayOfWeek: day, mode: av.mode, shiftKeys: av.shiftKeys })
        .onConflictDoUpdate({
          target: [rotaAvailability.staffId, rotaAvailability.dayOfWeek],
          set: { mode: av.mode, shiftKeys: av.shiftKeys },
        });
    }
  }
  console.log(`staff: ${SEED_STAFF.length}`);

  for (let day = 0; day < 7; day++) {
    for (const [shiftKey, headcount] of Object.entries(DEMAND)) {
      await db
        .insert(rotaDemand)
        .values({ tenantId: tenant.id, dayOfWeek: day, shiftKey, headcount })
        .onConflictDoUpdate({
          target: [rotaDemand.tenantId, rotaDemand.dayOfWeek, rotaDemand.shiftKey],
          set: { headcount },
        });
    }
  }
  console.log("demand: 7 days");

  console.log("done.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
