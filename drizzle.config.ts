// Used only by `drizzle-kit studio` (browsing data). Migrations are
// hand-written SQL applied via db/migrate.ts, not drizzle-kit generate/push —
// see the note at the top of db/schema/foundation.ts.
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./db/schema/*.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
});
