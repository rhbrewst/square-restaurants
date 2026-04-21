/**
 * locationStore tests — require a reachable Postgres with 6.2 migration applied
 * and the Ember Room backfill in place. Run via:
 *
 *   DATABASE_URL=postgresql://postgres@localhost:5433/railway npm test
 *
 * Skips gracefully if no DB is reachable so CI without a DB doesn't fail.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const pool   = require('../src/db');
const store  = require('../src/locationStore');

let dbReachable = false;

before(async () => {
  try {
    await pool.query('SELECT 1');
    dbReachable = true;
  } catch (_) {
    dbReachable = false;
  }
});

after(async () => {
  await pool.end().catch(() => {});
});

test('loadByTwilioNumber returns hydrated location with tables', async (t) => {
  if (!dbReachable) return t.skip('DB unreachable');
  store._resetForTests();
  const num = await emberTwilioNumber();
  const location = await store.loadByTwilioNumber(num);
  assert.ok(location, 'should find ember-room');
  assert.equal(location.id, 'ember-room');
  assert.equal(location.name, 'The Ember Room');
  assert.equal(location.timezone, 'America/Chicago');
  assert.ok(Array.isArray(location.tables));
  assert.equal(location.tables.length, 10);
  assert.ok(location.tables.some((t) => t.id === 'T1'));
});

test('loadByTwilioNumber returns null for unknown number', async (t) => {
  if (!dbReachable) return t.skip('DB unreachable');
  store._resetForTests();
  const result = await store.loadByTwilioNumber('+19999999999');
  assert.equal(result, null);
});

test('cache hit within TTL returns stale data; invalidate forces refresh', async (t) => {
  if (!dbReachable) return t.skip('DB unreachable');
  store._resetForTests();
  const num = await emberTwilioNumber();
  const first = await store.loadByTwilioNumber(num);
  assert.equal(first.name, 'The Ember Room');

  await pool.query(`UPDATE locations SET name = $1 WHERE id = 'ember-room'`, ['Temporarily Renamed']);
  try {
    const stillCached = await store.loadByTwilioNumber(num);
    assert.equal(stillCached.name, 'The Ember Room', 'expected stale cached value');

    store.invalidate('ember-room');
    const fresh = await store.loadByTwilioNumber(num);
    assert.equal(fresh.name, 'Temporarily Renamed');
  } finally {
    await pool.query(`UPDATE locations SET name = $1 WHERE id = 'ember-room'`, ['The Ember Room']);
    store.invalidate('ember-room');
  }
});

test('inactive location is not returned by loadByTwilioNumber', async (t) => {
  if (!dbReachable) return t.skip('DB unreachable');
  store._resetForTests();
  const num = await emberTwilioNumber();
  await pool.query(`UPDATE locations SET active = FALSE WHERE id = 'ember-room'`);
  try {
    const result = await store.loadByTwilioNumber(num);
    assert.equal(result, null);
  } finally {
    await pool.query(`UPDATE locations SET active = TRUE WHERE id = 'ember-room'`);
    store.invalidate('ember-room');
  }
});

test('loadById returns the same hydrated shape', async (t) => {
  if (!dbReachable) return t.skip('DB unreachable');
  store._resetForTests();
  const location = await store.loadById('ember-room');
  assert.equal(location.id, 'ember-room');
  assert.equal(location.tables.length, 10);
});

test('loadById returns null for unknown id', async (t) => {
  if (!dbReachable) return t.skip('DB unreachable');
  store._resetForTests();
  const result = await store.loadById('does-not-exist');
  assert.equal(result, null);
});

async function emberTwilioNumber() {
  const r = await pool.query(`SELECT twilio_number FROM locations WHERE id = 'ember-room'`);
  return r.rows[0].twilio_number;
}
