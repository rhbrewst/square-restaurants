#!/usr/bin/env node
/**
 * Phase 6.7 — Create / update a tenant location from a git-committed JSON file.
 *
 * Usage:
 *   railway run -- node scripts/create-location.js config/tenants/the-gilded-oyster.json
 *
 * The JSON must have a header block at the top level:
 *   id, account_id, twilio_number, timezone, name, tables   (required)
 *   account_name, sms_from_number, vertical, enabled_tools,
 *   elevenlabs_agent_id, elevenlabs_voice_id                 (optional)
 *
 * Everything else at the top level is treated as the tenant's config payload
 * (hours, menu, reservation_policy, description, address, etc.) and stored
 * verbatim in locations.config JSONB.
 *
 * Idempotent: re-running with the same JSON reflects edits; safe to commit
 * config changes and re-run without special care. Table rows present in the
 * DB but missing from the JSON are left in place (they may have reservations
 * referencing them) — a warning is printed.
 */

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { DateTime } = require('luxon');
const pool = require('../src/db');

// Keys that map to locations/accounts columns (or to location_tables rows).
// Anything outside this set on the top-level JSON becomes part of config.
const HEADER_KEYS = new Set([
  'id', 'account_id', 'account_name',
  'twilio_number', 'sms_from_number',
  'timezone', 'vertical', 'enabled_tools',
  'elevenlabs_agent_id', 'elevenlabs_voice_id',
  'tables',
]);

// ─── Pure helpers (exported for testing) ─────────────────────────────────────

function validate(raw) {
  const required = ['id', 'account_id', 'twilio_number', 'timezone', 'name', 'tables'];
  for (const key of required) {
    if (raw[key] === undefined || raw[key] === null || raw[key] === '') {
      throw new Error(`missing required field: ${key}`);
    }
  }
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(raw.id)) {
    throw new Error(`id must be lowercase-hyphen slug (got "${raw.id}")`);
  }
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(raw.account_id)) {
    throw new Error(`account_id must be lowercase-hyphen slug (got "${raw.account_id}")`);
  }
  if (!/^\+[1-9]\d{6,14}$/.test(raw.twilio_number)) {
    throw new Error(`twilio_number must be E.164 (e.g. +15551234567), got "${raw.twilio_number}"`);
  }
  if (raw.sms_from_number && !/^\+[1-9]\d{6,14}$/.test(raw.sms_from_number)) {
    throw new Error(`sms_from_number must be E.164 if provided, got "${raw.sms_from_number}"`);
  }
  if (!DateTime.local().setZone(raw.timezone).isValid) {
    throw new Error(`timezone "${raw.timezone}" is not a valid IANA zone`);
  }
  if (!Array.isArray(raw.tables) || raw.tables.length === 0) {
    throw new Error('tables must be a non-empty array');
  }
  for (const [i, t] of raw.tables.entries()) {
    if (!t.id)       throw new Error(`tables[${i}].id is required`);
    if (!t.capacity) throw new Error(`tables[${i}].capacity is required`);
    const label = t.location_label || t.location;
    if (!label) throw new Error(`tables[${i}].location_label is required`);
  }
}

/** Split the JSON into (a) things that map to columns and (b) the config blob. */
function splitHeaderAndConfig(raw) {
  const config = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!HEADER_KEYS.has(k)) config[k] = v;
  }
  return config;
}

// ─── DB operations ───────────────────────────────────────────────────────────

async function preflightTwilioNumberConflict(client, raw) {
  const res = await client.query(
    `SELECT id FROM locations WHERE twilio_number = $1`,
    [raw.twilio_number],
  );
  if (res.rows.length && res.rows[0].id !== raw.id) {
    throw new Error(
      `twilio_number ${raw.twilio_number} is already assigned to location "${res.rows[0].id}". ` +
      `Either reuse that id, or free the number first.`,
    );
  }
}

async function upsertAccount(client, raw) {
  if (raw.account_name) {
    await client.query(
      `INSERT INTO accounts (id, name) VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, updated_at = NOW()`,
      [raw.account_id, raw.account_name],
    );
    return;
  }
  const res = await client.query(`SELECT id FROM accounts WHERE id = $1`, [raw.account_id]);
  if (!res.rows.length) {
    throw new Error(`account "${raw.account_id}" does not exist; supply "account_name" to create it`);
  }
}

async function upsertLocation(client, raw, config) {
  const cols = ['id', 'account_id', 'name', 'twilio_number', 'sms_from_number', 'timezone', 'config'];
  const vals = [
    raw.id,
    raw.account_id,
    raw.name,
    raw.twilio_number,
    raw.sms_from_number || raw.twilio_number,
    raw.timezone,
    JSON.stringify(config),
  ];

  const optionals = {
    vertical:            raw.vertical,
    enabled_tools:       Array.isArray(raw.enabled_tools) ? raw.enabled_tools : null,
    elevenlabs_agent_id: raw.elevenlabs_agent_id,
    elevenlabs_voice_id: raw.elevenlabs_voice_id,
  };
  for (const [col, val] of Object.entries(optionals)) {
    if (val !== undefined && val !== null) {
      cols.push(col);
      vals.push(val);
    }
  }

  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
  const updateClauses = cols
    .filter((c) => c !== 'id')
    .map((c) => `${c} = EXCLUDED.${c}`)
    .concat('updated_at = NOW()')
    .join(', ');

  await client.query(
    `INSERT INTO locations (${cols.join(', ')})
     VALUES (${placeholders})
     ON CONFLICT (id) DO UPDATE SET ${updateClauses}`,
    vals,
  );
}

async function upsertTables(client, raw) {
  for (const t of raw.tables) {
    await client.query(
      `INSERT INTO location_tables (location_id, id, capacity, location_label,
                                    notes, wheelchair_accessible)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (location_id, id) DO UPDATE
         SET capacity              = EXCLUDED.capacity,
             location_label        = EXCLUDED.location_label,
             notes                 = EXCLUDED.notes,
             wheelchair_accessible = EXCLUDED.wheelchair_accessible`,
      [
        raw.id, t.id, t.capacity,
        t.location_label || t.location,
        t.notes || null,
        Boolean(t.wheelchair_accessible),
      ],
    );
  }

  const existing = await client.query(
    `SELECT id FROM location_tables WHERE location_id = $1`,
    [raw.id],
  );
  const jsonIds = new Set(raw.tables.map((t) => t.id));
  const orphans = existing.rows.map((r) => r.id).filter((id) => !jsonIds.has(id));
  if (orphans.length) {
    console.warn(
      `⚠️  ${orphans.length} table(s) exist in DB but not in JSON: ${orphans.join(', ')}. ` +
      `Left in place (may have reservations referencing them). Remove manually if intended.`,
    );
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function run(jsonPath) {
  const abs = path.resolve(jsonPath);
  if (!fs.existsSync(abs)) throw new Error(`file not found: ${abs}`);

  const raw = JSON.parse(fs.readFileSync(abs, 'utf8'));
  validate(raw);
  const config = splitHeaderAndConfig(raw);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await preflightTwilioNumberConflict(client, raw);
    await upsertAccount(client, raw);
    await upsertLocation(client, raw, config);
    await upsertTables(client, raw);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  const publicUrl = process.env.PUBLIC_URL || '<PUBLIC_URL not set>';
  console.log(`✓ location "${raw.id}" seeded (${raw.tables.length} tables)`);
  console.log(`  Point Twilio number ${raw.twilio_number} at:`);
  console.log(`    Voice webhook: ${publicUrl}/incoming-call  (HTTP POST)`);
}

async function main() {
  const [, , jsonPath] = process.argv;
  if (!jsonPath) {
    console.error('usage: node scripts/create-location.js <path/to/tenant.json>');
    process.exit(1);
  }
  try {
    await run(jsonPath);
  } catch (err) {
    console.error(`create-location failed: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
}

if (require.main === module) main();

module.exports = { validate, splitHeaderAndConfig, HEADER_KEYS };
