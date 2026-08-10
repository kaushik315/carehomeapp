import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import * as foundation from "@/db/schema/foundation";
import * as rota from "@/db/schema/rota";

const schema = { ...foundation, ...rota };
type Db = ReturnType<typeof drizzle<typeof schema>>;

// Lazy on purpose: Next.js imports every route module during the build's
// "Collecting page data" step, before any request runs and before
// deployment envs are necessarily available. Connecting (or throwing on a
// missing DATABASE_URL) at module load time breaks the build itself.
let _db: Db | undefined;

function getDb(): Db {
  if (_db) return _db;
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set — see .env.example");
  }
  const queryClient = postgres(process.env.DATABASE_URL);
  _db = drizzle(queryClient, { schema });
  return _db;
}

export const db: Db = new Proxy({} as Db, {
  get(_target, prop, receiver) {
    const real = getDb() as unknown as Record<string | symbol, unknown>;
    const value = Reflect.get(real, prop, receiver);
    return typeof value === "function" ? value.bind(real) : value;
  },
});

/**
 * Every query path must set app.tenant_id — RLS is the backstop for
 * scoping bugs, not a substitute for scoping. Run tenant-owned queries
 * inside this helper rather than against `db` directly.
 */
export async function withTenant<T>(
  tenantId: string,
  fn: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    // SET doesn't accept bind parameters — set_config() does, and stays injection-safe.
    await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}
