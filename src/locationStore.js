/**
 * locationStore — tenant lookup with a 60s in-memory cache.
 *
 * Busted by NOTIFY 'location_config_updated' (wired in src/server.js) and by
 * TTL expiry. Cache misses always go through the SELECT+join path so behavior
 * is deterministic. Caller is responsible for handling DB errors — we re-throw.
 */

const pool = require('./db');

const TTL_MS = 60_000;

const byId           = new Map();   // id → { location, cachedAt }
const byTwilioNumber = new Map();   // twilio_number → id

function isFresh(entry) {
  return entry && Date.now() - entry.cachedAt < TTL_MS;
}

async function fetchHydrated(client, id) {
  const locRes = await client.query(
    `SELECT id, account_id, vertical, name, twilio_number, sms_from_number,
            elevenlabs_agent_id, elevenlabs_voice_id, enabled_tools, timezone,
            config, active
       FROM locations
      WHERE id = $1`,
    [id],
  );
  if (!locRes.rows.length) return null;
  const location = locRes.rows[0];

  const tablesRes = await client.query(
    `SELECT id, capacity, location_label, notes, wheelchair_accessible
       FROM location_tables
      WHERE location_id = $1
      ORDER BY id`,
    [id],
  );
  location.tables = tablesRes.rows;
  return location;
}

function remember(location) {
  byId.set(location.id, { location, cachedAt: Date.now() });
  if (location.twilio_number) {
    byTwilioNumber.set(location.twilio_number, location.id);
  }
}

async function loadById(id) {
  const cached = byId.get(id);
  if (isFresh(cached)) return cached.location;

  const client = await pool.connect();
  try {
    const location = await fetchHydrated(client, id);
    if (location) remember(location);
    return location;
  } finally {
    client.release();
  }
}

async function loadByTwilioNumber(toNumber) {
  if (!toNumber) return null;

  const id = byTwilioNumber.get(toNumber);
  if (id) {
    const cached = byId.get(id);
    if (isFresh(cached) && cached.location.active && cached.location.twilio_number === toNumber) {
      return cached.location;
    }
  }

  const client = await pool.connect();
  try {
    const res = await client.query(
      `SELECT id FROM locations WHERE twilio_number = $1 AND active`,
      [toNumber],
    );
    if (!res.rows.length) return null;
    const location = await fetchHydrated(client, res.rows[0].id);
    if (location) remember(location);
    return location;
  } finally {
    client.release();
  }
}

async function listActive() {
  const client = await pool.connect();
  try {
    const ids = await client.query(
      `SELECT id FROM locations WHERE active ORDER BY id`,
    );
    const out = [];
    for (const row of ids.rows) {
      const cached = byId.get(row.id);
      if (isFresh(cached)) {
        out.push(cached.location);
        continue;
      }
      const hydrated = await fetchHydrated(client, row.id);
      if (hydrated) {
        remember(hydrated);
        out.push(hydrated);
      }
    }
    return out;
  } finally {
    client.release();
  }
}

function invalidate(id) {
  if (!id) return;
  const cached = byId.get(id);
  byId.delete(id);
  if (cached && cached.location.twilio_number) {
    byTwilioNumber.delete(cached.location.twilio_number);
  }
  // Also drop any reverse entries that point at this id but whose twilio_number
  // differs from what's currently cached (e.g. number was changed out from under us).
  for (const [num, mappedId] of byTwilioNumber) {
    if (mappedId === id) byTwilioNumber.delete(num);
  }
}

function _resetForTests() {
  byId.clear();
  byTwilioNumber.clear();
}

module.exports = {
  loadById,
  loadByTwilioNumber,
  listActive,
  invalidate,
  _resetForTests,
  TTL_MS,
};
