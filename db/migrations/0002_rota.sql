-- ============================================================
-- Care Records — Migration 0002: Rota
-- Postgres 15+. Requires 0001_foundation.sql (tenants, units, users).
--
-- Ports prototypes/rota-builder.jsx onto the real schema. Separate
-- tables, same tenant and RLS pattern as the foundation migration.
--
-- Shift definitions, roles and leave codes are tenant config — the
-- next client will call D/O something else. Availability and demand
-- are a recurring weekly pattern (by day-of-week), same model the
-- prototype uses; a specific week's build lives in rota_weeks /
-- rota_assignments and can be edited and locked on top of that pattern.
-- ============================================================

-- ------------------------------------------------------------
-- SHIFT DEFINITIONS — tenant config
-- e.g. 07:00-15:00 "Early". A shift whose end <= start crosses
-- midnight (night shift); application code adds 24h, same as the
-- prototype.
-- ------------------------------------------------------------
CREATE TABLE rota_shift_definitions (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid        NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    key         text        NOT NULL,          -- stable code, e.g. 'early'
    name        text        NOT NULL,          -- label shown to staff
    start_time  time        NOT NULL,
    end_time    time        NOT NULL,
    sort_order  smallint    NOT NULL DEFAULT 0,
    is_active   boolean     NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, key)
);

-- ------------------------------------------------------------
-- ROTA STAFF
--
-- Deliberately separate from `users`: Kitchen/Dom staff are on the
-- rota but never log into care records, and rota roles (Manager,
-- Deputy, SCO, CO, BCO, WCO, Dom, Kitchen) are a different vocabulary
-- from app permission roles (carer/senior/manager/admin) on `users`.
-- user_id links the two when a rota staff member also has a login.
--
-- Never deleted — deactivate. Same rule as residents and users.
-- ------------------------------------------------------------
CREATE TABLE rota_staff (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid        NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    user_id         uuid        REFERENCES users(id) ON DELETE SET NULL,
    name            text        NOT NULL,
    role            text        NOT NULL,          -- e.g. 'Manager', 'WCO' — tenant vocabulary
    contract_hours  numeric(5,2) NOT NULL DEFAULT 37.5,
    max_days        smallint    NOT NULL DEFAULT 5,
    office_hours    boolean     NOT NULL DEFAULT false,   -- works IN (office hours) rather than shifts
    is_active       boolean     NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rota_staff_tenant_active_idx ON rota_staff (tenant_id) WHERE is_active;

-- ------------------------------------------------------------
-- AVAILABILITY — recurring weekly pattern, one row per staff per
-- day-of-week (0 = Monday .. 6 = Sunday, matching the prototype).
-- mode: 'any' (works any shift), 'shifts' (only shift_keys), 'off'.
-- ------------------------------------------------------------
CREATE TABLE rota_availability (
    tenant_id   uuid        NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    staff_id    uuid        NOT NULL REFERENCES rota_staff(id) ON DELETE CASCADE,
    day_of_week smallint    NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
    mode        text        NOT NULL DEFAULT 'any' CHECK (mode IN ('any', 'shifts', 'off')),
    shift_keys  jsonb       NOT NULL DEFAULT '[]'::jsonb,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (staff_id, day_of_week)
);

-- ------------------------------------------------------------
-- DEMAND — recurring weekly headcount pattern per shift.
-- shift_key 'sleepover' is a virtual key: headcount needed to stay
-- over, not a shift on its own (matches demand.sleepovers in the
-- prototype).
-- ------------------------------------------------------------
CREATE TABLE rota_demand (
    tenant_id   uuid        NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    day_of_week smallint    NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
    shift_key   text        NOT NULL,
    headcount   smallint    NOT NULL DEFAULT 0,
    PRIMARY KEY (tenant_id, day_of_week, shift_key)
);

-- ------------------------------------------------------------
-- WEEKS — one row per built/edited week. unfilled is the "why"
-- report from the last build: never fudge a fill to make the grid
-- look complete, so this is stored, not discarded.
-- ------------------------------------------------------------
CREATE TABLE rota_weeks (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid        NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    week_start      date        NOT NULL,   -- Monday
    on_call_staff_id uuid       REFERENCES rota_staff(id) ON DELETE SET NULL,
    built       boolean     NOT NULL DEFAULT false,
    built_at    timestamptz,
    unfilled    jsonb       NOT NULL DEFAULT '[]'::jsonb,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, week_start)
);

-- ------------------------------------------------------------
-- ASSIGNMENTS — one cell per staff member per day of a built week.
-- kind='shift' points at a shift_key; kind='code' is a leave/office
-- code (D/O, AL, S/O, IN, SL, TR — tenant config in due course).
-- locked cells survive a rebuild.
-- ------------------------------------------------------------
CREATE TABLE rota_assignments (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid        NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    week_id     uuid        NOT NULL REFERENCES rota_weeks(id) ON DELETE CASCADE,
    staff_id    uuid        NOT NULL REFERENCES rota_staff(id) ON DELETE RESTRICT,
    day_of_week smallint    NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
    kind        text        NOT NULL CHECK (kind IN ('shift', 'code')),
    shift_key   text,
    sleepover   boolean     NOT NULL DEFAULT false,
    code        text,
    locked      boolean     NOT NULL DEFAULT false,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CHECK ((kind = 'shift' AND shift_key IS NOT NULL) OR (kind = 'code' AND code IS NOT NULL)),
    UNIQUE (week_id, staff_id, day_of_week)
);
CREATE INDEX rota_assignments_week_idx ON rota_assignments (tenant_id, week_id);

-- ------------------------------------------------------------
-- ROW LEVEL SECURITY — same pattern as 0001_foundation.sql.
-- ------------------------------------------------------------
ALTER TABLE rota_shift_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE rota_staff             ENABLE ROW LEVEL SECURITY;
ALTER TABLE rota_availability      ENABLE ROW LEVEL SECURITY;
ALTER TABLE rota_demand            ENABLE ROW LEVEL SECURITY;
ALTER TABLE rota_weeks             ENABLE ROW LEVEL SECURITY;
ALTER TABLE rota_assignments       ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['rota_shift_definitions', 'rota_staff', 'rota_availability',
                             'rota_demand', 'rota_weeks', 'rota_assignments']
    LOOP
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''app.tenant_id'')::uuid)',
            t);
    END LOOP;
END $$;

-- care_app grants: no append-only restriction here (unlike entries/audit_log) —
-- rota cells are edited and locked in place by design.
-- GRANT SELECT, INSERT, UPDATE, DELETE ON rota_shift_definitions, rota_staff,
--   rota_availability, rota_demand, rota_weeks, rota_assignments TO care_app;
