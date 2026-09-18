-- ============================================================
-- Care Records — Migration 0003: Rota staff scheduling mode
-- Postgres 15+. Requires 0002_rota.sql.
--
-- Folds the officeHours special-case into a general per-staff
-- scheduling mode:
--   generated (default) — the solver assigns them, as today.
--   fixed                — a weekly pattern, laid down on every
--                          build; a locked leave override wins;
--                          the solver never picks them.
--   manual               — always left blank for hand-entry; the
--                          solver never picks them.
-- See CLAUDE.md and docs/superpowers/specs/2026-09-18-rota-staff-
-- scheduling-mode-design.md.
-- ============================================================

ALTER TABLE rota_staff ADD COLUMN scheduling_mode text NOT NULL DEFAULT 'generated'
    CHECK (scheduling_mode IN ('generated', 'fixed', 'manual'));

-- Anyone currently on office_hours becomes 'fixed' — same idea, one
-- mechanism instead of two.
UPDATE rota_staff SET scheduling_mode = 'fixed' WHERE office_hours = true;

-- ------------------------------------------------------------
-- FIXED PATTERNS — one row per staff per day-of-week, same shape
-- as an assignment cell (kind + shift_key, or kind + code). Only
-- meaningful for staff with scheduling_mode = 'fixed'.
-- ------------------------------------------------------------
CREATE TABLE rota_fixed_patterns (
    tenant_id   uuid        NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    staff_id    uuid        NOT NULL REFERENCES rota_staff(id) ON DELETE CASCADE,
    day_of_week smallint    NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
    kind        text        NOT NULL CHECK (kind IN ('shift', 'code')),
    shift_key   text,
    code        text,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (staff_id, day_of_week),
    CHECK ((kind = 'shift' AND shift_key IS NOT NULL) OR (kind = 'code' AND code IS NOT NULL))
);

ALTER TABLE rota_fixed_patterns ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON rota_fixed_patterns
    USING (tenant_id = current_setting('app.tenant_id')::uuid);

-- Backfill: replicate the old hardcoded office-hours behaviour (IN
-- Mon-Fri, D/O weekends) as real pattern rows, so migrating anyone
-- who had office_hours = true changes nothing about what they see.
INSERT INTO rota_fixed_patterns (tenant_id, staff_id, day_of_week, kind, code)
SELECT tenant_id, id, d, 'code', CASE WHEN d < 5 THEN 'IN' ELSE 'D/O' END
FROM rota_staff, generate_series(0, 6) AS d
WHERE scheduling_mode = 'fixed';

ALTER TABLE rota_staff DROP COLUMN office_hours;
