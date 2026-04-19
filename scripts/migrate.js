#!/usr/bin/env node
/**
 * Database migration — idempotent, safe to re-run.
 *
 * Usage:
 *   node scripts/migrate.js
 *   DATABASE_URL=<url> node scripts/migrate.js   # against a specific database
 */

require('dotenv').config();
const pool = require('../src/db');

const DDL = `
-- ─────────────────────────────────────────────────────────────────────────────
-- Extensions
-- ─────────────────────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "btree_gist"; -- required for tsrange exclusion constraints
CREATE EXTENSION IF NOT EXISTS "pg_trgm";    -- fuzzy name search on reservations

-- ─────────────────────────────────────────────────────────────────────────────
-- IMMUTABLE helper required by the no_double_booking exclusion constraint.
-- Postgres requires all index expressions to be IMMUTABLE; this is safe
-- because date + time arithmetic is fully deterministic.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION reservation_tsrange(d DATE, t TIME)
RETURNS tsrange LANGUAGE sql IMMUTABLE AS $$
  SELECT tsrange(
    (d::text || ' ' || t::text)::timestamp,
    (d::text || ' ' || t::text)::timestamp + interval '90 minutes',
    '[)'
  )
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- RESERVATIONS
-- The exclusion constraint (no_double_booking) makes it physically impossible
-- to double-book a table. It operates at the DB level, so even concurrent
-- requests racing through the application layer cannot create a conflict.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reservations (
  id                TEXT        PRIMARY KEY DEFAULT encode(gen_random_bytes(4), 'hex'),
  date              DATE        NOT NULL,
  time              TIME        NOT NULL,
  party_size        SMALLINT    NOT NULL CHECK (party_size BETWEEN 1 AND 8),
  customer_name     TEXT        NOT NULL,
  customer_phone    TEXT        NOT NULL,
  special_requests  TEXT        NOT NULL DEFAULT '',
  table_id          TEXT        NOT NULL,
  table_location    TEXT        NOT NULL,
  status            TEXT        NOT NULL DEFAULT 'confirmed'
                                CHECK (status IN ('confirmed', 'cancelled', 'no_show', 'completed')),
  reminder_sent     BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cancelled_at      TIMESTAMPTZ,
  cancellation_reason TEXT,

  -- Prevent double-booking at the database level using a GiST exclusion constraint.
  -- Two reservations conflict when they share the same table_id AND their time
  -- ranges overlap. Each booking holds the table for 90 minutes.
  CONSTRAINT no_double_booking EXCLUDE USING gist (
    table_id WITH =,
    reservation_tsrange(date, time) WITH &&
  ) WHERE (status = 'confirmed')
);

CREATE INDEX IF NOT EXISTS idx_reservations_date    ON reservations (date);
CREATE INDEX IF NOT EXISTS idx_reservations_phone   ON reservations (customer_phone);
CREATE INDEX IF NOT EXISTS idx_reservations_status  ON reservations (status);

-- Trigram index for fuzzy name lookup (e.g. admin searching "Jon" matches "Jonathan")
CREATE INDEX IF NOT EXISTS idx_reservations_name_trgm
  ON reservations USING gin (customer_name gin_trgm_ops);

-- ─────────────────────────────────────────────────────────────────────────────
-- Auto-update updated_at on every row change
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS reservations_updated_at ON reservations;
CREATE TRIGGER reservations_updated_at
  BEFORE UPDATE ON reservations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- NOTIFY on new reservations (Node server LISTENs and fires SMS confirmation)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION notify_new_reservation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify(
    'new_reservation',
    json_build_object(
      'id',              NEW.id,
      'customer_name',   NEW.customer_name,
      'customer_phone',  NEW.customer_phone,
      'date',            NEW.date,
      'time',            NEW.time,
      'party_size',      NEW.party_size,
      'table_location',  NEW.table_location
    )::text
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS reservation_notify ON reservations;
CREATE TRIGGER reservation_notify
  AFTER INSERT ON reservations
  FOR EACH ROW EXECUTE FUNCTION notify_new_reservation();

-- ─────────────────────────────────────────────────────────────────────────────
-- MESSAGES (left for management callback)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS messages (
  id           TEXT        PRIMARY KEY DEFAULT encode(gen_random_bytes(3), 'hex'),
  caller_name  TEXT        NOT NULL,
  caller_phone TEXT        NOT NULL,
  subject      TEXT        NOT NULL,
  message      TEXT        NOT NULL,
  status       TEXT        NOT NULL DEFAULT 'unread'
                           CHECK (status IN ('unread', 'read', 'resolved')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS messages_updated_at ON messages;
CREATE TRIGGER messages_updated_at
  BEFORE UPDATE ON messages
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- CALLS (log of every phone session, partitioned by month)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS calls (
  id                          TEXT        NOT NULL DEFAULT encode(gen_random_bytes(6), 'hex'),
  call_sid                    TEXT,
  stream_sid                  TEXT,
  caller_number               TEXT,
  called_number               TEXT,
  elevenlabs_conversation_id  TEXT,
  started_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at                    TIMESTAMPTZ,
  duration_seconds            INTEGER,
  outcome                     TEXT NOT NULL DEFAULT 'no_action'
                              CHECK (outcome IN ('reservation_booked','message_left','info_provided','no_action','error')),
  cost_estimate_usd           NUMERIC(8,4),
  cost_breakdown_usd          JSONB,
  transcript                  JSONB NOT NULL DEFAULT '[]',
  tools_called                JSONB NOT NULL DEFAULT '[]',
  inquiry_topics              TEXT[] NOT NULL DEFAULT '{}',
  reservation_id              TEXT REFERENCES reservations(id),
  message_id                  TEXT REFERENCES messages(id),
  errors                      JSONB NOT NULL DEFAULT '[]',
  PRIMARY KEY (id, started_at)
) PARTITION BY RANGE (started_at);

-- Helper to create a monthly partition
CREATE OR REPLACE FUNCTION create_calls_partition(yr INT, mo INT)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  partition_name TEXT;
  start_date DATE;
  end_date DATE;
BEGIN
  partition_name := format('calls_%s_%s', yr, lpad(mo::text, 2, '0'));
  start_date := make_date(yr, mo, 1);
  end_date := start_date + interval '1 month';
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF calls FOR VALUES FROM (%L) TO (%L)',
    partition_name, start_date, end_date
  );
END;
$$;

-- Seed partitions for current and next 2 months
SELECT create_calls_partition(
  EXTRACT(YEAR FROM NOW() + (n || ' months')::interval)::int,
  EXTRACT(MONTH FROM NOW() + (n || ' months')::interval)::int
)
FROM generate_series(0, 2) AS n;

CREATE INDEX IF NOT EXISTS idx_calls_started_at  ON calls (started_at);
CREATE INDEX IF NOT EXISTS idx_calls_outcome      ON calls (outcome);
CREATE INDEX IF NOT EXISTS idx_calls_caller       ON calls (caller_number);
CREATE INDEX IF NOT EXISTS idx_calls_transcript   ON calls USING gin (transcript);
CREATE INDEX IF NOT EXISTS idx_calls_tools        ON calls USING gin (tools_called);

-- ─────────────────────────────────────────────────────────────────────────────
-- ANALYTICS MATERIALIZED VIEW
-- Refresh on demand or via pg_cron (see SETUP.md).
-- Example: SELECT * FROM call_analytics_daily ORDER BY call_date DESC LIMIT 30;
-- ─────────────────────────────────────────────────────────────────────────────
CREATE MATERIALIZED VIEW IF NOT EXISTS call_analytics_daily AS
SELECT
  started_at::date                                          AS call_date,
  COUNT(*)                                                  AS total_calls,
  SUM(duration_seconds)                                     AS total_seconds,
  ROUND(AVG(duration_seconds))                              AS avg_seconds,
  SUM(cost_estimate_usd)                                    AS total_cost_usd,
  COUNT(*) FILTER (WHERE outcome = 'reservation_booked')    AS bookings,
  COUNT(*) FILTER (WHERE outcome = 'message_left')          AS messages_left,
  COUNT(*) FILTER (WHERE outcome = 'info_provided')         AS info_calls,
  COUNT(*) FILTER (WHERE outcome = 'no_action')             AS no_action,
  COUNT(*) FILTER (WHERE jsonb_array_length(errors) > 0)    AS calls_with_errors
FROM calls
GROUP BY started_at::date
WITH DATA;

CREATE UNIQUE INDEX IF NOT EXISTS idx_analytics_daily_date ON call_analytics_daily (call_date);

-- ─────────────────────────────────────────────────────────────────────────────
-- pg_cron FUNCTIONS (schedule manually in production — see SETUP.md)
-- ─────────────────────────────────────────────────────────────────────────────

-- Marks reservations needing a 24h reminder and emits NOTIFY 'reminder_due'
CREATE OR REPLACE FUNCTION queue_upcoming_reminders()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  r reservations%ROWTYPE;
BEGIN
  FOR r IN
    SELECT * FROM reservations
    WHERE status = 'confirmed'
      AND reminder_sent = FALSE
      AND (date + time)::timestamp BETWEEN NOW() + interval '23 hours'
                                       AND NOW() + interval '25 hours'
  LOOP
    UPDATE reservations SET reminder_sent = TRUE WHERE id = r.id;
    PERFORM pg_notify(
      'reminder_due',
      json_build_object(
        'id',             r.id,
        'customer_name',  r.customer_name,
        'customer_phone', r.customer_phone,
        'date',           r.date,
        'time',           r.time,
        'party_size',     r.party_size
      )::text
    );
  END LOOP;
END;
$$;

-- Creates next month's calls partition on the 25th of each month
CREATE OR REPLACE FUNCTION ensure_next_calls_partition()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  next_month DATE := DATE_TRUNC('month', NOW()) + interval '1 month';
BEGIN
  PERFORM create_calls_partition(
    EXTRACT(YEAR FROM next_month)::int,
    EXTRACT(MONTH FROM next_month)::int
  );
END;
$$;

-- Schedule these once in psql against your production database (NOT here):
--   SELECT cron.schedule('queue-reminders',   '0 * * * *',  'SELECT queue_upcoming_reminders()');
--   SELECT cron.schedule('ensure-partition',  '0 0 25 * *', 'SELECT ensure_next_calls_partition()');
--   SELECT cron.schedule('refresh-analytics', '0 3 * * *',  'REFRESH MATERIALIZED VIEW CONCURRENTLY call_analytics_daily');
`;

async function main() {
  console.log('Running database migration…');
  const client = await pool.connect();
  try {
    await client.query(DDL);
    console.log('Migration complete.');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
