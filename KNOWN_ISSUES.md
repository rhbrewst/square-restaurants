# Known issues

Bugs and design limitations that are surfaced and understood but not yet fixed. Two purposes:

- **Anti-duplication** — before filing a fix, check that the bug isn't already here with a planned approach.
- **Onboarding context** — a new collaborator (human or agent) should read this alongside `ARCHITECTURE.md` to know what's deliberately broken vs. accidentally broken.

Format per entry:
- **What** — observed behaviour
- **Where** — file/path/line of the offending code (best-effort; rot is OK as long as the symptom and module are still locatable)
- **Fix sketch** — the smallest change that would resolve it

Move an entry into a commit message and delete it from this file when fixed. Don't strikethrough; the git history is the audit trail.

> Process note: when a fix lands, the PR description should call out which entry it closes, and the commit should delete the entry from this file in the same diff.

---

## Bugs

### 1. `check_availability` ignores caller seating preferences

- **What** — A caller can say "I'd like to sit on the patio" and have the agent acknowledge the preference, but `book_reservation` assigns whatever table comes first by `(capacity ASC, id ASC)`. On The Tide House, a 2-top booking with patio preference was assigned `B1` (bar) over `P1` (patio) because `B1` sorts first alphabetically. The preference *is* saved into `reservations.special_requests` for the host, but the table assignment doesn't honor it. Real customer-facing on a real call (2026-04-25, reservation `10f04a75`).
- **Where** — `src/tools.js:236-241` (`check_availability`'s `suitableTables` sort + `freeTable` pick). The host-side note path is fine; the assignment logic is the problem.
- **Fix sketch** — Add an optional `seating_preference` parameter to `check_availability` (matched against `location_tables.location_label`). When supplied, prefer tables whose label matches; fall back to the current behaviour only if no preferred-and-free table exists. Tool description tells the model to capture and forward the preference. `book_reservation` already calls `check_availability` internally — wire the param through.

### 2. `test/tenantIsolation.test.js` writes to the prod DB

- **What** — The integration tests for tenant isolation run against `DATABASE_URL`, which in this repo points at the production Railway DB. The reservations they `INSERT` fire `reservation_notify` → the live LISTEN client → real Twilio API calls to fake `555-01xx` numbers, which Twilio rejects with error 21211. Billable, log-noisy, and conflates real and synthetic data (e.g. the `test-diner` row that's been sitting in `locations` since the first test run).
- **Where** — `test/tenantIsolation.test.js`; collateral artifact in `locations` table (`id = 'test-diner'`).
- **Fix sketch** — Either (a) gate the test on `process.env.NODE_ENV !== 'production'` and document a separate `TEST_DATABASE_URL`, or (b) wrap each test in a transaction that rolls back so no NOTIFY actually fires. (b) is harder because pg `LISTEN` is connection-scoped; the cleanest path is (a) plus a docker-compose Postgres for local CI. Also delete the `test-diner` row from prod `locations` once the test is migrated.

### 3. `scripts/create-location.js` ignores `seating.wheelchair_accessible_tables`

- **What** — `scripts/backfill-tenant.js` reads `restaurant.seating.wheelchair_accessible_tables` (a list of table IDs) and maps it onto `location_tables.wheelchair_accessible BOOLEAN` per row. The new onboarding CLI doesn't — it only honors a per-table `wheelchair_accessible` flag. Surfaced when seeding The Tide House: `M1`/`M2` are listed under `seating.wheelchair_accessible_tables` in the JSON but came back from the DB with `wheelchair_accessible: false`. The column isn't read by any tool today (accessibility info flows through `config.accessibility.note`), so no caller-visible breakage — yet.
- **Where** — `scripts/create-location.js:upsertTables`; compare against `scripts/backfill-tenant.js:30-32, 67`.
- **Fix sketch** — Mirror `backfill-tenant.js`: build a `Set` of `seating.wheelchair_accessible_tables` IDs once, then OR the per-table flag with `wheelchairIds.has(t.id)`. Or pick a single canonical source (per-table flag, derived from the seating list at import time) and update the template + backfill in lockstep.

### 4. ElevenLabs WS close handler logs "Call is not in-progress" on every clean call

- **What** — When a call ends normally, Twilio sends `stop`, then closes the media WebSocket; ElevenLabs subsequently closes its WS with code 1005 ("no status received"). Our `elWs.on('close')` handler treats codes other than 1000/1001 as unexpected, attempts to inject a TwiML fallback via `twilioClient.calls(callSid).update(...)`, and gets back `Call is not in-progress. Cannot redirect.` Result: every call ends with a benign-but-noisy error line and a counterfactual "fallback attempted" log.
- **Where** — `src/server.js:316-339`.
- **Fix sketch** — Track call-completion state on the session (e.g. set a flag in the `stop` handler or after `endCall` runs once) and skip the TwiML fallback when the call already ended cleanly. Alternatively, add `1005` to the "expected" close-code list. Risk: code 1005 sometimes does indicate a real abnormal close that *should* be apologised for, so prefer the state-flag approach.

---

## Limitations (deliberate or out-of-scope)

These are not bugs in the sense of unintended behaviour — they're known shape-of-the-product constraints. Listed here so they don't keep getting re-discovered.

### A. ElevenLabs agent + voice are globally shared

- **What** — Every tenant uses `process.env.ELEVENLABS_AGENT_ID` and the voice configured on that one agent in the ElevenLabs dashboard. Per-tenant persona varies via system prompt + first message, not via a different agent.
- **Where** — `src/server.js:164`. The `locations.elevenlabs_agent_id` and `elevenlabs_voice_id` columns are populated by `locationStore.fetchHydrated` (`src/locationStore.js:22`) but never read.
- **Fix sketch** — Read `location.elevenlabs_agent_id` (falling back to env), pass to the EL WS URL, and override `voice_id` in `conversation_initiation_client_data` if `elevenlabs_voice_id` is set. Out of Phase 6's scope; defer until a tenant actually needs a different voice.

### B. Twilio account is shared across tenants

- **What** — All tenant `twilio_number` values must live under one Twilio account (`TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN`). A future "BYO Twilio" scenario isn't supported.
- **Where** — `src/server.js:332`, `src/sms.js:6`.
- **Fix sketch** — Add `twilio_account_sid` / `twilio_auth_token` to `locations` (encrypted) and look them up per-tenant. Real work; not on the roadmap.

### C. `formatPhone` in `sms.js` assumes US numbers

- **What** — `formatPhone(raw)` strips non-digits and prepends `+1` if missing. A non-US tenant would route SMS incorrectly.
- **Where** — `src/sms.js:9-12`.
- **Fix sketch** — When a non-US tenant is added, take a country code from `location.config.country` (or similar) and use it instead of hardcoded `1`. Or use libphonenumber-js for parsing. No customer impact today since both seeded tenants are US.

### D. SMS delivery is gated on A2P 10DLC registration

- **What** — Twilio accepts every SMS the code sends and assigns a SID, but US carriers reject delivery with error 30034 until the FROM number completes A2P 10DLC registration. Code path is verified on every booking; delivery isn't.
- **Where** — Regulatory, not code. Twilio Console → Messaging → Regulatory Compliance.
- **Fix sketch** — Sole-Proprietor or Toll-Free path; or wait until LLC formation and register Standard Brand. See `~/.claude/projects/.../memory/project_sms_delivery_gated.md` for the decision history.

### E. `calls.location_id` is intentionally NULLABLE

- **What** — Unlike `reservations.location_id` and `messages.location_id` (both NOT NULL), `calls.location_id` allows NULL. The `callLogger.startCall()` skeleton INSERT happens before the Twilio `start` event has resolved the tenant, so the row is briefly NULL until `endCall`'s UPDATE backfills it. NOT NULL would break every call.
- **Where** — `src/callLogger.js:36-39`; documented in `ARCHITECTURE.md` invariant #18 and the Phase 6.6 block in `scripts/migrate.js`.
- **Fix sketch** — Restructure `startCall` to defer the INSERT until `setCallInfo` has the location. Adds a "no DB row yet" state to the logger; transcript/tool-call events arriving before `setCallInfo` would have to buffer. Possible but not justified by current pain.
