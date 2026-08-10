import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { tenants } from "@/db/schema/foundation";

// Single-tenant for now (CLAUDE.md: tenant_id exists everywhere so scaling
// is a deployment change, not a rewrite). Resolved by slug rather than
// hardcoded so a second tenant is a config change later.
export async function getDefaultTenant() {
  const slug = process.env.DEFAULT_TENANT_SLUG ?? "linkfield";
  const [tenant] = await db.select().from(tenants).where(eq(tenants.slug, slug)).limit(1);
  if (!tenant) {
    throw new Error(`No tenant with slug "${slug}" — run npm run db:seed first.`);
  }
  return tenant;
}
