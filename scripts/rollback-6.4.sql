-- Rollback for Task 6.4 (tenant-aware exclusion constraint + NOT NULL flip).
--
-- Safe to run ONLY while 6.4 is the latest applied migration — i.e. no 6.6+
-- code is shipped that depends on the payload's location_id or the
-- tenant-scoped constraint. If you've already flipped NOT NULL on
-- messages/calls in the 24h follow-up deploy, this rollback does NOT reverse
-- those (edit the file if you need to, but we don't expect that scenario).
--
-- Apply with:
--   railway run bash -c 'psql "$DATABASE_URL" -f scripts/rollback-6.4.sql'

BEGIN;

-- Restore the single-tenant exclusion constraint shape.
ALTER TABLE reservations DROP CONSTRAINT IF EXISTS no_double_booking;
ALTER TABLE reservations ADD CONSTRAINT no_double_booking
  EXCLUDE USING gist (
    table_id    WITH =,
    reservation_tsrange(date, time) WITH &&
  ) WHERE (status = 'confirmed');

-- Allow NULL location_id again. Existing non-null values stay; the column is
-- just permissive now.
ALTER TABLE reservations ALTER COLUMN location_id DROP NOT NULL;

-- Restore the date-only index; drop the tenant-scoped one.
DROP INDEX IF EXISTS idx_reservations_location_date;
CREATE INDEX IF NOT EXISTS idx_reservations_date ON reservations (date);

-- NOTIFY function bodies don't need an explicit rollback — the added
-- location_id key is additive and the old handler ignores unknown keys.
-- If you roll back the code deploy, those keys just stop being read.

COMMIT;
