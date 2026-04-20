# Square Restaurants — Production Readiness Plan

This document is a task-by-task implementation guide. Work through the phases in order — each phase unblocks the next. Within a phase, tasks can generally be done in parallel unless a dependency is noted.

The guiding principle for infrastructure choices: **use PostgreSQL's native capabilities first.** Before reaching for a managed queue service, a cron scheduler, a search engine, or a notification service, check whether Postgres can do it. In this stack it can do almost all of it.

---

## Phase 1 — Database Foundation (blocks everything else)

All other production work depends on persistent storage. Railway's filesystem is ephemeral — every deploy wipes local files. The current `reservations.json`, `messages.json`, and `calls.jsonl` will not survive production.

### Task 1.1 — Provision Railway Postgres and install the `pg` driver

**On Railway:**
1. In your Railway project dashboard, click **+ New** → **Database** → **PostgreSQL**. Railway provisions a managed Postgres instance and injects `DATABASE_URL` automatically into your service's environment.
2. From the Postgres service's **Connect** tab, copy the connection string for local dev. Add it to `.env` as `DATABASE_URL`.
3. Add `DATABASE_URL` to `.env.example` as a placeholder (no real value).

**In the codebase:**
```bash
npm install pg
```

Create **`src/db.js`** — the shared connection pool used by all modules:

```js
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  console.error('Unexpected database pool error:', err.message);
});

module.exports = pool;
```

---

### Task 1.2 — Write and run the database migration

Create **`scripts/migrate.js`**. This script is idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, etc.) and safe to re-run. Run it once before first deploy and again after any schema change.

```bash
node scripts/migrate.js
```

#### Full schema DDL (put this inside `migrate.js` and execute via `pool.query`)

```sql
-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "btree_gist"; -- required for tsrange exclusion constraints
CREATE EXTENSION IF NOT EXISTS "pg_trgm";    -- fuzzy name search on reservations

-- ─────────────────────────────────────────────────────────────────────────────
-- RESERVATIONS
-- The exclusion constraint (no_double_booking) makes it physically impossible
-- to double-book a table. It operates at the DB level, so even concurrent
-- requests racing through the application layer cannot create a conflict.
-- This replaces the application-level findConflicts() check in reservationStore.js
-- and removes the race condition between check_availability and book_reservation.
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
    tsrange(
      (date::text || ' ' || time::text)::timestamp,
      (date::text || ' ' || time::text)::timestamp + interval '90 minutes',
      '[)'
    ) WITH &&
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
-- NOTIFY on new reservations (used by Node to trigger SMS confirmation)
-- The Node server calls LISTEN on 'new_reservation' at startup and fires
-- Twilio SMS when it receives a payload — no separate pub/sub service needed.
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
-- CALLS (log of every phone session)
-- Partitioned by month so the table stays fast as call volume grows.
-- Queries scoped to a date range only touch the relevant partition(s).
-- transcript and tools_called are stored as jsonb — efficient, indexable,
-- and avoids normalizing what is inherently document-shaped data.
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

-- Create partitions for the current month and next month.
-- Add a helper function so new partitions can be created without manual SQL.
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

-- GIN index enables fast jsonb queries on transcript/tools_called fields
CREATE INDEX IF NOT EXISTS idx_calls_transcript   ON calls USING gin (transcript);
CREATE INDEX IF NOT EXISTS idx_calls_tools        ON calls USING gin (tools_called);

-- ─────────────────────────────────────────────────────────────────────────────
-- ANALYTICS MATERIALIZED VIEW
-- Replaces scripts/report.js ad-hoc queries. Refresh on demand or via pg_cron.
-- Example query: SELECT * FROM call_analytics_daily ORDER BY call_date DESC LIMIT 30;
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
-- pg_cron JOBS
-- pg_cron runs inside Postgres — no external cron service needed.
-- Railway's managed Postgres has pg_cron available; enable it once:
--   ALTER SYSTEM SET cron.database_name = '<your-db-name>';  (done in Railway dashboard)
-- Then:
-- ─────────────────────────────────────────────────────────────────────────────

-- Job 1: Mark reservations needing a reminder and emit a NOTIFY.
-- Runs every hour. The Node server listens on 'reminder_due' and fires SMS.
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

-- Job 2: Create next month's calls partition on the 25th of each month
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

-- Job 3: Refresh the analytics materialized view nightly
-- (No code needed in Node — this is pure Postgres)

-- Schedule all three jobs via pg_cron (run after enabling the extension):
-- SELECT cron.schedule('queue-reminders',       '0 * * * *',   'SELECT queue_upcoming_reminders()');
-- SELECT cron.schedule('ensure-partition',      '0 0 25 * *',  'SELECT ensure_next_calls_partition()');
-- SELECT cron.schedule('refresh-analytics',     '0 3 * * *',   'REFRESH MATERIALIZED VIEW CONCURRENTLY call_analytics_daily');
--
-- NOTE: pg_cron scheduling commands are commented out above because they must be
-- run once manually in a psql session against your production database, not in
-- the migration script itself. Add them to a SETUP.md checklist.
```

---

### Task 1.3 — Replace `src/reservationStore.js` with a Postgres-backed version

**Key changes:**

- `loadAll()` → `SELECT * FROM reservations WHERE status = 'confirmed'`
- `addReservation(r)` → `INSERT INTO reservations (...) VALUES (...)` — the exclusion constraint handles double-booking at the DB level; catch `error.code === '23P01'` (exclusion violation) and surface it as "table no longer available"
- `findConflicts()` — **delete this function entirely**. The exclusion constraint replaces it. The application-level conflict scan in `check_availability` in `tools.js` should be replaced with a simpler query: `SELECT id FROM reservations WHERE table_id = $1 AND status = 'confirmed' AND tsrange(...) && tsrange(...)`
- `generateId()` — remove; use `DEFAULT encode(gen_random_bytes(4), 'hex')` from the DB
- `toMinutes()` — keep as a pure utility, it's still used for hours-of-operation checks

All functions should be `async` and return Promises. Update all callers accordingly.

---

### Task 1.4 — Replace `src/messageStore.js` with a Postgres-backed version

Straightforward: `addMessage()` becomes an `INSERT`, `generateId()` is removed (DB default), `loadAll()` becomes a `SELECT`.

---

### Task 1.5 — Replace `src/callLogger.js` with a Postgres-backed version

- On `startCall()`, `INSERT` a new row with `outcome = 'no_action'`, store the returned `id`.
- On `logTranscript()`, `logToolCall()`, `logError()`: buffer these in memory (same as today) — do not write on every event.
- On `endCall()`: `UPDATE calls SET ended_at = ..., duration_seconds = ..., outcome = ..., transcript = ..., tools_called = ..., cost_estimate_usd = ..., cost_breakdown_usd = ..., errors = ... WHERE id = $1`. Use `JSON.stringify()` on the arrays for the `jsonb` columns.
- Set `reservation_id` and `message_id` foreign key fields when the relevant tools fire (update the session object in `logToolCall`).

---

### Task 1.6 — Wire up `LISTEN/NOTIFY` in `src/server.js`

Postgres `LISTEN/NOTIFY` replaces what would otherwise be a Redis Pub/Sub channel or a webhook queue. The Node server maintains a single dedicated `pg` client (not from the pool — `LISTEN` requires a persistent connection) that listens on two channels.

Add to `src/server.js` after the Express setup:

```js
const { Client } = require('pg');

async function startNotificationListener() {
  const notifyClient = new Client({ connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false });
  await notifyClient.connect();

  await notifyClient.query('LISTEN new_reservation');
  await notifyClient.query('LISTEN reminder_due');

  notifyClient.on('notification', async (msg) => {
    const payload = JSON.parse(msg.payload);
    if (msg.channel === 'new_reservation') {
      await sendSmsConfirmation(payload);   // see Task 4.1
    }
    if (msg.channel === 'reminder_due') {
      await sendSmsReminder(payload);       // see Task 4.1
    }
  });

  notifyClient.on('error', (err) => {
    console.error('Notification listener error — reconnecting in 5s:', err.message);
    setTimeout(startNotificationListener, 5_000);
  });
}

startNotificationListener().catch(console.error);
```

---

### Task 1.7 — Update `scripts/report.js` to query the analytics view

Replace the file-parsing logic with:

```js
const pool = require('../src/db');
const rows = await pool.query(
  'SELECT * FROM call_analytics_daily ORDER BY call_date DESC LIMIT $1',
  [days || 30]
);
```

The materialized view already does all the aggregation. For a `--month` flag, add a `WHERE call_date >= $1 AND call_date < $2` clause.

---

## Phase 2 — Security

### Task 2.1 — Twilio webhook signature validation

Without this, anyone who discovers `/incoming-call` can trigger fake calls.

In `src/server.js`, add before the route definition:

```js
const twilio = require('twilio');

// Twilio signs every webhook POST with your Auth Token.
// This middleware verifies the signature and rejects anything that doesn't match.
app.use('/incoming-call',
  express.urlencoded({ extended: false }),   // must parse body BEFORE validation
  (req, res, next) => {
    const valid = twilio.validateExpressRequest(req, process.env.TWILIO_AUTH_TOKEN, {
      url: process.env.PUBLIC_URL + '/incoming-call',
    });
    if (!valid) {
      console.warn('Rejected request with invalid Twilio signature from', req.ip);
      return res.status(403).send('Forbidden');
    }
    next();
  }
);
```

Add `TWILIO_AUTH_TOKEN` and `PUBLIC_URL` (the production Railway URL, e.g. `https://your-app.up.railway.app`) to `.env.example` and Railway environment variables.

**Note:** The `PUBLIC_URL` must exactly match the URL Twilio sends webhooks to — including whether it has a trailing slash. Railway sets this automatically as `RAILWAY_PUBLIC_DOMAIN`; you can derive `PUBLIC_URL` from that.

---

### Task 2.2 — Rate limiting on `/incoming-call`

```bash
npm install express-rate-limit
```

In `src/server.js`:

```js
const rateLimit = require('express-rate-limit');

const callLimiter = rateLimit({
  windowMs: 60_000,   // 1 minute
  max: 20,            // max 20 webhook hits per IP per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many requests',
});

app.use('/incoming-call', callLimiter);
```

---

### Task 2.3 — Environment variable audit

Ensure `.env.example` has a placeholder (no real value) for every variable the app reads. Verify `.gitignore` contains `.env`. Add a startup check in `src/server.js`:

```js
const REQUIRED_ENV = [
  'ELEVENLABS_API_KEY', 'ELEVENLABS_AGENT_ID',
  'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_PHONE_NUMBER',
  'DATABASE_URL', 'PUBLIC_URL',
];

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}
```

---

## Phase 3 — Reliability

### Task 3.1 — Health check endpoint

Add to `src/server.js`:

```js
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'ok', uptime: process.uptime() });
  } catch (err) {
    res.status(503).json({ status: 'error', db: err.message });
  }
});
```

In Railway's service settings, set the health check path to `/health`.

---

### Task 3.2 — Graceful shutdown on `SIGTERM`

Railway sends `SIGTERM` before stopping or redeploying the service. Without handling it, in-progress calls get cut off.

Add to `src/server.js`:

```js
const activeSessions = new Set();

// Register each new WebSocket session on open, deregister on close
wss.on('connection', (twilioWs) => {
  activeSessions.add(twilioWs);
  twilioWs.on('close', () => activeSessions.delete(twilioWs));
  // ... rest of existing connection handler
});

async function shutdown(signal) {
  console.log(`\n${signal} received — draining ${activeSessions.size} active call(s)…`);
  server.close();   // stop accepting new HTTP/WS connections

  // Give active calls up to 45 seconds to finish naturally
  const deadline = setTimeout(() => {
    console.warn('Drain deadline reached — force-closing remaining sessions');
    for (const ws of activeSessions) ws.close();
  }, 45_000);

  // Poll until all sessions have closed
  await new Promise((resolve) => {
    const check = setInterval(() => {
      if (activeSessions.size === 0) { clearInterval(check); resolve(); }
    }, 500);
  });

  clearTimeout(deadline);
  await pool.end();   // close DB pool cleanly
  console.log('Shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
```

---

### Task 3.3 — ElevenLabs WebSocket error recovery

Currently if the ElevenLabs connection drops mid-call, the caller hears silence. Add a fallback.

In the ElevenLabs `elWs.on('error', ...)` and `elWs.on('close', ...)` handlers in `src/server.js`, after logging the error, check if `twilioWs` is still open and inject a TwiML redirect via the Twilio REST API:

```js
elWs.on('close', async (code, reason) => {
  logger.logError('elevenlabs_ws', { code, reason: reason.toString() });
  logger.endCall();

  if (twilioWs.readyState === WebSocket.OPEN && session.callSid) {
    try {
      const client = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      await client.calls(session.callSid).update({
        twiml: '<Response><Say voice="Polly.Joanna">I\'m sorry, I\'m having a technical difficulty. Please call back in a moment and we\'ll be happy to help you.</Say><Hangup/></Response>',
      });
    } catch (e) {
      console.error('Failed to inject TwiML fallback:', e.message);
    }
    twilioWs.close();
  }
});
```

The `session` object (which already tracks callSid in the logger) needs to be accessible here — hoist `callSid` into the outer `wss.on('connection')` scope.

Add `TWILIO_ACCOUNT_SID` to the required env list if not already there.

---

### Task 3.4 — Phone number validation in `book_reservation`

In `src/tools.js`, before calling `check_availability` inside `book_reservation`, add:

```js
// Accept E.164 (+1XXXXXXXXXX), 10-digit, or common formatted variants
const cleaned = customer_phone.replace(/\D/g, '');
if (cleaned.length < 10 || cleaned.length > 15) {
  return { success: false, reason: 'Please provide a valid phone number so we can confirm your reservation.' };
}
```

This is a lightweight guard. If you want full carrier validation later, Twilio Lookup can be added here as an async call — but that's an enhancement, not a blocker.

---

## Phase 4 — Caller Experience

### Task 4.1 — SMS confirmation and day-before reminder

Add Twilio SMS sending. This is triggered by the Postgres `LISTEN/NOTIFY` channels wired up in Task 1.6 — no separate job runner needed.

In **`src/sms.js`** (new file):

```js
const twilio = require('twilio');

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const FROM = process.env.TWILIO_PHONE_NUMBER;

function formatPhone(raw) {
  const digits = raw.replace(/\D/g, '');
  return digits.startsWith('1') ? `+${digits}` : `+1${digits}`;
}

async function sendSmsConfirmation({ id, customer_name, customer_phone, date, time, party_size, table_location }) {
  const name  = customer_name.split(' ')[0];
  const dt    = new Date(`${date}T${time}`).toLocaleString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
  await client.messages.create({
    from: FROM,
    to:   formatPhone(customer_phone),
    body: `Hi ${name}! Your reservation at The Ember Room is confirmed — ${dt} for ${party_size}. Confirmation code: ${id}. We'll see you then! To cancel, call us at ${process.env.RESTAURANT_PHONE}.`,
  });
}

async function sendSmsReminder({ id, customer_name, customer_phone, date, time, party_size }) {
  const name = customer_name.split(' ')[0];
  const dt   = new Date(`${date}T${time}`).toLocaleString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
  await client.messages.create({
    from: FROM,
    to:   formatPhone(customer_phone),
    body: `Hi ${name}! Just a reminder about your reservation at The Ember Room tomorrow — ${dt} for ${party_size}. We look forward to seeing you! Code: ${id}. Need to cancel? Call us at ${process.env.RESTAURANT_PHONE}.`,
  });
}

module.exports = { sendSmsConfirmation, sendSmsReminder };
```

Import these into `src/server.js` and call them from the `LISTEN/NOTIFY` handler in Task 1.6.

Add `RESTAURANT_PHONE` to `.env.example` (the restaurant's human-facing number to include in SMS messages).

---

### Task 4.2 — Cancellation tool

Add a `cancel_reservation` tool to `src/tools.js`. This is one of the most common caller needs and currently falls through to a management message.

**Tool definition:**

```js
{
  name: 'cancel_reservation',
  description:
    'Cancels an existing reservation by confirmation code. ' +
    'Ask the caller for their confirmation code and phone number to verify ownership. ' +
    'Cancellations must be more than 24 hours before the reservation time to avoid a fee. ' +
    'Always confirm the reservation details back to the caller before cancelling.',
  input_schema: {
    type: 'object',
    properties: {
      confirmation_code:  { type: 'string', description: 'The confirmation code from the original booking' },
      customer_phone:     { type: 'string', description: 'Phone number used when booking, for verification' },
      reason:             { type: 'string', description: 'Optional cancellation reason' },
    },
    required: ['confirmation_code', 'customer_phone'],
  },
}
```

**Handler:**

```js
async function cancel_reservation({ confirmation_code, customer_phone, reason }) {
  const row = await pool.query(
    `SELECT * FROM reservations WHERE id = $1 AND status = 'confirmed'`,
    [confirmation_code.toUpperCase()]
  );

  if (!row.rows.length) {
    return { success: false, reason: 'No confirmed reservation found with that code.' };
  }

  const res = row.rows[0];
  const phoneDigits = (customer_phone || '').replace(/\D/g, '').slice(-10);
  const storedDigits = (res.customer_phone || '').replace(/\D/g, '').slice(-10);

  if (phoneDigits !== storedDigits) {
    return { success: false, reason: 'Phone number does not match the reservation. Please double-check.' };
  }

  const resTime = new Date(`${res.date}T${res.time}`);
  const hoursUntil = (resTime - new Date()) / 3_600_000;
  const lateFee = hoursUntil < 24 && res.party_size >= 5;

  await pool.query(
    `UPDATE reservations
     SET status = 'cancelled', cancelled_at = NOW(), cancellation_reason = $2
     WHERE id = $1`,
    [res.id, reason || null]
  );

  return {
    success: true,
    confirmation_code: res.id,
    date: res.date,
    time: res.time,
    party_size: res.party_size,
    late_fee_notice: lateFee
      ? `Please note: cancellations within 24 hours for parties of 5 or more may be subject to a $25 per person fee. Our team will be in touch.`
      : null,
    message: `Your reservation on ${res.date} at ${res.time} has been cancelled. We hope to see you again soon.`,
  };
}
```

Update `handleToolCall()` to include `'cancel_reservation': cancel_reservation`.

Update the system prompt in `server.js` to mention the `cancel_reservation` tool and instruct the agent to use it when callers want to cancel.

---

## Phase 5 — Deployment

### Task 5.1 — Railway service configuration

Create **`railway.json`** in the project root:

```json
{
  "$schema": "https://railway.app/railway.schema.json",
  "build": { "builder": "RAILPACK" },
  "deploy": {
    "startCommand": "node src/server.js",
    "healthcheckPath": "/health",
    "healthcheckTimeout": 30,
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 10
  }
}
```

**Note on the builder:** the plan originally specified `NIXPACKS`, but Railway has since migrated to `RAILPACK` as the default builder. Use `RAILPACK` to match the current platform default. If you see a project deployed on NIXPACKS, leaving that alone works too — but new projects should use RAILPACK.

### Task 5.2 — Run the migration against production

```bash
DATABASE_URL=<railway-postgres-url> node scripts/migrate.js
```

Run this before the first production deploy and after any future schema change.

### Task 5.3 — Set all environment variables in Railway

In Railway's service dashboard → **Variables**, add:

| Variable | Source |
|---|---|
| `DATABASE_URL` | Auto-injected by Railway Postgres add-on |
| `ELEVENLABS_API_KEY` | ElevenLabs dashboard |
| `ELEVENLABS_AGENT_ID` | ElevenLabs dashboard |
| `TWILIO_ACCOUNT_SID` | Twilio console |
| `TWILIO_AUTH_TOKEN` | Twilio console |
| `TWILIO_PHONE_NUMBER` | Twilio console (E.164 format, e.g. `+16155550142`) |
| `PUBLIC_URL` | Your Railway public domain, e.g. `https://your-app.up.railway.app` |
| `RESTAURANT_PHONE` | The restaurant's human phone number for SMS footer |
| `NODE_ENV` | `production` |
| `PORT` | Leave unset — Railway injects it automatically |

### Task 5.4 — Schedule the three recurring DB jobs

**Superseded:** the original plan called for `pg_cron`, but Railway's default managed Postgres image does **not** include the `pg_cron` binary (`pg_available_extensions` returns zero rows, not just an unloaded extension). So we run the same three jobs from the Node process via `node-cron` instead. See `src/scheduler.js` and ARCHITECTURE.md §4 "Scheduled jobs".

No Railway-side configuration is required — the scheduler starts automatically alongside the server. Verify after deploy:

```bash
railway logs | grep -i '\[scheduler\]'
# expect three lines: registered queue-reminders / ensure-partition / refresh-analytics
```

If you ever switch to a Postgres image that includes `pg_cron` (e.g. `supabase/postgres`), replace `src/scheduler.js` with the `cron.schedule(...)` SQL block and delete the node-cron dependency.

### Task 5.5 — Update Twilio webhook

In the Twilio Console → **Phone Numbers → Manage → Active Numbers → your number**:
- **Voice webhook URL:** `https://your-app.up.railway.app/incoming-call`
- **HTTP method:** `POST`
- Save.

Make a test call to confirm end-to-end.

---

## Phase 6 — Multi-Tenant Refactor

Convert the single-tenant deployment (The Ember Room) into a SaaS that hosts multiple clients on one Node service and one Postgres database. Each client has its own Twilio phone numbers (voice + SMS), reservations, messages, call logs, and configuration. Multiple clients may share an owner ("account") — e.g. a restaurant group operating several venues.

This phase **subsumes the originally-planned Phase 6 ops polish** (hot-reloaded config, `/analytics` endpoint). Both are strict subsets of the multi-tenant work and are reintegrated as Tasks 6.3 and 6.9 respectively — doing them separately first would mean migrating the same schema twice.

### Design decisions (pinned)

- **Tenancy layer is neutrally named.** `accounts` (owner / billing) → `locations` (per-tenant venue). Domain tables (`reservations`, `tables` → `location_tables`) stay restaurant-shaped under a `location_id` FK. Rationale: salons / spas / barbershops are on the roadmap and have a fundamentally different booking model (staff member + service, not table + party). When a non-restaurant vertical is onboarded, it adds a parallel domain schema (e.g. `appointments` / `services` / `staff`) alongside the existing one rather than being jammed into it. Neutral tenancy names keep that path open for free.
- **Tenant resolution:** inbound Twilio `To` number → lookup in `locations.twilio_number`. Unknown number → TwiML apology, never a silent fallback to a default tenant.
- **ElevenLabs:** one shared agent. Tenant-specific prompt (and optional `voice_id`) injected via `conversation_initiation_client_data`. Default is one voice for all tenants; per-tenant voice override is supported via `locations.elevenlabs_voice_id` for future opt-in.
- **Twilio numbers:** each tenant brings its own voice and SMS numbers. `locations.twilio_number` (inbound voice, unique) and `locations.sms_from_number` (SMS, defaults to voice number if null).
- **Booking window (90 min):** stays hardcoded in the `reservation_tsrange` IMMUTABLE SQL function. Flagged as future work — making it per-tenant requires either a computed column or trigger-maintained `tsrange` since IMMUTABLE functions can't read from another row.
- **External booking/ordering integrations (OpenTable / Resy / Square / Toast):** not built now, but `reservations` gains nullable `external_provider` + `external_id` columns so the door stays open without a future migration.
- **Tenant lifecycle:** soft-delete only (`active BOOLEAN`). Tenant data is retained indefinitely; no hard-delete tooling in this phase.
- **Per-tenant tool toggles:** `locations.enabled_tools TEXT[]` controls which tools a tenant exposes. Two layers enforce it: `buildSystemPrompt` only describes enabled tools to the agent (so the model doesn't know disabled ones exist), and `handleToolCall` rejects disabled tools as a defense-in-depth check. All current tools are enabled by default; when a new tool ships (e.g. a future `order_takeout` voice-frontend to Square/Toast), tenants opt in by flipping the array.

### Migration strategy (zero-downtime, one live tenant)

Every schema change is **additive → backfill → constrain**. New FK columns land as NULLABLE first; they're backfilled from the existing tenant data in 6.3; only then (and only after the new code has baked in production for 24h) does the NOT NULL flip happen. The `no_double_booking` exclusion constraint is swapped for its tenant-aware version only after every `reservations` row has a non-null `location_id`. This whole phase is designed so that reverting any single step leaves the Ember Room deployment working.

---

### Task 6.1 — Preflight

1. Tag the current commit: `git tag v1-single-tenant && git push --tags`. Named rollback anchor for the whole refactor.
2. Take a manual `pg_dump` of production Postgres into cold storage. Railway's automated backups are fine but belt-and-suspenders here.
3. Grep for every `require('../config/restaurant.json')` and every hardcoded "Ember Room" string. Known: `src/server.js:13`, `src/tools.js:9`, `src/sms.js` (body text around lines 30 and 40). Confirm the list is complete before proceeding.
4. Update `ARCHITECTURE.md` §8: add "Phase 6 — Multi-Tenant Refactor | In progress" row.

No shipping.

---

### Task 6.2 — Additive schema: accounts, locations, tables, nullable FKs

Append to `scripts/migrate.js` (idempotent; do not modify earlier DDL blocks):

```sql
-- ─────────────────────────────────────────────────────────────────────────────
-- ACCOUNTS — owner / billing layer. One owner may operate many locations.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS accounts (
  id             TEXT        PRIMARY KEY,          -- slug, e.g. 'ember-group'
  name           TEXT        NOT NULL,
  contact_email  TEXT,
  contact_phone  TEXT,
  active         BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS accounts_updated_at ON accounts;
CREATE TRIGGER accounts_updated_at
  BEFORE UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- LOCATIONS — per-tenant venue. Neutral name so salons/spas/barbershops fit
-- later without renaming every FK. The `vertical` column is the seam where
-- future verticals hang.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS locations (
  id                   TEXT        PRIMARY KEY,    -- slug, e.g. 'ember-room'
  account_id           TEXT        NOT NULL REFERENCES accounts(id),
  vertical             TEXT        NOT NULL DEFAULT 'restaurant'
                                   CHECK (vertical IN ('restaurant')),  -- widen when new verticals land
  name                 TEXT        NOT NULL,
  twilio_number        TEXT        NOT NULL UNIQUE,-- inbound voice number
  sms_from_number      TEXT,                       -- nullable → falls back to twilio_number
  elevenlabs_agent_id  TEXT,                       -- nullable → use env default
  elevenlabs_voice_id  TEXT,                       -- per-tenant voice override (future)
  enabled_tools        TEXT[]      NOT NULL DEFAULT ARRAY[
                                     'get_restaurant_info','get_menu',
                                     'check_availability','book_reservation',
                                     'cancel_reservation','leave_message'
                                   ],               -- per-tenant feature flags; filter TOOL_DEFINITIONS + system prompt by this
  timezone             TEXT        NOT NULL DEFAULT 'America/Chicago',
  config               JSONB       NOT NULL,       -- hours, menu, policies, faqs, reservation_policy, etc.
  active               BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_locations_account ON locations (account_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_locations_twilio_number ON locations (twilio_number);

DROP TRIGGER IF EXISTS locations_updated_at ON locations;
CREATE TRIGGER locations_updated_at
  BEFORE UPDATE ON locations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Fire a NOTIFY when a location's config changes so `src/locationStore.js`
-- cache can invalidate without a redeploy (replaces original Task 6.2).
CREATE OR REPLACE FUNCTION notify_location_updated()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('location_config_updated', NEW.id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS location_config_notify ON locations;
CREATE TRIGGER location_config_notify
  AFTER UPDATE OF config, twilio_number, sms_from_number, elevenlabs_agent_id,
                  elevenlabs_voice_id, enabled_tools, timezone, active, name ON locations
  FOR EACH ROW EXECUTE FUNCTION notify_location_updated();

-- ─────────────────────────────────────────────────────────────────────────────
-- LOCATION_TABLES — restaurant tables, tenant-scoped. Composite PK means
-- "T1" is local to a location; there is no global T1.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS location_tables (
  location_id            TEXT NOT NULL REFERENCES locations(id),
  id                     TEXT NOT NULL,            -- e.g. 'T1' within a location
  capacity               SMALLINT NOT NULL,
  location_label         TEXT NOT NULL,            -- 'window' / 'main floor' / 'bar' / etc.
  notes                  TEXT,
  wheelchair_accessible  BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (location_id, id)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- NULLABLE tenant FKs on existing domain tables. NOT NULL flip happens in 6.4
-- after the 6.3 backfill completes and new code has baked.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS location_id TEXT REFERENCES locations(id);
ALTER TABLE messages     ADD COLUMN IF NOT EXISTS location_id TEXT REFERENCES locations(id);
ALTER TABLE calls        ADD COLUMN IF NOT EXISTS location_id TEXT REFERENCES locations(id);

-- External booking/ordering integration door (OpenTable / Resy / Square / Toast).
-- Keep reservations.table_id as the local cache; external_id is the foreign key
-- into whatever provider owns availability in an integrated deployment.
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS external_provider TEXT;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS external_id       TEXT;
CREATE INDEX IF NOT EXISTS idx_reservations_external
  ON reservations (external_provider, external_id)
  WHERE external_provider IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_reservations_location ON reservations (location_id);
CREATE INDEX IF NOT EXISTS idx_messages_location     ON messages     (location_id);
CREATE INDEX IF NOT EXISTS idx_calls_location        ON calls        (location_id);

-- Seed the owning account so 6.3's location insert has a parent to FK into.
INSERT INTO accounts (id, name)
VALUES ('ember-group', 'Ember Group')
ON CONFLICT (id) DO NOTHING;
```

**Do NOT drop or recreate `no_double_booking` yet** — that happens in Task 6.4 after the backfill is verified. Keeping the old constraint means Ember Room writes continue to be double-booking-safe throughout.

**Ship boundary:** run the migration against production. Old application binary keeps running and keeps writing `location_id = NULL` to domain tables — fine for this phase, backfill in 6.3 cleans it up.
**Rollback:** drop the new columns and tables. Safe because the old code never reads them.

---

### Task 6.3 — Backfill + tenant resolver (hot-reloaded config, subsumes original 6.2)

#### `scripts/backfill-tenant.js` (new, idempotent)

Run once after 6.2 and re-runnable as a no-op thereafter:

1. Insert the Ember Room as the first `locations` row, reading `config` from `config/restaurant.json` at script-run time:
   ```sql
   INSERT INTO locations (id, account_id, name, twilio_number, sms_from_number,
                          timezone, config)
   VALUES ('ember-room', 'ember-group', $name, $twilio_number, $twilio_number,
           'America/Chicago', $config_json)
   ON CONFLICT (id) DO UPDATE
     SET config = EXCLUDED.config, updated_at = NOW();
   ```
   `$twilio_number` comes from `process.env.TWILIO_PHONE_NUMBER`.
2. Seed `location_tables` with T1–T10 from `restaurant.json.tables`, keyed to `location_id = 'ember-room'`.
3. Backfill domain tables:
   ```sql
   UPDATE reservations SET location_id = 'ember-room' WHERE location_id IS NULL;
   UPDATE messages     SET location_id = 'ember-room' WHERE location_id IS NULL;
   UPDATE calls        SET location_id = 'ember-room' WHERE location_id IS NULL;
   ```
4. Verify: `SELECT COUNT(*) FROM <table> WHERE location_id IS NULL` must return 0 on each. Script exits non-zero if not.

#### New module: `src/locationStore.js`

```js
// 60s in-memory cache. Tool calls fire mid-conversation and can't afford a
// DB round-trip per get_menu. Bust on NOTIFY 'location_config_updated'.
async function loadByTwilioNumber(toNumber) { /* SELECT ... WHERE twilio_number = $1 AND active */ }
async function loadById(locationId)         { /* cached SELECT */ }
async function listActive()                 { /* used by SMS sender for from-number lookup */ }
function   invalidate(locationId)           { /* remove from cache */ }
```

The cached object hydrates `location.tables` by joining `location_tables` — so `check_availability` doesn't need a separate query at tool-call time.

#### Hot-reload (replaces original Task 6.2)

In `src/server.js`'s existing dedicated LISTEN client (from Task 1.6), add:
```js
await notifyClient.query('LISTEN location_config_updated');
// ...in the notification handler:
if (msg.channel === 'location_config_updated') locationStore.invalidate(msg.payload);
```
Management can now `UPDATE locations SET config = ... WHERE id = ...` (or hit the admin endpoint in Task 6.8) and changes propagate within the next tool-call cache miss. No redeploy.

#### Tenant resolution in `/incoming-call`

In `src/server.js:84-96`, after `CallSid` is captured:

```js
const location = await locationStore.loadByTwilioNumber(req.body.To);
if (!location || !location.active) {
  console.warn(`Unknown inbound To: ${req.body.To} from ${req.body.From}`);
  return res
    .type('text/xml')
    .send('<Response><Say voice="Polly.Joanna">We\'re sorry, this number is not currently in service.</Say><Hangup/></Response>');
}
pendingCalls.set(req.body.CallSid, {
  callSid: req.body.CallSid,
  from: req.body.From,
  to:   req.body.To,
  location,
});
```

The WS `start` event reads `location` off `pendingCalls` and hands it to the per-session closure.

**Ship boundary:** deploy. Lookup runs on every call but downstream code is not yet using `location` (that's 6.4). Only observable change: an inbound call to a number not in the `locations` table gets a polite TwiML bounce instead of falling through to Ember Room. Since the only prod tenant is Ember, there is no such "wrong number" in practice.
**Rollback:** revert code deploy. Backfill re-runs are no-ops.

---

### Task 6.4 — Thread `location` through tools + bridge; swap the exclusion constraint

Biggest code delta of the phase. Module-level `require('../config/restaurant.json')` is deleted. Everything that reads tenant config takes a `location` parameter.

#### `src/tools.js`

- **Remove line 9** (`const restaurant = require('../config/restaurant.json')`).
- `handleToolCall(toolName, toolInput, location)` — third parameter threaded through every handler. **First check**: if `toolName` is not in `location.enabled_tools`, return `{ error: 'This tool is not enabled for this location.' }` without dispatching. Belt-and-suspenders against the model invoking a tool it shouldn't know about.
- Each handler reads from `location.config.*` (hours, menu, reservation_policy, tables, etc.) instead of module-level `restaurant.*`.
- **Generalize `TOOL_DEFINITIONS` descriptions** — strip "The Ember Room" from the `description` strings so the same schema is used for every tenant. Tenant identity comes from the system prompt at conversation init, not from tool schemas.
- **`cancel_reservation` tenant-scope bug fix.** Current query (`src/tools.js:312-316`) reads `WHERE id = LOWER($1) AND status = 'confirmed'` with no tenant filter. Must become `WHERE id = LOWER($1) AND location_id = $2 AND status = 'confirmed'`. Confirmation-code collision across tenants is improbable in the 8-char hex keyspace (~4B) but not impossible, and the defense-in-depth cost is zero.

#### `src/server.js`

- **Remove line 13.**
- `buildSystemPrompt(location, nowInTenantTz)` — takes the location object and a tenant-local `Date`. Called lazily **after both** (a) `elWs.on('open')` and (b) the Twilio `start` event have fired — because the tenant isn't known at WS-open time. Guard the `conversation_initiation_client_data` send behind a two-gate Promise so neither side matters for ordering. **Filter the "Your tools:" section by `location.enabled_tools`** — the ElevenLabs agent has all tools registered in the dashboard, but the model only calls what the prompt tells it it has. Describing only enabled tools is the primary gate; the `handleToolCall` check above is the safety net.
- `handleToolCall(tool_name, parameters, location)` at `server.js:226`.
- **Rate limiter per-tenant** (`server.js:55`). Change to `keyGenerator: (req) => req.body.To || req.ip` so one noisy tenant can't starve the 20/min budget for everyone.
- The ElevenLabs-drop TwiML at `server.js:278` should pull the tenant name from `location.name` if available, not hardcode a generic string.

#### `src/reservationStore.js`

- `findConflictingTableIds(date, time, locationId)` — add `AND location_id = $3` to the conflicts query.
- `addReservation({... location_id})` — include the column in the INSERT.

#### `src/messageStore.js`

- `addMessage({... location_id})`.

#### `src/callLogger.js`

- `startCall({ locationId })`. The initial INSERT includes `location_id` when known; if the tenant is only known after `setCallInfo`, include it in the `endCall` UPDATE.

#### NOTIFY payloads

Update the SQL functions in `scripts/migrate.js` to include `location_id` in the JSON payload — both `notify_new_reservation()` and `queue_upcoming_reminders()`. The LISTEN handler in `server.js` uses it to route SMS through the correct tenant's `sms_from_number`.

```sql
-- patched notify_new_reservation body:
PERFORM pg_notify(
  'new_reservation',
  json_build_object(
    'id',             NEW.id,
    'location_id',    NEW.location_id,
    'customer_name',  NEW.customer_name,
    ...
  )::text
);
-- same pattern for queue_upcoming_reminders
```

Re-run `scripts/migrate.js` to pick up the function redefinitions (they're `CREATE OR REPLACE`, idempotent).

#### DB: swap `no_double_booking`

**Precondition:** Task 6.3 backfill complete; every `reservations.location_id` non-null.

```sql
BEGIN;
ALTER TABLE reservations ALTER COLUMN location_id SET NOT NULL;
ALTER TABLE reservations DROP CONSTRAINT no_double_booking;
ALTER TABLE reservations ADD CONSTRAINT no_double_booking
  EXCLUDE USING gist (
    location_id WITH =,
    table_id    WITH =,
    reservation_tsrange(date, time) WITH &&
  ) WHERE (status = 'confirmed');
COMMIT;
```

Also drop-and-recreate `idx_reservations_date` as `(location_id, date)` — every tenant-scoped range scan wants this shape.

**The NOT NULL flip on `messages.location_id` and `calls.location_id` happens in a second deploy**, 24h after the new code has been proven in prod to always set the column. Two-step: ship code with columns still nullable → bake → `ALTER ... SET NOT NULL`.

**Ship boundary:** tenant-aware code in prod. Still only one tenant. Any regression is reverted by rolling back the code deploy — the constraint swap still allows Ember-Room-only traffic to work.
**Rollback:** revert code. The constraint swap and column NOT NULL flips are functionally one-way but compatible with the old single-tenant code as long as `location_id` gets set (which the new exclusion constraint's NOT NULL enforces anyway).

---

### Task 6.5 — Timezone correctness (existing bug; blocks 6.10 cutover)

Two distinct bugs already present in the single-tenant deployment, made worse by multi-tenant:

1. **Agent doesn't know the current time of day.** `buildSystemPrompt` at `src/server.js:301-304` injects `today` only — a *date* string computed in *server* timezone. Consequences: the agent can't reason about "are you open right now?" or "is it too late tonight?" and invents time-of-day context. Callers have reported confusion.
2. **`check_availability` timezone skew.** `src/tools.js:179-187` uses `new Date()` to decide whether a requested slot is in the past. The server runs in UTC on Railway; a caller in Central time at 11pm on Monday can be told "that's in the past" because it's already Tuesday UTC.

Both get fixed in the same pass since they require the same dependency:

- Add a timezone library. **Luxon** is concise; alternative is `date-fns-tz` or native `Intl.DateTimeFormat` with manual offset math. Pick Luxon.
- `buildSystemPrompt(location, now)` injects **both** tenant-local date and time:
  ```
  Today is Monday, April 20, 2026. The current time is 6:47 PM.
  ```
  Computed via `DateTime.now().setZone(location.timezone)`.
- `check_availability` — replace `const now = new Date()` with the tenant-local equivalent; compare the requested `${date}T${time}:00` in `location.timezone` against that. Also use `location.timezone` when resolving the day-of-week for `location.config.hours` lookup.
- `src/sms.js` date formatting passes `{ timeZone: location.timezone }` to `toLocaleString`.
- `src/scheduler.js`: the 23–25h reminder window is already computed via Postgres `NOW() + interval`, which is UTC and tenant-agnostic. No change needed — reminders fire 24h before the absolute reservation moment regardless of which timezone the tenant lives in.

**Test (write this one):** fix the server clock to 2026-04-20 02:00 UTC with a tenant in `America/Chicago`, assert `buildSystemPrompt` reports "Sunday, April 19, 2026" at "9:00 PM," not Monday. Then flip the tenant to `America/New_York` and re-assert "10:00 PM." Any failure means the Luxon wiring is wrong.

---

### Task 6.6 — Per-tenant SMS

`src/sms.js`:

- `sendSmsConfirmation(payload)` and `sendSmsReminder(payload)` receive `location_id` in the payload (from the NOTIFY update in 6.4). Look up the full location via `locationStore.loadById(payload.location_id)`.
- `FROM` becomes `location.sms_from_number || location.twilio_number`.
- Hardcoded "The Ember Room" in the SMS body → `location.name`.
- Footer phone → `location.config.phone` (or `location.contact_phone` if we add it). The `RESTAURANT_PHONE` env var is deprecated and removed from `.env.example` during 6.10 cutover.
- Date formatting uses `location.timezone` (see 6.5).

---

### Task 6.7 — Onboarding CLI + seed JSON

`scripts/create-location.js` (new). Minimum viable onboarding: one command, git-committed input.

```bash
node scripts/create-location.js config/tenants/the-gilded-oyster.json
```

Seed JSON shape — mirrors today's `restaurant.json` plus a header block:

```json
{
  "id":              "the-gilded-oyster",
  "account_id":      "gilded-hospitality",
  "account_name":    "Gilded Hospitality LLC",
  "twilio_number":   "+15551234567",
  "sms_from_number": "+15551234567",
  "timezone":        "America/New_York",

  "name":     "The Gilded Oyster",
  "tagline":  "...",
  "hours":    { ... },
  "reservation_policy": { ... },
  "menu":     { ... },
  "tables":   [ { "id": "T1", "capacity": 2, ... }, ... ],
  "...":      "all other existing restaurant.json keys"
}
```

The script:
1. Validates required header fields (`id`, `account_id`, `twilio_number`, `timezone`, `name`, `tables`). Bails on missing.
2. Rejects duplicate `twilio_number` with a clear error (UNIQUE constraint would catch it anyway, but fail-fast is nicer).
3. Upserts `accounts` (`ON CONFLICT (id) DO NOTHING`) with the `account_name` if given.
4. Upserts `locations` (`ON CONFLICT (id) DO UPDATE`) with `config` = the JSON minus header fields.
5. Upserts `location_tables` rows.
6. Prints the Twilio Voice webhook URL the new number should be configured with.

`config/tenants/*.json` is git-committed so onboarding leaves a reviewable audit trail. `config/restaurant.json` remains on disk until 6.10's cutover, then is deleted.

---

### Task 6.8 — Minimal admin HTTP endpoint (unblocks >10 tenants)

CLI + seed JSON is fine up to roughly 10 tenants. Beyond that the round-trip through a PR becomes the bottleneck. Add a bearer-token-protected HTTP surface that uses the same upsert code path as the CLI — no duplicate logic.

```js
function requireAdminToken(req, res, next) {
  // constant-time compare
  const expected = `Bearer ${process.env.ADMIN_TOKEN}`;
  const provided = req.headers.authorization || '';
  if (provided.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) {
    return res.status(401).send('unauthorized');
  }
  next();
}

app.post  ('/admin/locations',       requireAdminToken, /* upsert */);
app.patch ('/admin/locations/:id',   requireAdminToken, /* partial update → fires location_config_updated NOTIFY */);
app.get   ('/admin/locations',       requireAdminToken, /* list */);
app.get   ('/admin/locations/:id',   requireAdminToken, /* read */);
app.post  ('/admin/accounts',        requireAdminToken, /* upsert */);
```

`ADMIN_TOKEN` is a long random string, set in Railway env vars, rotated if leaked. Not a real auth system — we're explicitly deferring that. This endpoint is enough for a one-person operator to onboard the 11th tenant from a laptop without PR latency.

---

### Task 6.9 — Analytics by location (subsumes original Task 6.1)

Rewrite the materialized view so it groups by tenant:

```sql
DROP MATERIALIZED VIEW IF EXISTS call_analytics_daily;

CREATE MATERIALIZED VIEW call_analytics_daily AS
SELECT
  location_id,
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
GROUP BY location_id, started_at::date
WITH DATA;

CREATE UNIQUE INDEX idx_analytics_daily_loc_date
  ON call_analytics_daily (location_id, call_date);
```

The `refresh-analytics` node-cron job is unchanged (it still runs `REFRESH MATERIALIZED VIEW CONCURRENTLY call_analytics_daily`).

Add the `/analytics` endpoint (token-gated, same `requireAdminToken` as 6.8):

```js
app.get('/analytics', requireAdminToken, async (req, res) => {
  const days = Math.max(1, Math.min(365, parseInt(req.query.days || 30)));
  const { location_id } = req.query;
  const rows = location_id
    ? (await pool.query(
        `SELECT * FROM call_analytics_daily
         WHERE location_id = $1
           AND call_date >= (NOW() - ($2 || ' days')::interval)
         ORDER BY call_date DESC`,
        [location_id, days]
      )).rows
    : (await pool.query(
        `SELECT * FROM call_analytics_daily
         WHERE call_date >= (NOW() - ($1 || ' days')::interval)
         ORDER BY call_date DESC`,
        [days]
      )).rows;
  res.json(rows);
});
```

`scripts/report.js` gains an optional `--location=<id>` flag; without it, aggregates across all tenants.

---

### Task 6.10 — Cutover: second tenant + documentation sweep

1. Onboard a staging tenant ("Test Diner") via `scripts/create-location.js` pointed at a second Twilio number you control. Different timezone from Ember Room so 6.5's timezone test gets a real-world workout.
2. Run the tenant-isolation test suite (below). **All must pass.**
3. Once green:
   - Delete `config/restaurant.json`.
   - Delete any remaining `require('../config/restaurant.json')` or fallback paths that referenced it.
   - Remove `RESTAURANT_PHONE` from `.env.example` and Railway env. Remove the reference in any docs.
   - Grep for any remaining "Ember Room" / "Ember" hardcodes and remove.
4. Update `ARCHITECTURE.md` (the big one) — per the top-of-file rule in that doc, this must happen in the same commit as the code cutover:
   - §1 description: "a multi-tenant voice reservations platform" instead of "a single restaurant."
   - §2 topology: show the tenant resolution step and `locations`/`accounts` tables.
   - §4 database: document `accounts`, `locations`, `location_tables`, the `location_id` FKs, the tenant-aware `no_double_booking`, and the `location_config_updated` NOTIFY channel.
   - §5 external services: note that Twilio numbers map 1:1 to locations.
   - §6 env vars: `RESTAURANT_PHONE` removed; `ADMIN_TOKEN` added.
   - §7 invariants: add "every domain query must scope by `location_id`"; update the rate-limiter invariant to reflect per-tenant keying; update the `LISTEN` channel list.
   - §8 phases: move Phase 6 to ✅ Done.
5. Update `CLAUDE.md` if any referenced paths changed (it currently references `PRODUCTION_PLAN.md` and `ARCHITECTURE.md` — probably fine).

**Ship boundary:** multi-tenant live in production. Ember Room + Test Diner both on one deployment.
**Rollback:** repoint Ember's Twilio number at the `v1-single-tenant` git-tag deployment. Schema is additive so there is no data loss. Second tenant stops functioning until re-onboarded.

---

### Tenant isolation test suite

Runs as part of 6.4, 6.5, and 6.10. Seed two locations `A` and `B` (different timezones, different Twilio numbers, disjoint table layouts), then assert:

1. **Booking isolation.** Book via A → A's `T1` is conflicted in the 90-min window. Book B's `T1` at the same timestamp → succeeds. Verifies `location_id WITH =` in the swapped exclusion constraint.
2. **Availability isolation.** `check_availability(date, time, 2, A)` returns A's `T1` as free when B has a booking on B's `T1` at the same slot. Verifies `findConflictingTableIds` is tenant-scoped.
3. **Cancel isolation.** Call `cancel_reservation(bCode, bPhone, A)` (i.e. B's confirmation code under A's location context) → "no reservation found." Verifies the tenant scope in the WHERE clause.
4. **SMS routing.** Mock Twilio. A's `new_reservation` NOTIFY produces an SMS from A's `sms_from_number`, body names A.
5. **Message isolation.** Future message-listing queries filter by `location_id`. Moot today (no list endpoint) but write the test now so anyone adding one has to pass it.
6. **Unknown-tenant call.** `/incoming-call` with an unassigned `To` → TwiML apology. **Not** a fallback to any default location.
7. **Timezone correctness.** Fixed clock 02:00 UTC 2026-04-20, location A in `America/Chicago`: `buildSystemPrompt(A, now)` reports "Sunday, April 19" "9:00 PM." Location B in `America/New_York`: same clock reports "Sunday, April 19" "10:00 PM."

---

### Explicitly out of scope (and why)

- **Per-tenant billing / usage metering beyond `call_analytics_daily`.** The `calls` table captures enough raw data to compute billing later; no need to commit to a billing model now.
- **Per-tenant ElevenLabs agent.** One shared agent with dynamic prompt + optional `voice_id` is the decision. Per-tenant agents multiply ops cost with marginal benefit.
- **Admin UI.** CLI (6.7) + token-gated HTTP (6.8) is the MVP. A real dashboard is a separate project.
- **Per-tenant booking window.** The `reservation_tsrange` IMMUTABLE function is the blocker; making it variable requires either a generated column on `reservations` or a trigger-maintained `tsrange`. Keep 90 min global until a tenant actually asks.
- **Postgres RLS.** Defense-in-depth is tempting but the app layer already has the tenant in hand; RLS adds debugging cost without solving a current attack.
- **DB sharding / per-tenant database.** Shared schema is more than adequate at the projected scale.
- **Non-restaurant verticals (salons, spas, barbershops).** Neutral tenancy naming is the only preparation done now. When the first salon tenant lands, that's its own phase: a new `vertical` CHECK value, a parallel domain schema (likely `appointments` / `services` / `staff` / `resources`), a parallel set of tool handlers, and a dispatch layer that picks the right handler set from `location.vertical`. Trying to unify restaurants and salons into one abstract "bookable resource" model *now* would be over-engineering for a vertical we haven't sold.
- **External booking/ordering integrations (OpenTable / Resy / Square / Toast).** Schema door is open via `reservations.external_provider` + `external_id`. Adapter code is a future phase — it will replace `findConflictingTableIds` + `addReservation` with provider-specific calls, with the local `reservations` table becoming a cache + audit log.
- **Restaurant groups with fine-grained role-based admin access** (owner vs. manager vs. host). `accounts` supports the *data* shape; auth and roles are a separate project.

---

## Summary — task order

```
Phase 1 (DB)    →  Phase 2 (Security)  →  Phase 3 (Reliability)
                →  Phase 4 (Experience)
                →  Phase 5 (Deploy)
                →  Phase 6 (Multi-Tenant Refactor)
```

Phases 1–5 are complete. Phase 6 supersedes the originally-planned "ops polish" — hot-reloaded config and `/analytics` are delivered as sub-tasks 6.3 and 6.9 of the multi-tenant work. Within Phase 6, the critical path is **6.1 → 6.2 → 6.3 → 6.4** (preflight → schema → backfill → code threading + constraint swap). 6.5 (timezone) can land any time after 6.4; it's grouped with the refactor because fixing it is nearly free while `buildSystemPrompt` is being refactored anyway. 6.6 depends on 6.4's NOTIFY payload update. 6.7 → 6.8 → 6.9 are largely independent and can run in parallel. 6.10 is the final cutover and must follow everything else.
