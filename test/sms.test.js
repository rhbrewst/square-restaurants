/**
 * SMS body-builder tests. Exercises buildConfirmationMessage /
 * buildReminderMessage directly — no DB, no Twilio, no network.
 * Verifies per-tenant substitution: name, timezone, FROM number, callback.
 */

const { test } = require('node:test');
const assert   = require('node:assert');
const { buildConfirmationMessage, buildReminderMessage } = require('../src/sms');

const ember = {
  id:              'ember-room',
  name:            'The Ember Room',
  twilio_number:   '+16623716903',
  sms_from_number: '+16623716903',
  timezone:        'America/Chicago',
  config: { phone: '+16153330142' },
};

const gilded = {
  id:              'gilded-oyster',
  name:            'The Gilded Oyster',
  twilio_number:   '+12125550001',
  sms_from_number: '+12125550002',   // distinct from twilio_number on purpose
  timezone:        'America/New_York',
  config: { phone: '+12125550003' },
};

const basePayload = {
  id:             '1f1d25a4',
  customer_name:  'Taylor Washington',
  customer_phone: '615-555-0142',
  date:           '2026-05-15',
  time:           '19:00:00',
  party_size:     2,
};

test('confirmation: uses location name, timezone, FROM, callback', () => {
  const msg = buildConfirmationMessage(ember, basePayload);

  assert.equal(msg.from, '+16623716903', 'FROM should be ember sms_from_number');
  assert.equal(msg.to,   '+16155550142', 'TO should be normalized to E.164');
  assert.ok(msg.body.includes('Hi Taylor!'),            'first name extracted');
  assert.ok(msg.body.includes('The Ember Room'),        'location name in body');
  assert.ok(msg.body.includes('1f1d25a4'),              'confirmation code in body');
  assert.ok(msg.body.includes('+16153330142'),          'callback phone from config');
  // 19:00 America/Chicago on 2026-05-15 → "Friday, May 15, 7:00 PM"
  assert.ok(msg.body.includes('Friday, May 15, 7:00 PM'),
    `expected tenant-local time in body, got: ${msg.body}`);
});

test('confirmation: second tenant renders with its own identity', () => {
  const msg = buildConfirmationMessage(gilded, basePayload);

  assert.equal(msg.from, '+12125550002', 'FROM should be gilded sms_from_number');
  assert.ok(msg.body.includes('The Gilded Oyster'),   'gilded name in body');
  assert.ok(msg.body.includes('+12125550003'),        'gilded callback phone');
  assert.ok(!msg.body.includes('The Ember Room'),     'ember name must not leak');
  // 19:00 America/New_York on 2026-05-15 → "Friday, May 15, 7:00 PM"
  // (same clock time, different zone — same rendered string, different UTC instant)
  assert.ok(msg.body.includes('Friday, May 15, 7:00 PM'));
});

test('confirmation: falls back to twilio_number when sms_from_number is missing', () => {
  const loc = { ...ember, sms_from_number: null };
  const msg = buildConfirmationMessage(loc, basePayload);
  assert.equal(msg.from, '+16623716903', 'should fall back to twilio_number');
});

test('confirmation: falls back to FROM when config.phone is missing', () => {
  const loc = { ...ember, config: {} };
  const msg = buildConfirmationMessage(loc, basePayload);
  assert.ok(msg.body.includes('+16623716903'),
    'callback should fall back to FROM when config.phone missing');
});

test('reminder: distinct copy, same per-tenant substitution', () => {
  const msg = buildReminderMessage(ember, basePayload);
  assert.ok(msg.body.includes('reminder'),                 'reminder copy');
  assert.ok(msg.body.includes('The Ember Room'),           'location name');
  assert.ok(msg.body.includes('Friday, May 15, 7:00 PM'),  'tenant-local time');
  assert.equal(msg.from, '+16623716903');
});
