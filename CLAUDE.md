# Care Home Records & Rota — project brief

Context file for Claude Code. Read this before doing anything in this repo.

---

## What this is

Software for a small independent care home in Scotland, built by a single developer
(currently a care officer at the home) with the intent to sell it to that home first
and then license it to other small providers.

**Goals, in order:**

1. **Short term (0–5 months)** — one home live: Linkfield Residential Ltd. Daily care
   records plus a rota builder. Real staff using it on shift.
2. **Mid term (6–18 months)** — two to three more clients. Requires multi-tenancy to
   actually work, plus DSPT certification, professional indemnity and cyber insurance,
   a DPA template, and a listing on the Digitising Social Care assured supplier list.
3. **Long term** — the obvious choice for small independent homes that Person Centred
   Software and Nourish price out. Not "standardise the sector" — win the underserved end.

**Constraint that shapes everything:** ~9 hours a week of development, one developer,
evenings. Assume 6 productive hours. Prefer boring, well-understood solutions over
clever ones. No architecture that requires a team to maintain.

---

## Decisions already made — do not relitigate these

| Decision | Choice | Why |
|---|---|---|
| Deployment | **Cloud-ready, deployed on-prem** | Client has no budget for hosting. One codebase, no forks. Docker Compose on a mini PC in the office; the same containers run in the cloud later. |
| Multi-tenancy | **`tenant_id` on every table from day one** | Even with one tenant. Retrofitting this is a rewrite. |
| Modularity | **Config-driven, not plugins** | Record types are JSON Schema rows in the database, rendered dynamically. New client with different paperwork = new config rows, not new code. |
| Medication (MAR) | **Out of scope for v1** | Much higher risk tier, slower to validate. Revisit after three clients. |
| Care records | **Append-only** | Legal documents. Corrections supersede, never overwrite. Enforced at the database level, not in application code. |
| Stack | Next.js + TypeScript + PostgreSQL, Drizzle, Auth.js, PWA | Developer already knows it. Familiarity beats optimality at 9h/week. |
| Offline | **PWA with an offline write queue** | The risk is wifi dead spots on the first floor, not internet outage. |
| Backup | **Encrypted offsite backup is mandatory** | Ten years of records on one office PC is one fire from a notifiable incident. This is the only thing that leaves the building. |

### Open items the developer must resolve outside the code

- **IP ownership.** Under UK copyright law, work made in the course of employment
  belongs to the employer by default. Needs written acknowledgement from the home that
  the software is the developer's and they receive a licence. Get it signed before
  commercial work continues.
- **Visa.** Developer is moving to a Health and Care Worker visa (a Skilled Worker
  visa — sponsored for one role, no self-employment). Licensing this to other homes
  needs immigration advice first.

---

## Domain notes

Real vocabulary from the home — use it in the UI, don't invent synonyms:

- **Roles:** Manager, Deputy, SCO (Senior Care Officer), CO (Care Officer),
  BCO (Bank Care Officer), WCO (Waking Night Officer), Dom (Domestic), Kitchen.
- **Rota codes:** `D/O` day off · `AL` annual leave · `S/O` sleepover (stays on site
  until 07:00, paid differently from worked hours — track separately) · `IN` office
  hours · `SL` sick · `TR` training.
- **Shift patterns in use:** 07–15, 07–13, 08–16, 10–18, 13–21, 13–19, 14–21, 15–23,
  15–21, 18–23, 21–07.
- The paper rota has an **on-call** name at the bottom. Keep it.

---

## Repo contents

- `db/migrations/0001_foundation.sql` — the schema. Read it before touching data code.
- `prototypes/rota-builder.jsx` — working rota generator prototype (React, in-browser
  storage). Reference for behaviour and UI, not production code.
- `prototypes/rota.jsx` — earlier read/edit rota grid with an hour-by-hour cover ribbon.
  The ribbon is worth porting.

### Schema principles to preserve

1. Every tenant-owned row carries `tenant_id`. Row-level security is on already.
2. `entries` is append-only — trigger plus revoked `UPDATE`/`DELETE` grants. The app
   role holds `UPDATE` on `superseded_by_id` only.
3. `audit_log` records **reads** of resident data, not just writes. It is immutable.
4. Entries store `occurred_at` (when care happened) and `created_at` (when it was
   typed). The gap is a late entry — surface it, never collapse the two.
5. `recorded_by_name` is snapshotted at write time. If a carer changes their surname,
   historic records must not silently change.
6. Published `record_type_versions` are immutable. An entry points at the exact form
   version it was recorded against, so a 2029 config change can't alter what a 2026
   record appears to say.
7. Staff and residents are never deleted. Deactivate.

---

## Rota generator — how it works

Availability and required cover in, rota out, manual overrides on top.

**Hard rules — never broken. An unfillable slot is left open and reported.**
- Staff marked unavailable, on leave, or already assigned that day
- Under 11 hours rest between consecutive shifts (Working Time Regulations)
- Over their maximum consecutive days
- Over `min(48, contract × 1.25)` hours in the week

**Soft rules — scored, lower is better.**
- Strongly prefer whoever is furthest below contracted hours
- Match requested shift types
- Nights to WCO; heavily penalise nights for Manager/Deputy
- Keep blocks of days together rather than scattering single shifts
- Spread weekends across the team
- Use bank staff last

**Non-negotiable behaviour:** when a slot cannot be filled, report *why*, broken down
by reason and count. An auto-scheduler that quietly under-staffs a night shift is worse
than paper. Never fudge a fill to make the grid look complete.

**Overrides:** any cell can be edited and locked; a rebuild works around locked cells.
Leave locks itself automatically.

---

## What to build next, in order

1. **Server-side validation of `entries.data` against `form_schema`.** Never trust the
   client. This gates everything else.
2. **Dynamic form renderer** — turns a `record_type_versions.form_schema` row into a
   working screen. This plus (1) is the actual product.
3. **Auth** — PIN fast re-auth on shared floor tablets, full password login on personal
   devices. PIN is never sufficient from a new device.
4. **Offline write queue** with `client_uuid` idempotency, already in the schema.
5. **Rota module** — port the prototype onto the real schema. Separate tables, same
   tenant and config patterns. Shift definitions and codes become tenant config; the
   next client will call `D/O` something else.
6. **Handover / shift summary view** — the screen carers will actually open most.

---

## House rules for working in this repo

- Read `0001_foundation.sql` before writing any query or migration.
- Never write raw `UPDATE` or `DELETE` against `entries` or `audit_log`.
- Every query path sets `app.tenant_id` — RLS is the backstop for scoping bugs, not
  a substitute for scoping.
- Write for a solo maintainer with six hours a week. If a change needs a diagram to
  explain, it is probably too clever.
- UI copy: plain verbs, sentence case, name things the way care staff name them.
  A carer records care; they do not "submit an entry".
