-- Rollback for Task 6.6 (per-tenant SMS + NOT NULL on messages.location_id).
--
-- Only the DB side is reversed here. The code side (src/sms.js rewrite) rolls
-- back via git revert. If you revert the code but not this SQL, old sms.js
-- re-introduced via revert will still work — it doesn't touch messages.
--
-- Apply with:
--   railway run bash -c 'psql "$DATABASE_URL" -f scripts/rollback-6.6.sql'

BEGIN;

ALTER TABLE messages ALTER COLUMN location_id DROP NOT NULL;

COMMIT;
