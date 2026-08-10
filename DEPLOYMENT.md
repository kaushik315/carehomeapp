# Deploying

The app needs a Postgres database it can reach and three environment
variables. Nothing else is required — schema and first-run data are
applied automatically on deploy.

## Environment variables

Set these three in your host's environment settings. **Never commit them
to the repo** — they are credentials.

| Variable | What it is |
|---|---|
| `DATABASE_URL` | Postgres connection string, e.g. `postgresql://user:password@host/dbname?sslmode=require` |
| `ADMIN_PASSWORD_HASH` | bcrypt hash of the rota builder password. Generate with `npm run hash-password -- "your password"` |
| `ADMIN_SESSION_SECRET` | Random string used to sign the login cookie. Generate with `openssl rand -hex 32` |

`DEFAULT_TENANT_SLUG` is optional and defaults to `linkfield`.

### On Vercel specifically

Vercel keeps a **separate set of variables per environment**. Adding a
variable to Development does nothing for your live site — it must be set
on **Production** (and Preview, if you use preview URLs). Environment
variables are baked in at build time, so **redeploy after changing them**.

For `ADMIN_PASSWORD_HASH`, paste the hash **unescaped** into the Vercel
dashboard. The `\$` escaping that `npm run hash-password` outputs is only
needed for a local `.env.local` file, whose parser expands `$` tokens.

## What happens on deploy

Vercel runs the `vercel-build` script instead of `build`:

```
npm run db:migrate && npm run db:seed && next build
```

- **`db:migrate`** applies anything in `db/migrations/*.sql` not yet
  recorded in `schema_migrations`. Already-applied migrations are skipped,
  so this is safe on every deploy.
- **`db:seed`** loads the Linkfield tenant, shift catalogue and staff list
  **only if that tenant does not exist yet**. On every later deploy it
  stops immediately, so availability, cover numbers and contracts edited
  in the app are never reset. Use `npm run db:seed -- --force` to override.

If `DATABASE_URL` is missing or the database is unreachable, the build
fails with that reason rather than deploying an app that cannot work.

## On-prem (the actual target — see CLAUDE.md)

Vercel is convenient for previewing, but the plan is Docker Compose on a
mini PC in the office. There, Postgres is the `db` service in
`docker-compose.yml` and migrations are run the same way:

```
docker compose up -d
npm run db:migrate
npm run db:seed
npm run build && npm start
```

## Rotating a leaked credential

If a connection string or password is ever exposed, reset it at the source
(Neon: Roles → Reset password), then update `DATABASE_URL` everywhere it is
set and redeploy. Resetting `ADMIN_SESSION_SECRET` immediately logs
everyone out, which is the fastest way to kill active sessions.
