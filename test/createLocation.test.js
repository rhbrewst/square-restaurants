/**
 * Tests for the create-location CLI validator and header/config split.
 * Pure functions — no DB, no file I/O.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { validate, splitHeaderAndConfig } = require('../scripts/create-location');

function baseRaw(overrides = {}) {
  return {
    id:            'the-test-diner',
    account_id:    'test-holdings',
    account_name:  'Test Holdings LLC',
    twilio_number: '+15551234567',
    timezone:      'America/Chicago',
    name:          'The Test Diner',
    tables: [
      { id: 'T1', capacity: 2, location_label: 'main floor' },
    ],
    ...overrides,
  };
}

test('validate: accepts a well-formed payload', () => {
  assert.doesNotThrow(() => validate(baseRaw()));
});

test('validate: rejects missing required fields', () => {
  for (const key of ['id', 'account_id', 'twilio_number', 'timezone', 'name', 'tables']) {
    const raw = baseRaw();
    delete raw[key];
    assert.throws(() => validate(raw), new RegExp(`missing required field: ${key}`));
  }
});

test('validate: rejects non-slug id and account_id', () => {
  assert.throws(() => validate(baseRaw({ id: 'Not A Slug' })), /lowercase-hyphen slug/);
  assert.throws(() => validate(baseRaw({ id: 'UPPER' })),      /lowercase-hyphen slug/);
  assert.throws(() => validate(baseRaw({ account_id: 'A B' })), /lowercase-hyphen slug/);
});

test('validate: rejects non-E.164 twilio_number', () => {
  assert.throws(() => validate(baseRaw({ twilio_number: '555-1234' })),   /E\.164/);
  assert.throws(() => validate(baseRaw({ twilio_number: '15551234567' })), /E\.164/);
  assert.throws(() => validate(baseRaw({ twilio_number: '+' })),           /E\.164/);
});

test('validate: rejects non-E.164 sms_from_number if provided', () => {
  assert.throws(
    () => validate(baseRaw({ sms_from_number: '555-1234' })),
    /sms_from_number must be E\.164/,
  );
});

test('validate: rejects invalid IANA timezone', () => {
  assert.throws(() => validate(baseRaw({ timezone: 'Not/A_Zone' })), /not a valid IANA zone/);
});

test('validate: rejects empty or non-array tables', () => {
  assert.throws(() => validate(baseRaw({ tables: [] })), /tables must be a non-empty array/);
  assert.throws(() => validate(baseRaw({ tables: 'nope' })), /tables must be a non-empty array/);
});

test('validate: rejects incomplete table rows', () => {
  assert.throws(
    () => validate(baseRaw({ tables: [{ capacity: 2, location_label: 'main' }] })),
    /tables\[0\]\.id is required/,
  );
  assert.throws(
    () => validate(baseRaw({ tables: [{ id: 'T1', location_label: 'main' }] })),
    /tables\[0\]\.capacity is required/,
  );
  assert.throws(
    () => validate(baseRaw({ tables: [{ id: 'T1', capacity: 2 }] })),
    /tables\[0\]\.location_label is required/,
  );
});

test('validate: accepts legacy "location" as an alias for location_label on tables', () => {
  assert.doesNotThrow(() => validate(baseRaw({
    tables: [{ id: 'T1', capacity: 2, location: 'main floor' }],
  })));
});

test('splitHeaderAndConfig: header keys are stripped, rest goes to config', () => {
  const raw = baseRaw({
    description: 'An example tenant.',
    hours:       { monday: { open: '17:00', close: '22:00' } },
    menu:        { mains: [] },
  });
  const config = splitHeaderAndConfig(raw);

  // Header keys excluded from config
  for (const key of ['id', 'account_id', 'account_name', 'twilio_number',
                     'sms_from_number', 'timezone', 'vertical', 'enabled_tools',
                     'elevenlabs_agent_id', 'elevenlabs_voice_id', 'tables']) {
    assert.equal(config[key], undefined, `${key} should be excluded from config`);
  }

  // Non-header top-level keys preserved
  assert.equal(config.name, 'The Test Diner');
  assert.equal(config.description, 'An example tenant.');
  assert.deepEqual(config.hours.monday, { open: '17:00', close: '22:00' });
  assert.deepEqual(config.menu, { mains: [] });
});
