#!/usr/bin/env node
/**
 * Phase 6.3 — Backfill Ember Room as the first tenant.
 *
 * Idempotent: re-running picks up any edits to config/restaurant.json and
 * catches any domain rows written with location_id = NULL since the last run.
 *
 * Usage:
 *   TWILIO_PHONE_NUMBER=+15551234567 node scripts/backfill-tenant.js
 *
 * Reads TWILIO_PHONE_NUMBER from env because restaurant.json doesn't carry it
 * today and we don't want to commit the production number into the repo.
 */

require('dotenv').config();
const pool = require('../src/db');
const restaurant = require('../config/restaurant.json');

const LOCATION_ID   = 'ember-room';
const ACCOUNT_ID    = 'ember-group';

async function main() {
  const twilioNumber = process.env.TWILIO_PHONE_NUMBER;
  if (!twilioNumber) {
    console.error('TWILIO_PHONE_NUMBER is required.');
    process.exit(1);
  }

  const timezone = restaurant.timezone || 'America/Chicago';
  const wheelchairIds = new Set(
    (restaurant.seating && restaurant.seating.wheelchair_accessible_tables) || [],
  );

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Step A — upsert the location row. The full restaurant.json goes into
    // `config` verbatim so existing reads like config.description keep working
    // when 6.4 swaps restaurant.description → location.config.description.
    await client.query(
      `INSERT INTO locations (id, account_id, name, twilio_number, sms_from_number,
                              timezone, config)
       VALUES ($1, $2, $3, $4, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE
         SET name            = EXCLUDED.name,
             twilio_number   = EXCLUDED.twilio_number,
             sms_from_number = EXCLUDED.sms_from_number,
             timezone        = EXCLUDED.timezone,
             config          = EXCLUDED.config,
             updated_at      = NOW()`,
      [LOCATION_ID, ACCOUNT_ID, restaurant.name, twilioNumber, timezone, JSON.stringify(restaurant)],
    );

    // Step B — upsert location_tables from restaurant.tables.
    const tables = restaurant.tables || [];
    for (const t of tables) {
      await client.query(
        `INSERT INTO location_tables (location_id, id, capacity, location_label,
                                      notes, wheelchair_accessible)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (location_id, id) DO UPDATE
           SET capacity              = EXCLUDED.capacity,
               location_label        = EXCLUDED.location_label,
               notes                 = EXCLUDED.notes,
               wheelchair_accessible = EXCLUDED.wheelchair_accessible`,
        [LOCATION_ID, t.id, t.capacity, t.location, t.notes || null, wheelchairIds.has(t.id)],
      );
    }

    // Step C — stamp existing domain rows.
    const r = await client.query(
      `UPDATE reservations SET location_id = $1 WHERE location_id IS NULL`,
      [LOCATION_ID],
    );
    const m = await client.query(
      `UPDATE messages     SET location_id = $1 WHERE location_id IS NULL`,
      [LOCATION_ID],
    );
    const c = await client.query(
      `UPDATE calls        SET location_id = $1 WHERE location_id IS NULL`,
      [LOCATION_ID],
    );

    // Step D — verify no strays remain.
    const leftovers = await client.query(
      `SELECT
         (SELECT COUNT(*) FROM reservations WHERE location_id IS NULL) AS r,
         (SELECT COUNT(*) FROM messages     WHERE location_id IS NULL) AS m,
         (SELECT COUNT(*) FROM calls        WHERE location_id IS NULL) AS c`,
    );
    const { r: rNull, m: mNull, c: cNull } = leftovers.rows[0];
    if (Number(rNull) + Number(mNull) + Number(cNull) > 0) {
      await client.query('ROLLBACK');
      console.error(`Verification failed: R=${rNull} M=${mNull} C=${cNull} still NULL`);
      process.exit(1);
    }

    await client.query('COMMIT');
    console.log(
      `✓ location ${LOCATION_ID} seeded; ${tables.length} tables; ` +
      `backfilled R=${r.rowCount} M=${m.rowCount} C=${c.rowCount}`,
    );
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Backfill failed:', err.message);
  process.exit(1);
});
