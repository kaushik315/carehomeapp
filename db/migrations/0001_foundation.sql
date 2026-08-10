-- ============================================================
-- Care Records — Migration 0001: Foundation
-- Postgres 15+
--
-- Principles:
--   1. Every tenant-owned row carries tenant_id. No exceptions.
--   2. Care entries are append-only. Corrections supersede, never overwrite.
--   3. Every read and write of resident data is audited.
--   4. Record types are configuration, not code.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "citext";     -- case-insensitive email

-- ------------------------------------------------------------
-- TENANTS
-- One row per care home (or per provider group, if they own several).
-- Single row for now. The column exists everywhere so scaling
-- is a deployment change, not a rewrite.
-- ------------------------------------------------------------
CREATE TABLE tenants (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name                text        NOT NULL,
    slug                text        NOT NULL UNIQUE,   -- url/config key, e.g. 'lochview'
    regulator           text        NOT NULL DEFAULT 'care_inspectorate'
                                    CHECK (regulator IN ('care_inspectorate', 'cqc', 'ciw', 'rqia')),
    timezone            text        NOT NULL DEFAULT 'Europe/London',
    -- Retention clock: years after a resident's discharge/death before purge.
    retention_years     smallint    NOT NULL DEFAULT 10 CHECK (retention_years BETWEEN 1 AND 50),
    settings            jsonb       NOT NULL DEFAULT '{}'::jsonb,
    is_active           boolean     NOT NULL DEFAULT true,
    created_at          timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- UNITS  (wings / floors / households)
-- Drives who sees which residents. Small homes may have exactly one.
-- ------------------------------------------------------------
CREATE TABLE units (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid        NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    name        text        NOT NULL,
    is_active   boolean     NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, name)
);

-- ------------------------------------------------------------
-- USERS
--
-- Two credentials by design:
--   password_hash — full login (managers, office, own device)
--   pin_hash      — fast re-auth on a shared floor tablet
-- The PIN is NOT a password. It is a second factor on an already
-- device-bound session. Never allow PIN-only login from a new device.
--
-- Users are never deleted — they are named in legal records forever.
-- Deactivate instead.
-- ------------------------------------------------------------
CREATE TABLE users (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid        NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    email           citext,                       -- nullable: floor staff may have none
    display_name    text        NOT NULL,         -- as it should appear on a care record
    job_title       text,
    password_hash   text,
    pin_hash        text,
    role            text        NOT NULL
                                CHECK (role IN ('carer', 'senior', 'manager', 'admin')),
    is_active       boolean     NOT NULL DEFAULT true,
    last_login_at   timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, email)
);
CREATE INDEX users_tenant_active_idx ON users (tenant_id) WHERE is_active;

-- Which units a user may work in. No rows = all units (typical for managers).
CREATE TABLE user_units (
    user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    unit_id     uuid NOT NULL REFERENCES units(id) ON DELETE CASCADE,
    tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    PRIMARY KEY (user_id, unit_id)
);

-- ------------------------------------------------------------
-- RESIDENTS
--
-- Minimal identifying data only. Care detail lives in entries.
-- status drives the retention clock.
-- ------------------------------------------------------------
CREATE TABLE residents (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid        NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    unit_id         uuid        REFERENCES units(id) ON DELETE SET NULL,
    reference       text,                          -- home's own resident/room number
    first_name      text        NOT NULL,
    last_name       text        NOT NULL,
    preferred_name  text,                          -- what staff actually call them
    date_of_birth   date        NOT NULL,
    room            text,
    status          text        NOT NULL DEFAULT 'active'
                                CHECK (status IN ('active', 'discharged', 'deceased')),
    admitted_on     date        NOT NULL,
    departed_on     date,                          -- discharge or death
    -- Computed purge date. Nothing is auto-deleted; this drives a review report.
    purge_after     date GENERATED ALWAYS AS (departed_on + INTERVAL '10 years') STORED,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CHECK (status = 'active' OR departed_on IS NOT NULL),
    UNIQUE (tenant_id, reference)
);
CREATE INDEX residents_tenant_unit_idx ON residents (tenant_id, unit_id) WHERE status = 'active';

-- ------------------------------------------------------------
-- RECORD TYPES  — the modularity layer
--
-- A record type is a form definition stored as data:
--   personal care, food & fluid, continence, repositioning,
--   incidents, body map, night check...
--
-- form_schema is a JSON Schema describing fields, types, options,
-- validation and display order. New client with different paperwork
-- = new rows here, not new code.
--
-- VERSIONING IS LOAD-BEARING. An entry recorded in 2026 must always
-- render against the schema that was live in 2026. Never edit a
-- published version — supersede it with a new one.
-- ------------------------------------------------------------
CREATE TABLE record_types (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid        NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    key             text        NOT NULL,          -- stable code, e.g. 'personal_care'
    name            text        NOT NULL,          -- label shown to staff
    description     text,
    icon            text,
    category        text,                          -- grouping in the UI
    sort_order      smallint    NOT NULL DEFAULT 0,
    is_active       boolean     NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, key)
);

CREATE TABLE record_type_versions (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid        NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    record_type_id  uuid        NOT NULL REFERENCES record_types(id) ON DELETE RESTRICT,
    version         integer     NOT NULL,
    form_schema     jsonb       NOT NULL,
    ui_schema       jsonb       NOT NULL DEFAULT '{}'::jsonb,   -- layout hints only
    published_at    timestamptz,
    retired_at      timestamptz,
    created_by      uuid        NOT NULL REFERENCES users(id),
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (record_type_id, version)
);
-- Only one live version per record type.
CREATE UNIQUE INDEX record_type_live_idx
    ON record_type_versions (record_type_id)
    WHERE published_at IS NOT NULL AND retired_at IS NULL;

-- ------------------------------------------------------------
-- ENTRIES  — the care records themselves. APPEND ONLY.
--
-- Time is recorded twice on purpose:
--   occurred_at — when the care actually happened
--   created_at  — when it was typed in
-- A large gap between them is a late entry. Inspectors look for this,
-- so it must be visible, not hidden.
--
-- Corrections: insert a new entry with supersedes_id pointing at the
-- original. The original is never touched. Reads show the latest in
-- the chain, with the history available.
--
-- client_uuid makes offline sync idempotent — a tablet that submits
-- twice after reconnecting creates one row, not two.
-- ------------------------------------------------------------
CREATE TABLE entries (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid        NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    resident_id         uuid        NOT NULL REFERENCES residents(id) ON DELETE RESTRICT,
    record_type_id      uuid        NOT NULL REFERENCES record_types(id) ON DELETE RESTRICT,
    schema_version_id   uuid        NOT NULL REFERENCES record_type_versions(id) ON DELETE RESTRICT,

    data                jsonb       NOT NULL,      -- validated against form_schema on write

    occurred_at         timestamptz NOT NULL,
    recorded_by         uuid        NOT NULL REFERENCES users(id),
    -- Snapshot of the author's name at time of writing. If they later
    -- marry and change name, the historic record must not silently change.
    recorded_by_name    text        NOT NULL,
    unit_id             uuid        REFERENCES units(id),

    -- Correction chain
    supersedes_id       uuid        REFERENCES entries(id),
    superseded_by_id    uuid        REFERENCES entries(id),
    correction_reason   text,

    client_uuid         uuid        NOT NULL,      -- generated on the device
    created_at          timestamptz NOT NULL DEFAULT now(),

    CHECK (supersedes_id IS NULL OR correction_reason IS NOT NULL),
    CHECK (occurred_at <= created_at + INTERVAL '5 minutes'),  -- no future-dating
    UNIQUE (tenant_id, client_uuid)
);

-- The hot query: one resident's timeline for a shift.
CREATE INDEX entries_resident_time_idx
    ON entries (tenant_id, resident_id, occurred_at DESC)
    WHERE superseded_by_id IS NULL;

-- Handover / unit view.
CREATE INDEX entries_unit_time_idx
    ON entries (tenant_id, unit_id, occurred_at DESC)
    WHERE superseded_by_id IS NULL;

CREATE INDEX entries_type_time_idx ON entries (tenant_id, record_type_id, occurred_at DESC);
CREATE INDEX entries_data_gin_idx  ON entries USING gin (data jsonb_path_ops);

-- --- Append-only enforcement -------------------------------------------------
-- Belt and braces: a trigger, plus revoked grants below. The application
-- role must never hold UPDATE or DELETE on this table.
CREATE OR REPLACE FUNCTION entries_append_only() RETURNS trigger AS $$
BEGIN
    IF (TG_OP = 'DELETE') THEN
        RAISE EXCEPTION 'entries is append-only: DELETE is not permitted';
    END IF;
    -- The single allowed mutation: linking an entry to its correction.
    IF (OLD.superseded_by_id IS NULL AND NEW.superseded_by_id IS NOT NULL
        AND to_jsonb(NEW) - 'superseded_by_id' = to_jsonb(OLD) - 'superseded_by_id') THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'entries is append-only: create a superseding entry instead';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER entries_append_only_trg
    BEFORE UPDATE OR DELETE ON entries
    FOR EACH ROW EXECUTE FUNCTION entries_append_only();

-- ------------------------------------------------------------
-- AUDIT LOG
--
-- Includes READS. "Who looked at Mrs Bennett's records at 3am"
-- is a question you will one day be asked, and being unable to
-- answer it is itself a finding.
--
-- Will get large. Partition by month once it hurts (~year 2).
-- ------------------------------------------------------------
CREATE TABLE audit_log (
    id              bigserial PRIMARY KEY,
    tenant_id       uuid        NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    actor_id        uuid        REFERENCES users(id),      -- null = system job
    actor_name      text,
    action          text        NOT NULL
                                CHECK (action IN ('read', 'create', 'correct', 'login',
                                                  'login_failed', 'logout', 'export',
                                                  'config_change', 'user_change', 'purge')),
    entity_type     text        NOT NULL,                  -- 'entry', 'resident', 'user', ...
    entity_id       uuid,
    resident_id     uuid        REFERENCES residents(id),  -- denormalised for fast lookup
    detail          jsonb       NOT NULL DEFAULT '{}'::jsonb,
    ip_address      inet,
    device_label    text,                                  -- 'Floor 1 tablet'
    occurred_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_tenant_time_idx    ON audit_log (tenant_id, occurred_at DESC);
CREATE INDEX audit_resident_time_idx  ON audit_log (tenant_id, resident_id, occurred_at DESC);
CREATE INDEX audit_actor_time_idx     ON audit_log (tenant_id, actor_id, occurred_at DESC);

CREATE OR REPLACE FUNCTION audit_immutable() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'audit_log is immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_immutable_trg
    BEFORE UPDATE OR DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION audit_immutable();

-- ------------------------------------------------------------
-- SESSIONS
-- Short-lived on shared devices, longer on trusted personal ones.
-- ------------------------------------------------------------
CREATE TABLE sessions (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid        NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    user_id         uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash      text        NOT NULL UNIQUE,
    device_label    text,
    is_shared_device boolean    NOT NULL DEFAULT false,
    expires_at      timestamptz NOT NULL,
    revoked_at      timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;

-- ------------------------------------------------------------
-- ROW LEVEL SECURITY
--
-- The real defence against a tenant-scoping bug in application code.
-- Set once per request:  SET LOCAL app.tenant_id = '<uuid>';
-- Enable now, while there is one tenant and mistakes are cheap.
-- ------------------------------------------------------------
ALTER TABLE units                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE users                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_units            ENABLE ROW LEVEL SECURITY;
ALTER TABLE residents             ENABLE ROW LEVEL SECURITY;
ALTER TABLE record_types          ENABLE ROW LEVEL SECURITY;
ALTER TABLE record_type_versions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE entries               ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log             ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions              ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['units','users','user_units','residents','record_types',
                             'record_type_versions','entries','audit_log','sessions']
    LOOP
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''app.tenant_id'')::uuid)',
            t);
    END LOOP;
END $$;

-- ------------------------------------------------------------
-- APPLICATION ROLE
-- The app connects as this role. It cannot mutate history.
-- ------------------------------------------------------------
-- CREATE ROLE care_app LOGIN PASSWORD '<set at deploy time>';
-- GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO care_app;
-- REVOKE UPDATE, DELETE ON entries   FROM care_app;
-- REVOKE UPDATE, DELETE ON audit_log FROM care_app;
-- GRANT UPDATE (superseded_by_id) ON entries TO care_app;
