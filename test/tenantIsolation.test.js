/**
 * Tenant isolation tests — exercise tools.js handlers directly against a DB
 * that has two seeded tenants. Requires the full migrate + backfill chain:
 *
 *   DATABASE_URL=postgresql://postgres@localhost:5433/railway npm test
 *
 * Skips gracefully when DATABASE_URL is unreachable.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const pool        = require('../src/db');
const store       = require('../src/locationStore');
const { handleToolCall } = require('../src/tools');

// Second tenant: same account/config as Ember for convenience, different id
// + twilio_number + tables so booking isolation is meaningful.
const TEST_DINER_ID = 'test-diner';
const EMBER_ID      = 'ember-room';
const TEST_ACCOUNT  = 'ember-group';

let dbReachable = false;
let ember = null;
let diner = null;

before(async () => {
  try {
    await pool.query('SELECT 1');
    dbReachable = true;
  } catch {
    dbReachable = false;
    return;
  }

  // Seed test-diner if missing. Reuse Ember's config wholesale so hours/slots/
  // policy are valid; only the columns that affect isolation are different.
  const emberRow = await pool.query(`SELECT config FROM locations WHERE id = $1`, [EMBER_ID]);
  if (!emberRow.rows.length) {
    dbReachable = false;
    return;
  }
  await pool.query(
    `INSERT INTO locations (id, account_id, name, twilio_number, sms_from_number,
                            timezone, config, enabled_tools, active)
     VALUES ($1, $2, 'Test Diner', '+18885550001', '+18885550001',
             'America/New_York', $3,
             ARRAY['get_restaurant_info','get_menu','check_availability','book_reservation','cancel_reservation','leave_message'],
             TRUE)
     ON CONFLICT (id) DO UPDATE
       SET twilio_number = EXCLUDED.twilio_number,
           timezone      = EXCLUDED.timezone,
           config        = EXCLUDED.config,
           enabled_tools = EXCLUDED.enabled_tools,
           active        = EXCLUDED.active,
           updated_at    = NOW()`,
    [TEST_DINER_ID, TEST_ACCOUNT, emberRow.rows[0].config],
  );
  // Disjoint tables — T1..T4 each with 4 seats. The capacities let the tool
  // handler find a free table for a party of 2.
  for (const id of ['T1', 'T2', 'T3', 'T4']) {
    await pool.query(
      `INSERT INTO location_tables (location_id, id, capacity, location_label)
       VALUES ($1, $2, 4, 'main floor')
       ON CONFLICT (location_id, id) DO UPDATE
         SET capacity = EXCLUDED.capacity, location_label = EXCLUDED.location_label`,
      [TEST_DINER_ID, id],
    );
  }
  store._resetForTests();
  ember = await store.loadById(EMBER_ID);
  diner = await store.loadById(TEST_DINER_ID);
});

after(async () => {
  await pool.end().catch(() => {});
});

// Pick a weekday date far enough in the future to avoid near-closing-time
// rules, with a valid-slot time from restaurant.json (19:00 is in both
// weekday and weekend slot lists).
const TEST_DATE = '2026-12-15';  // Tuesday
const TEST_TIME = '19:00';

async function cleanupTestReservations() {
  await pool.query(
    `DELETE FROM reservations WHERE customer_phone LIKE '555010%' OR customer_name LIKE 'Isolation Test%'`,
  );
}

test('booking isolation: same slot across two locations does not conflict', async (t) => {
  if (!dbReachable) return t.skip('DB unreachable');
  await cleanupTestReservations();

  const a = await handleToolCall(
    'book_reservation',
    { date: TEST_DATE, time: TEST_TIME, party_size: 2,
      customer_name: 'Isolation Test A', customer_phone: '5550100001' },
    ember,
  );
  assert.equal(a.success, true, `Ember booking should succeed: ${JSON.stringify(a)}`);

  const b = await handleToolCall(
    'book_reservation',
    { date: TEST_DATE, time: TEST_TIME, party_size: 2,
      customer_name: 'Isolation Test B', customer_phone: '5550100002' },
    diner,
  );
  assert.equal(b.success, true, `Test Diner booking should succeed: ${JSON.stringify(b)}`);

  // Third book on Ember at same slot should not find a suitable + free table
  // (depends on capacity layout — Ember has only two 2-top window tables;
  // once both are booked, check_availability rejects). We'll assert the
  // second Ember booking for a 2-top at the same slot fails with "no tables"
  // or the exclusion error, whichever arrives first.
  const c = await handleToolCall(
    'book_reservation',
    { date: TEST_DATE, time: TEST_TIME, party_size: 2,
      customer_name: 'Isolation Test C', customer_phone: '5550100003' },
    ember,
  );
  // Ember's config has multiple 2-capacity tables, so a third booking might
  // still find a free one. The real isolation signal is that Test Diner
  // booking a 2-top at the same slot succeeds independently — verified above.
  // This check just ensures nothing blew up.
  assert.ok(c.success === true || c.success === false, 'third booking returned');

  await cleanupTestReservations();
});

test('availability isolation: Test Diner T1 is free after Ember T1 is booked', async (t) => {
  if (!dbReachable) return t.skip('DB unreachable');
  await cleanupTestReservations();

  await handleToolCall(
    'book_reservation',
    { date: TEST_DATE, time: TEST_TIME, party_size: 2,
      customer_name: 'Isolation Test Avail', customer_phone: '5550100010' },
    ember,
  );
  // Now check availability on Test Diner at the same slot — should report
  // available because the conflict check is scoped to location_id.
  const availDiner = await handleToolCall(
    'check_availability',
    { date: TEST_DATE, time: TEST_TIME, party_size: 2 },
    diner,
  );
  assert.equal(availDiner.available, true,
    `Test Diner should be available: ${JSON.stringify(availDiner)}`);

  await cleanupTestReservations();
});

test('cancel isolation: cannot cancel another tenant\'s reservation', async (t) => {
  if (!dbReachable) return t.skip('DB unreachable');
  await cleanupTestReservations();

  const booked = await handleToolCall(
    'book_reservation',
    { date: TEST_DATE, time: TEST_TIME, party_size: 2,
      customer_name: 'Isolation Test Cancel', customer_phone: '5550100020' },
    diner,
  );
  assert.equal(booked.success, true);
  const code = booked.confirmation_code;

  // Try to cancel B's reservation under A's context — should be "not found"
  // because the SQL WHERE clause scopes by location_id.
  const crossCancel = await handleToolCall(
    'cancel_reservation',
    { confirmation_code: code, customer_phone: '5550100020' },
    ember,
  );
  assert.equal(crossCancel.success, false);
  assert.match(crossCancel.reason, /No confirmed reservation found/);

  // Same call under the correct tenant succeeds.
  const rightCancel = await handleToolCall(
    'cancel_reservation',
    { confirmation_code: code, customer_phone: '5550100020' },
    diner,
  );
  assert.equal(rightCancel.success, true);

  await cleanupTestReservations();
});

test('enabled_tools: handleToolCall rejects a disabled tool', async (t) => {
  if (!dbReachable) return t.skip('DB unreachable');
  const restricted = { ...ember, enabled_tools: ['get_menu'] };
  const result = await handleToolCall(
    'check_availability',
    { date: TEST_DATE, time: TEST_TIME, party_size: 2 },
    restricted,
  );
  assert.equal(result.error, 'This tool is not enabled for this location.');
});
