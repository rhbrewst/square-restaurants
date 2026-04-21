# Architecture

> **Living document.** Whenever a change alters the call flow, adds/removes a module, changes the DB schema, introduces a new external service, or changes an invariant listed below, update this file in the same commit. If you touch something and this doc no longer matches reality, fix the doc — stale architecture docs are worse than none.

---

## 1. What this is

A voice AI reservations agent for a single restaurant ("The Ember Room"). A caller dials a Twilio number, speaks to an ElevenLabs Conversational AI agent (running Claude under the hood), and can:

- Ask about the restaurant (hours, policies, menu, accessibility, etc.)
- Check availability and book a reservation
- Cancel a reservation
- Leave a message for management

State lives in Postgres (Railway-managed). SMS confirmations and day-before reminders are fired by the Node server in response to Postgres `NOTIFY` events.

---

## 2. Runtime topology

```
 Caller's phone
      │  PSTN
      ▼
 ┌───────────┐     HTTP POST /incoming-call
 │  Twilio   │ ───────────────────────────────────┐
 │ (SIP/PSTN)│                                    │
 └─────┬─────┘                                    ▼
       │ Media Streams (WSS)              ┌──────────────┐
       │  μ-law 8kHz audio                │  Node server │
       └─────────────────────────────────▶│  (src/server │
                                          │     .js)     │
                                          └──┬───────┬───┘
                                 WSS         │       │   Postgres protocol
                        ┌─────────────────── │       │   (pool + dedicated
                        ▼                    │       │    LISTEN client)
                 ┌──────────────┐            │       ▼
                 │  ElevenLabs  │            │   ┌───────────┐
                 │  Convai      │            │   │ Postgres  │
                 │  (Claude)    │            │   │ (Railway) │
                 └──────┬───────┘            │   └─────┬─────┘
                        │ client_tool_call   │         │ pg_notify
                        ▼                    │         │ channels:
                 ┌──────────────┐            │         │   new_reservation
                 │  tools.js    │────────────┘         │   reminder_due
                 │  handlers    │  pool.query(...)     │
                 └──────────────┘                      │
                                                       │
                                         ┌─────────────┘
                                         │  (via sms.js)
                                         ▼
                                   ┌───────────┐
                                   │  Twilio   │ SMS
                                   │   SMS     │─────▶ Caller
                                   └───────────┘
```

### Call lifecycle (happy path)

1. **Inbound PSTN call** hits Twilio; Twilio POSTs `/incoming-call` on our server.
2. Server validates the Twilio signature (prod only), **resolves the tenant via `locationStore.loadByTwilioNumber(req.body.To)`** — unknown number → `UNKNOWN_NUMBER_TWIML` + hangup; lookup error → `TENANT_UNAVAILABLE_TWIML` + hangup — captures `CallSid/From/To/location` into `pendingCalls`, and returns TwiML that opens a Media Stream WebSocket to `wss://<host>/media-stream`.
3. Twilio opens the WS → `wss.on('connection', ...)` runs. We:
   - Start a `callLogger` session (inserts an empty `calls` row, returns its id for a later UPDATE).
   - Open a second WS to ElevenLabs (`wss://api.elevenlabs.io/v1/convai/conversation`).
   - Wait for **both** the EL WS `open` event and Twilio's `start` event (which carries the `CallSid` → `pendingCalls` → `location`). Once both fire, send `conversation_initiation_client_data` with a system prompt built from the tenant's config and a tenant-specific first message.
4. **Audio bridge:** Twilio `media` frames are forwarded to ElevenLabs as `user_audio_chunk`; ElevenLabs `audio` events are forwarded back to Twilio as `media`.
5. **Tool calls:** ElevenLabs emits `client_tool_call` messages; server runs `handleToolCall(name, input, location)` and returns `client_tool_result`. Tool handlers read/write Postgres directly, scoped by `location.id`. Disabled tools (not in `location.enabled_tools`) are rejected at dispatch as defense-in-depth — the primary gate is that the system prompt only describes enabled tools.
6. **End of call:** Twilio sends `stop` (or either WS closes) → `logger.endCall()` UPDATEs the `calls` row with transcript, tools called, duration, outcome, and cost estimate.
7. **Post-booking SMS:** `INSERT` on `reservations` fires the `reservation_notify` trigger → `pg_notify('new_reservation', ...)` → the server's dedicated LISTEN client receives it → `sms.sendSmsConfirmation` sends the SMS.
8. **Reminders:** `src/scheduler.js` (node-cron) calls `queue_upcoming_reminders()` hourly. Reservations due in 23–25h are flipped to `reminder_sent = TRUE` and `pg_notify('reminder_due', ...)` is emitted → server sends SMS.

### Call lifecycle (degraded paths)

- **ElevenLabs WS closes unexpectedly mid-call** → `elWs.on('close')` with non-1000/1001 code injects TwiML via Twilio REST (`calls(callSid).update(...)`) that apologises and hangs up, so the caller doesn't hear silence.
- **Rate limit or invalid signature** → `/incoming-call` responds 429 or 403 before TwiML is generated; Twilio plays its default failure message.
- **DB down** → `/health` returns 503; Railway restart policy kicks in on repeated failures. In-flight calls still work for read-only tools until they hit a DB query.
- **SIGTERM (Railway redeploy)** → `shutdown()` stops accepting new WS, waits up to 45s for active calls to drain, then force-closes, stops the scheduler, closes the LISTEN client, and calls `pool.end()`.

---

## 3. Source layout

```
src/
├── server.js           — HTTP + WS entrypoint; Twilio↔ElevenLabs bridge; LISTEN/NOTIFY; shutdown
├── tools.js            — TOOL_DEFINITIONS schema + async handlers dispatched by handleToolCall
├── db.js               — shared pg Pool (max 10, SSL in prod)
├── reservationStore.js — findConflictingTableIds, addReservation, toMinutes
├── messageStore.js     — addMessage
├── callLogger.js       — per-call session object; inserts calls row at start, UPDATEs at end
├── sms.js              — sendSmsConfirmation, sendSmsReminder (Twilio REST)
├── scheduler.js        — node-cron jobs (reminders, partition rotation, analytics refresh)
├── systemPrompt.js     — pure buildSystemPrompt(location, now); filters tools by enabled_tools
├── locationStore.js    — tenant lookup with 60s cache, busted by NOTIFY 'location_config_updated'
└── conversation.js     — text-only dev harness; fetches ember-room from DB at startup

scripts/
├── migrate.js          — idempotent DDL; run before first deploy and after any schema change
├── backfill-tenant.js  — seeds Ember Room into locations + location_tables; stamps existing
│                         reservations/messages/calls with location_id. Idempotent.
├── rollback-6.2.sql    — documented reversal of Task 6.2's schema additions
├── rollback-6.4.sql    — documented reversal of Task 6.4's constraint swap + NOT NULL flip
├── dev.js              — boots server + ngrok, rewires Twilio webhook to current ngrok URL
└── report.js           — CLI analytics; hits call_analytics_daily materialized view

config/
└── restaurant.json     — hours, menu, policies, tables, FAQs. Seed source for `locations.config`
                          during backfill; no longer require()d at runtime (removed in 6.4).
                          Edits flow through `scripts/backfill-tenant.js` or a direct
                          UPDATE on locations (triggering the hot-reload NOTIFY).

data/                   — legacy JSONL/JSON artifacts from pre-Postgres era; not read at runtime.
                          Safe to delete once we're confident nothing imports them. Gitignored.
```

---

## 4. Database

Migration: `scripts/migrate.js`. Idempotent. Extensions required: `pgcrypto`, `btree_gist`, `pg_trgm`.

### Tables

**`accounts`** — owner / billing layer (added in 6.2). One account may own many locations. Soft-delete via `active BOOLEAN`.

**`locations`** — per-tenant venue (added in 6.2). Neutral name so future verticals (salons, spas) can attach parallel domain schemas without renaming FKs — the `vertical` column is the seam. Unique `twilio_number` is how inbound calls resolve a tenant. `config` is the JSONB copy of the old `restaurant.json` shape; backfilled for Ember Room in 6.3. `enabled_tools TEXT[]` is per-tenant feature flags. `timezone` replaces the single-tenant top-level field once 6.3 lands. `AFTER UPDATE` trigger emits `location_config_updated` NOTIFY so the cache invalidates without a redeploy.

**`location_tables`** — restaurant tables, tenant-scoped (added in 6.2). Composite PK `(location_id, id)` means "T1" is local to a location; there is no global T1.

**`reservations`** — the core booking table.
- PK: 8-char hex `id` (DB-generated via `encode(gen_random_bytes(4), 'hex')`).
- **Invariant:** `no_double_booking` EXCLUDE constraint using `btree_gist`, **tenant-scoped since 6.4**: `(location_id WITH =, table_id WITH =, reservation_tsrange(date, time) WITH &&)` WHERE `status = 'confirmed'`. Two confirmed reservations on the same `(location_id, table_id)` whose 90-minute `tsrange` windows overlap cannot coexist; different locations with the same local `table_id` do not conflict.
- `location_id TEXT NOT NULL REFERENCES locations(id)` (added 6.2, flipped NOT NULL in 6.4).
- Primary range-scan index is `idx_reservations_location_date (location_id, date)` (6.4; replaced the date-only index).
- `external_provider` / `external_id` (6.2, nullable) reserve a hook for future OpenTable / Resy / Square / Toast integration — `table_id` stays as the local cache.
- Triggers: `set_updated_at` (BEFORE UPDATE), `notify_new_reservation` (AFTER INSERT → `pg_notify('new_reservation', ...)`, payload includes `location_id` since 6.4).
- Statuses: `confirmed | cancelled | no_show | completed`.

**`messages`** — management callback queue. Plain table, `unread | read | resolved`. `location_id` is still nullable; NOT NULL flip is a follow-up deploy after 6.4 has baked.

**`calls`** — one row per phone session. **Partitioned by month** on `started_at`. PK is composite `(id, started_at)` because Postgres requires the partition key in every unique constraint. Partitions for current + next 2 months are seeded at migration time; `ensure_next_calls_partition()` (run by `pg_cron` on the 25th) creates the next one.
- `transcript` and `tools_called` are `jsonb` with GIN indexes.
- `reservation_id` / `message_id` FKs link a call to its outcome.
- Gained `location_id` in 6.2 (nullable; NOT NULL flip is a follow-up deploy). The FK to `locations` propagates to each monthly partition automatically (PG 12+ cascades FKs on partitioned parents).

**`call_analytics_daily`** — materialized view aggregating `calls` by day. Refreshed nightly by `pg_cron`. `scripts/report.js` and any future `/analytics` endpoint read from this, not from `calls` directly. Rewritten in 6.9 to group by `location_id`.

### NOTIFY channels

| Channel | Emitted by | Consumed by |
|---|---|---|
| `new_reservation` | AFTER INSERT trigger on `reservations` | `server.js` LISTEN client → `sms.sendSmsConfirmation`. Payload includes `location_id` (6.4); consumed in 6.6 for per-tenant SMS routing. |
| `reminder_due` | `queue_upcoming_reminders()` pg_cron job (hourly) | `server.js` LISTEN client → `sms.sendSmsReminder`. Payload includes `location_id` (6.4). |
| `location_config_updated` | AFTER UPDATE trigger on `locations` | `server.js` LISTEN client → `locationStore.invalidate(msg.payload)` |

The LISTEN client in `server.js` is a **dedicated** `pg.Client`, not checked out from the pool — `LISTEN` requires a long-lived connection. On error it auto-reconnects with a 5s backoff.

### Scheduled jobs

Railway's managed Postgres image does not ship `pg_cron`, so the three jobs below run from the Node process via `node-cron` (`src/scheduler.js`). The SQL functions they call still live in Postgres — `scheduler.js` only schedules the calls.

| Job | Schedule (UTC) | What it does |
|---|---|---|
| `queue-reminders`   | `0 * * * *`   | Flip due reservations' `reminder_sent`, emit `reminder_due` notifies |
| `ensure-partition`  | `0 0 25 * *`  | Create next month's `calls` partition |
| `refresh-analytics` | `0 3 * * *`   | `REFRESH MATERIALIZED VIEW CONCURRENTLY call_analytics_daily` |

Jobs are registered after `server.listen()` alongside the LISTEN client, and torn down in `shutdown()` before `pool.end()`. A per-job re-entry guard prevents overlap if a run takes longer than its interval.

---

## 5. External services

| Service | What it does | Credentials | Failure mode |
|---|---|---|---|
| **Twilio Voice** | PSTN number, Media Streams WebSocket, TwiML | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER` | Webhook signature invalid → 403; rate limit → 429 |
| **Twilio SMS** | Confirmations & reminders | same as above | Logged; reservation still exists even if SMS fails |
| **ElevenLabs Conversational AI** | STT + LLM (Claude) + TTS in one pipe | `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID` | Unexpected WS close → TwiML fallback injected via Twilio REST |
| **Postgres (Railway)** | All persistent state, pub/sub, cron | `DATABASE_URL` | `/health` returns 503; Railway restarts; in-flight calls partially degrade |
| **ngrok** | Local dev tunnel only | `NGROK_AUTH_TOKEN` | Dev-only |

The ElevenLabs agent must be configured in the ElevenLabs dashboard with three **Client**-type tools matching what `tools.js` expects: `get_restaurant_info`, `get_menu`, `check_availability`, `book_reservation`, `cancel_reservation`, `leave_message`. The system prompt and first message are injected at runtime via `conversation_initiation_client_data` — do not set them in the dashboard.

---

## 6. Environment variables

Required at startup (`src/server.js` crashes in prod if any are missing, warns in dev):

- `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID`
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`
- `DATABASE_URL`, `PUBLIC_URL`

Also used:
- `RESTAURANT_PHONE` — footer in SMS messages
- `NODE_ENV` — toggles Postgres SSL and the prod-vs-dev missing-env behaviour
- `PORT` — injected by Railway; defaults to 3000 locally

Keep `.env.example` in sync with every new variable added.

**Precedence:** command-line / shell-exported env vars win; `.env` fills gaps. All `require('dotenv').config()` calls use the default (no `override: true`) so an explicit `DATABASE_URL=... node src/server.js` always beats whatever is in the `.env` file. Do not re-introduce `override: true` — we hit a silent prod/local mix-up during the Phase 6 rehearsal because of it.

---

## 7. Invariants and non-obvious rules

These are the things most likely to bite future edits. If you change any of them, document the change here.

1. **Reservation IDs are lowercase 8-char hex.** The `cancel_reservation` handler `LOWER($1)` the input so callers can read codes with capital letters on the phone. Any UI that displays codes should preserve case-insensitivity.
2. **Booking window is 90 minutes.** Hard-coded in both the DB exclusion constraint (`reservation_tsrange` helper in `migrate.js`) and `reservationStore.findConflictingTableIds`. Changing this requires updating **both** places *and* re-running the migration.
3. **Valid reservation times are enumerated per tenant** in `location.config.reservation_policy.slots` / `weekend_slots`. `check_availability` rejects anything not on the list before ever hitting the DB.
4. **Last seating is 30 minutes before close.** Enforced in `check_availability`, derived from `location.config.hours[day].close`.
5. **The Twilio webhook signature middleware only runs if `PUBLIC_URL` is set.** This is deliberate so local dev without a stable public URL still works, but in production `PUBLIC_URL` **must** be set — the startup env check guarantees that.
6. **`app.set('trust proxy', 1)` is required on Railway.** Without it, `express-rate-limit` throws a `ValidationError` because `X-Forwarded-For` is unreachable.
7. **`pendingCalls` Map is keyed by `CallSid`** and populated on `/incoming-call` so we can attach caller number to the WebSocket session on the `start` event. It's deleted on `start` to prevent unbounded growth; orphans (no matching WS) are effectively leaks, but low volume.
8. **`callLogger` inserts the calls row *synchronously at start*** (via `dbRowPromise`) so the id is available before any transcript data arrives. If that initial insert fails, `endCall` logs and drops the call data — we prefer not to block the phone call on DB availability. The INSERT explicitly writes `started_at = date_trunc('milliseconds', NOW())` — **not** the column's `DEFAULT NOW()` — because the `endCall` UPDATE uses `(id, started_at)` in its WHERE clause and JS `Date` is ms-precision while Postgres `timestamptz` is µs-precision. Without the truncation, the returned value is rounded to ms when it becomes a JS Date, the stored value keeps µs, and the UPDATE silently matches zero rows — every call becomes an orphan skeleton and no error is logged.
9. **Partitioning gotcha:** any query against `calls` that doesn't include a `started_at` filter will scan all partitions. The indexes are per-partition, so always scope queries by time range when possible.
10. **`LISTEN` clients don't auto-reconnect on their own.** The handler in `server.js` sets a 5s timer on `.on('error')`; if you refactor that, preserve the reconnect.
11. **Graceful shutdown order matters:** stop the scheduler, then close the notify client, then the pool. Closing the pool first leaves in-flight scheduler queries or the LISTEN connection dangling and produces an "SSL error: unexpected eof" in Postgres logs.
12. **Do not commit `data/`.** It's gitignored legacy from the JSON-file era. Production reads nothing from it.
13. **Scheduled jobs run in the Node process, not Postgres.** If the service has zero replicas or is mid-restart at the scheduled time, that tick is skipped — the jobs are idempotent, so a missed run is not fatal, but if you scale to >1 replica you will get duplicate ticks unless you add leader election.
14. **Tenant-local "now" is derived from `location.timezone`, not the server clock.** `buildSystemPrompt` (`src/systemPrompt.js`), `check_availability`, `cancel_reservation`'s `hoursUntil` calc, and SMS date formatting all compute "now" via Luxon `DateTime.now().setZone(location.timezone)`. The server runs in UTC on Railway; using `new Date()` here silently shifts day-of-week and past/future decisions by the UTC offset.
15. **Tenant resolution is by inbound Twilio `To` number** via `locationStore.loadByTwilioNumber`. Unknown numbers get `UNKNOWN_NUMBER_TWIML` and a hangup; lookup errors (DB unreachable, etc.) get `TENANT_UNAVAILABLE_TWIML` — **never a silent fallback to a default tenant**. The cache TTL is 60s; config changes in the DB propagate sooner via `LISTEN location_config_updated` → `locationStore.invalidate`.
16. **Every domain read/write must scope by `location_id`.** `reservations.no_double_booking` enforces this at the DB for bookings. `check_availability`, `cancel_reservation`, `addReservation`, `addMessage`, and `callLogger.setCallInfo` all pass `location.id` explicitly. Forgetting to scope a new query leaks data across tenants.
17. **`conversation_initiation_client_data` must wait for both the ElevenLabs WS `open` event and the Twilio `start` event.** The tenant isn't known until `start` resolves the `CallSid` → `pendingCalls` → `location`; the EL WS opens strictly before that. `wss.on('connection', ...)` uses a `startP` promise to gate the init send.
18. **NOT NULL on `messages.location_id` and `calls.location_id` is deferred to a follow-up deploy** ~24h after 6.4 ships. New code always writes `location_id`; once we've proven no row leaks through with NULL, a second migration flips the NOT NULL. Until then the columns stay permissive.

---

## 8. Build phases and status

| Phase | Scope | Status |
|---|---|---|
| 1 — DB foundation | Postgres schema, migration, stores, LISTEN/NOTIFY | ✅ Done |
| 2 — Security | Twilio signature, rate limit, env audit | ✅ Done |
| 3 — Reliability | `/health`, SIGTERM drain, EL drop recovery, phone validation | ✅ Done |
| 4 — Caller experience | SMS confirm+reminder, `cancel_reservation` tool | ✅ Done |
| 5 — Deployment | Railway config, prod migration, node-cron, Twilio webhook | ✅ Done |
| 6 — Multi-tenant refactor | `accounts`/`locations`, per-tenant Twilio, hot-reloaded config, `/analytics` by location | In progress |

The full task-by-task playbook is in `PRODUCTION_PLAN.md`; this doc describes the *current* state, not the plan.

---

## 9. How to update this doc

**When you should edit this file:**

- You added, removed, or renamed a file in `src/` or `scripts/`.
- You changed the call lifecycle — who talks to whom, what order, what protocol.
- You changed the DB schema (new table, new column, new constraint, new trigger, new NOTIFY channel, new pg_cron job).
- You added, removed, or changed the role of an external service.
- You added or removed a required environment variable.
- You broke or introduced one of the invariants in §7.
- You moved a phase in §8 from pending → done or vice versa.

**When you should NOT edit this file:**

- Bug fixes that don't change behaviour at the module-interface level.
- Copy/prompt tweaks.
- Refactors within a single file that keep the public API the same.

**Style:**

- Short sections over long ones. Prune aggressively — this doc is only useful if it stays accurate.
- Prefer links/references (`src/server.js:355`) over reproducing code.
- When deleting a section, consider whether a one-line "Removed X in favour of Y" line in its place would help readers of older commits.

If you find this doc contradicts the code: **the code wins, and your job is to fix the doc.**
