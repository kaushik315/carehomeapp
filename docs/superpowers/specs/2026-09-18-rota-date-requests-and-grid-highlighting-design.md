# Rota: one-off date requests + unfilled-slot grid highlighting

Status: approved design, awaiting implementation plan.

## Context

Two changes to the rota module (`app/rota/page.tsx`, `/api/rota/*`, `lib/rota/*`,
`db/migrations/0002_rota.sql`):

1. When the generator can't fill a slot, the only signal today is the banner
   above the grid (`RotaTab` in `app/rota/page.tsx`). Sumy has to cross-reference
   the banner text against the grid by eye. Make the affected day visible in the
   grid itself, and make the banner clickable so it jumps to the day.
2. Availability today is a recurring weekly pattern (`rota_availability`, one row
   per staff per day-of-week). There's no way to record "this person wants this
   specific date off" or "wants this shift on this date" without it being a
   permanent weekly change. Add that, tied to a calendar date, with date-off as a
   hard rule and date-shift as a strong soft preference — and show it on the grid.

## Decisions

- New "Requests" tab, same visual pattern as the existing "Who can work when" tab.
- A request carries an optional free-text note (e.g. "dentist appointment").
- A date-off request added against an already-built, locked week is **flagged,
  not auto-resolved** — the grid shows a conflict, the assignment is left alone.
  Sumy resolves it by hand (unlock/edit the cell), same as any other manual
  override.
- A date-shift request specifies an exact shift key, chosen manually from the
  tenant's shift list — same as the existing "only certain shifts" availability
  mode, not a generic "wants to work" flag.
- Requests are plain mutable rows (edit/delete freely), not append-only — this is
  operational scheduling data, the same tier as `rota_assignments`, not a legal
  care record under `entries`. Past-dated requests are left in place, shown
  dimmed; there is no cleanup job.

## Data model

New migration `db/migrations/0003_rota_date_requests.sql`, following the pattern
in `0002_rota.sql` (tenant_id, RLS `tenant_isolation` policy, commented
deploy-time grant note):

```sql
CREATE TABLE rota_date_requests (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    staff_id     uuid NOT NULL REFERENCES rota_staff(id) ON DELETE CASCADE,
    request_date date NOT NULL,
    kind         text NOT NULL CHECK (kind IN ('off', 'shift')),
    shift_key    text,          -- required when kind='shift', null when 'off'
    note         text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    CHECK ((kind = 'off' AND shift_key IS NULL) OR (kind = 'shift' AND shift_key IS NOT NULL)),
    UNIQUE (staff_id, request_date)
);
CREATE INDEX rota_date_requests_tenant_date_idx ON rota_date_requests (tenant_id, request_date);

ALTER TABLE rota_date_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON rota_date_requests
    USING (tenant_id = current_setting('app.tenant_id')::uuid);
```

One request per staff per date (`UNIQUE (staff_id, request_date)`) — editing a
request changes the existing row's kind/shift_key/note rather than creating a
second row for the same date. `shift_key` is a plain string, not a foreign key,
matching how `rota_demand.shift_key` and `rota_availability.shift_keys` already
reference shift keys loosely.

`db/schema/rota.ts` gets a matching `rotaDateRequests` Drizzle table.

## Types (`lib/rota/types.ts`)

```ts
export type DateRequestKind = "off" | "shift";

export interface DateRequest {
  id: string;
  staffId: string;
  date: string; // YYYY-MM-DD
  kind: DateRequestKind;
  shiftKey: string | null;
  note: string | null;
}
```

- `RotaConfig` gains `dateRequests: DateRequest[]` (tenant-wide, all staff, all
  dates — the client already loads all of config up front).
- `WeekData` gains `dateRequests: Record<string, { kind: DateRequestKind; shiftKey: string | null; note: string | null }>`, keyed `${staffId}|${day}` (day 0–6
  within that specific built/viewed week) — this is the per-week, day-indexed
  projection used by both the generator and the grid.

## Generator (`lib/rota/generator.ts`)

`GenerateRotaInput` gains `dateRequests: Record<string, { kind: "off" | "shift"; shiftKey: string | null }>`, keyed the same way as `availability` and
`locked` (`${staffId}|${day}`). The generator stays date-agnostic; converting an
absolute `request_date` to a day-of-week for a specific week happens in the API
layer (see below), not in the generator.

- `reject()`: check `dateRequests[`${s.id}|${day}`]` **before** the weekly
  `availability` check. `kind === "off"` → return `"asked this date off"`. This
  is a hard block regardless of what the weekly pattern says for that day —
  matches "the generator must treat a date-off request as a hard rule."
- `score()`: if `kind === "shift" && shiftKey === sh.key`, subtract a bonus
  larger than the existing weekly "only certain shifts" preference (currently
  `-6`) — use `-10` — so a one-off request outranks the standing weekly pattern
  when the two point at different shifts. This is "a strong soft preference,"
  not a hard rule: it does not appear in `reject()` and never produces an
  unfilled slot by itself.
- No change needed to unfilled reporting — `"asked this date off"` flows into
  `unfilled[].reasons` through the existing `reasons` accumulation in `reject()`
  callers.

Edge case (documented, not specially handled): if the weekly pattern already
marks someone `off` that day, a one-off *shift* request cannot override it —
weekly `off` still rejects first. Only a one-off `off` request overrides the
weekly pattern; a one-off `shift` request only ever competes among the
candidates who already pass the hard checks.

## API

- `lib/rota/requests.ts` (new): `loadDateRequestsForWeek(tx, tenantId, weekStart)`
  — queries `rota_date_requests` for the 7 dates of that week, returns them keyed
  `${staffId}|${day}` (day-of-week 0–6 relative to `weekStart`). Shared by the
  build route and the week GET/PATCH route so the date→day-of-week conversion
  lives in one place.
- `GET /api/rota/config` — add `dateRequests: DateRequest[]` to the response
  (all requests, tenant-wide, for the Requests tab and for cross-referencing).
- `POST /api/rota/requests` (new file `app/api/rota/requests/route.ts`) — body
  `{ staffId, date, kind, shiftKey?, note? }`; upserts on the
  `(staff_id, request_date)` conflict target, same `onConflictDoUpdate` shape as
  `app/api/rota/availability/route.ts`.
- `PATCH /api/rota/requests/[id]` (new file
  `app/api/rota/requests/[id]/route.ts`) — edits `kind`/`shiftKey`/`note` on an
  existing row (mirrors `app/api/rota/staff/[id]/route.ts`'s PATCH shape).
- `DELETE /api/rota/requests/[id]` — same file, removes the row.
- `weeks/[weekStart]/build/route.ts` — calls `loadDateRequestsForWeek`, passes
  the result as `dateRequests` into `generateRota`, and includes it on the
  returned `WeekData`.
- `weeks/[weekStart]/route.ts`'s `loadWeek()` — calls the same helper so
  `dateRequests` is present on plain GET/PATCH responses too, independent of
  whether a build just ran.

All new/changed queries go through `withTenant`, matching every existing rota
route.

## UI — grid highlighting + clickable banner (change 1)

In `RotaTab` (`app/rota/page.tsx`):

- `const unfilledDays = new Set(week.unfilled.map(u => u.day))`.
- Each day's `<th>` in the table header, and every `<td>` in that day's column
  (one per staff row), gets a light red background wash when `unfilledDays.has(d)`
  — a full-column highlight, not just the header cell.
- Each day header gets `id={`day-col-${d}`}` plus a visually-hidden (but
  focusable) button inside it.
- Each row in the unfilled banner becomes a `<button>` (currently a `<div>`).
  `onClick` calls `document.getElementById(`day-col-${u.day}`)?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" })`, then `.focus()`s that
  day's hidden button — giving a visible focus ring on the exact column. No new
  React state needed for this.

## UI — Requests tab (change 2)

New fourth tab in the existing tab bar (`rota` / `availability` / `cover` / now
`requests`), same card-per-staff-member layout as `AvailabilityTab`:

- Each staff card lists their existing requests, sorted by date ascending, past
  dates rendered at reduced opacity (no auto-removal).
- Each request row: date, Off/Shift + shift name if applicable, note if present,
  a delete button, and click-to-edit-inline (clicking the row swaps it into the
  same add-row form, pre-filled, with Save replacing Add).
- An add-row per card: date input, Off/Shift toggle, shift picker (shown only
  when Shift is selected, from `config.shifts`), optional note text input, Add
  button. Submits via `POST /api/rota/requests`; edits via `PATCH`; deletes via
  `DELETE`.

On the Rota grid, `Cell` gets an optional request indicator, read from
`week.dateRequests[`${staffId}|${day}`]`:

- `kind === "off"` and the cell holds no shift assignment: a small badge
  (distinct icon/position from the existing lock badge) reading as "asked this
  date off," with the note as a tooltip if present.
- `kind === "off"` **and** the cell holds a `shift` assignment: this is the
  conflict case — render a red cell border instead of the plain badge, so it's
  visible without opening anything. Derived entirely client-side from data
  already on the page; no new backend field.
- `kind === "shift"`: a small badge indicating the requested shift, shown
  whether or not that's what they were actually assigned (so it's clear when the
  preference wasn't honoured).

## Testing

- Generator unit tests (extend whatever covers `lib/rota/generator.ts` today, or
  add if none exist): a date-off request blocks assignment even when weekly
  availability is `any`; a date-shift request changes which candidate wins when
  scores would otherwise be close; a date-off request produces an
  `"asked this date off"` unfilled reason when it's the only reason a slot can't
  be filled.
- Manual check in the browser: add a date-off request for someone already
  locked into a shift that week, confirm the cell shows the conflict border and
  nothing is silently changed; build a week with an unfillable slot, confirm the
  column highlights and the banner entry scrolls/focuses it.

## Out of scope

- No date ranges — one request per specific date, matching "this specific
  date" in the request.
- No notifications/alerts when a request is added against a built week beyond
  the grid conflict indicator.
- No archiving or bulk cleanup of past requests.
