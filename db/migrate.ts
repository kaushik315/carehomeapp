// Applies db/migrations/*.sql in filename order, tracking what's been
// run in schema_migrations. Migrations here are hand-written (RLS,
// triggers, generated columns) rather than drizzle-kit generated, so
// this replaces `drizzle-kit push` deliberately — see the note at the
// top of db/schema/foundation.ts.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set — see .env.example");

  const sql = postgres(databaseUrl, { max: 1 });
  const migrationsDir = join(import.meta.dirname, "migrations");

  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    text PRIMARY KEY,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `;

  const applied = new Set(
    (await sql`SELECT filename FROM schema_migrations`).map((r) => r.filename as string),
  );

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`skip  ${file} (already applied)`);
      continue;
    }
    const contents = readFileSync(join(migrationsDir, file), "utf8");
    console.log(`apply ${file}`);
    await sql.begin(async (tx) => {
      await tx.unsafe(contents);
      await tx`INSERT INTO schema_migrations (filename) VALUES (${file})`;
    });
  }

  await sql.end();
  console.log("done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
