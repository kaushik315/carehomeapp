-- ============================================================
-- Care Records — Migration 0004: Rota eligible shifts
-- Postgres 15+. Requires 0003_rota_scheduling_mode.sql.
--
-- Replaces the generator's soft night-shift scoring nudges (WCO
-- bonus, Manager/Deputy penalty) with a hard per-staff eligible-
-- shifts list. See CLAUDE.md and docs/superpowers/specs/2026-09-18-
-- rota-eligible-shifts-design.md.
-- ============================================================

ALTER TABLE rota_staff ADD COLUMN eligible_shifts jsonb NOT NULL DEFAULT '[]'::jsonb;

-- One-time backfill, keyed to Linkfield's real staff: Esther and Ola are
-- night-only; Ayo and Victoria work every shift including night; everyone
-- else gets every active shift except night.
UPDATE rota_staff s
SET eligible_shifts = (
  SELECT COALESCE(jsonb_agg(d.key), '[]'::jsonb)
  FROM rota_shift_definitions d
  WHERE d.tenant_id = s.tenant_id AND d.is_active
    AND CASE
      WHEN s.name IN ('Esther', 'Ola') THEN d.key = 'night'
      WHEN s.name IN ('Ayo', 'Victoria') THEN true
      ELSE d.key <> 'night'
    END
);
