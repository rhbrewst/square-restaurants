-- Rollback for Task 6.2 (additive multi-tenant schema).
--
-- Safe to run against production ONLY while Phase 6.2 is the latest applied
-- migration (i.e. no 6.3+ code is shipped that reads these tables). The old
-- single-tenant code never references `location_id`, `external_provider`, or
-- `external_id`, so dropping them is a clean reversal.
--
-- Apply with:
--   railway run bash -c 'psql "$DATABASE_URL" -f scripts/rollback-6.2.sql'

BEGIN;

ALTER TABLE calls        DROP COLUMN IF EXISTS location_id;
ALTER TABLE messages     DROP COLUMN IF EXISTS location_id;
ALTER TABLE reservations DROP COLUMN IF EXISTS location_id,
                         DROP COLUMN IF EXISTS external_provider,
                         DROP COLUMN IF EXISTS external_id;

DROP INDEX IF EXISTS idx_reservations_external;
DROP INDEX IF EXISTS idx_reservations_location;
DROP INDEX IF EXISTS idx_messages_location;
DROP INDEX IF EXISTS idx_calls_location;

DROP TABLE IF EXISTS location_tables;
DROP TABLE IF EXISTS locations CASCADE;
DROP TABLE IF EXISTS accounts  CASCADE;

DROP FUNCTION IF EXISTS notify_location_updated();

COMMIT;
