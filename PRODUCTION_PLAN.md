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

## Phase 6 — Operational polish

### Task 6.1 — Add `/analytics` endpoint

Expose the materialized view over HTTP for a future admin dashboard (or just for your own use):

```js
app.get('/analytics', async (req, res) => {
  const { days = 30 } = req.query;
  const result = await pool.query(
    `SELECT * FROM call_analytics_daily
     WHERE call_date >= NOW() - ($1 || ' days')::interval
     ORDER BY call_date DESC`,
    [parseInt(days)]
  );
  res.json(result.rows);
});
```

Protect this with a simple bearer token check (`req.headers.authorization === 'Bearer ' + process.env.ADMIN_TOKEN`) before exposing to the internet.

### Task 6.2 — Hot-reload restaurant config from the database

Currently changing hours or a menu price requires editing `restaurant.json` and redeploying. For a real client, this is unacceptable.

- Create a `restaurant_config` table with a single row: `id SERIAL PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW()`
- Seed it on migration with the current `restaurant.json` contents
- In `src/server.js`, load config from the DB at startup and re-load it via a `LISTEN 'config_updated'` channel whenever management updates it
- The `buildSystemPrompt()` function and all tool handlers should read from the in-memory config object rather than requiring the JSON file directly
- A future admin UI or a simple `PATCH /config` endpoint (admin-token protected) can update the `jsonb` column and fire `pg_notify('config_updated', 'reload')`

This makes menu and hours changes instant with no redeployment.

---

## Summary — task order

```
Phase 1 (DB)    →  Phase 2 (Security)  →  Phase 3 (Reliability)
                →  Phase 4 (Experience)
                →  Phase 5 (Deploy)
                →  Phase 6 (Ops)
```

Phases 2, 3, and 4 can proceed in parallel once Phase 1 is complete. Phase 5 requires all of 1–4. Phase 6 is post-launch polish.
