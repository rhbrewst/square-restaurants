const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { DateTime } = require('luxon');
const { buildSystemPrompt, buildKeyFacts } = require('../src/systemPrompt');
const restaurant = require('../config/restaurant.json');

// Synthesize a location object in the 6.3+ shape from the legacy restaurant.json.
// Only the fields buildSystemPrompt actually reads are needed.
function makeLocation(timezone) {
  return {
    id:            'ember-room',
    name:          restaurant.name,
    timezone,
    enabled_tools: ['get_restaurant_info','get_menu','check_availability','book_reservation','cancel_reservation','leave_message'],
    config:        restaurant,
    tables:        [],
  };
}

// 02:00 UTC on 2026-04-20. In US timezones under DST, this is the previous
// evening — a case where a server-TZ-naive prompt would report "Monday" and
// be wrong for the caller.
const fixedUtc = DateTime.fromISO('2026-04-20T02:00:00', { zone: 'utc' });

test('buildSystemPrompt reports tenant-local date/time in America/Chicago', () => {
  const location = makeLocation('America/Chicago');
  const now = fixedUtc.setZone('America/Chicago');
  const prompt = buildSystemPrompt(location, now);
  assert.match(prompt, /Today is Sunday, April 19, 2026\./);
  assert.match(prompt, /The current time is 9:00 PM\./);
});

test('buildSystemPrompt reports tenant-local date/time in America/New_York', () => {
  const location = makeLocation('America/New_York');
  const now = fixedUtc.setZone('America/New_York');
  const prompt = buildSystemPrompt(location, now);
  assert.match(prompt, /Today is Sunday, April 19, 2026\./);
  assert.match(prompt, /The current time is 10:00 PM\./);
});

test('buildSystemPrompt filters "Your tools:" by enabled_tools', () => {
  const location = makeLocation('America/Chicago');
  location.enabled_tools = ['get_menu', 'leave_message'];
  const prompt = buildSystemPrompt(location, fixedUtc.setZone('America/Chicago'));
  assert.match(prompt, /- get_menu\(section\)/);
  assert.match(prompt, /- leave_message\(/);
  assert.doesNotMatch(prompt, /- check_availability\(/);
  assert.doesNotMatch(prompt, /- book_reservation\(/);
  assert.doesNotMatch(prompt, /- cancel_reservation\(/);
  assert.doesNotMatch(prompt, /- get_restaurant_info\(/);
});

// ─── Per-tenant fact regression tests ────────────────────────────────────────
// These guard against the bug The Tide House surfaced: hardcoded Ember-specific
// facts (no patio, happy hour at the bar only, pets not permitted) leaking
// into every tenant's system prompt.

test('Key facts: Ember reads outdoor/happy-hour/pets/bar from config', () => {
  const cfg = restaurant;
  const facts = buildKeyFacts(cfg, cfg.reservation_policy, cfg.payment);
  // Ember's outdoor_note: "We do not currently have a patio…"
  assert.match(facts, /We do not currently have a patio/, 'Ember outdoor_note should appear');
  // Ember's happy_hour.note: "Happy hour runs Monday through Friday from 5 to 6:30 PM at the bar only."
  assert.match(facts, /5 to 6:30 PM at the bar only/, 'Ember happy_hour.note should appear');
  // Ember's pets.note: "We are not able to accommodate pets in the restaurant. Service animals…"
  assert.match(facts, /not able to accommodate pets/, 'Ember pets.note should appear');
  // Ember's bar.note: "The bar has 4 seats and is walk-in only…"
  assert.match(facts, /4 seats and is walk-in only/, 'Ember bar.note should appear');
});

// Use the committed tenant fixture so this test fails the moment someone
// regresses the per-tenant rendering for a real second tenant.
const tideHouseConfigRaw = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'config', 'tenants', 'the-tide-house.json'), 'utf8'),
);

test('Key facts: Tide House overrides Ember-specific defaults', () => {
  const cfg = tideHouseConfigRaw; // raw config — header keys are harmless extras
  const facts = buildKeyFacts(cfg, cfg.reservation_policy, cfg.payment);
  // Tide House's outdoor_note: "We have a covered patio with harbor views…"
  assert.match(facts, /covered patio with harbor views/, 'Tide House outdoor_note must appear');
  assert.doesNotMatch(facts, /We do not have outdoor seating/, 'Ember default must NOT leak');
  assert.doesNotMatch(facts, /We do not currently have a patio/, 'Ember outdoor_note must NOT leak');
  // Tide House's happy_hour: "in the bar lounge and on the patio"
  assert.match(facts, /bar lounge and on the patio/, 'Tide House happy_hour.note must appear');
  assert.doesNotMatch(facts, /at the bar only/, 'Ember happy_hour text must NOT leak');
  // Tide House's pets: "Well-behaved leashed dogs are welcome on the patio"
  assert.match(facts, /leashed dogs are welcome on the patio/, 'Tide House pets.note must appear');
  // Tide House's bar: "Six bar seats…"
  assert.match(facts, /Six bar seats/, 'Tide House bar.note must appear');
});

test('Key facts: deposit / auto-gratuity render correctly per tenant', () => {
  // Both tenants currently have deposit_required_party_size = 6, so the FREE
  // line lands at 1–5 for both — but the deposit *amount* differs: Ember $25,
  // Tide House $20. That's the asymmetry we want to lock down.
  const ember = restaurant;
  const eFacts = buildKeyFacts(ember, ember.reservation_policy, ember.payment);
  assert.match(eFacts, /Reservations are FREE for parties of 1–5\./);
  assert.match(eFacts, /\$25\/person deposit/, 'Ember deposit should be $25');

  const tide = tideHouseConfigRaw;
  const tFacts = buildKeyFacts(tide, tide.reservation_policy, tide.payment);
  assert.match(tFacts, /Reservations are FREE for parties of 1–5\./);
  assert.match(tFacts, /\$20\/person deposit/, 'Tide House deposit should be $20');
  assert.doesNotMatch(tFacts, /\$25\/person deposit/, 'Ember $25 must not leak into Tide House');
});

test('Key facts: graceful fallbacks when sections are missing', () => {
  const minimal = {
    description: 'x', tagline: 'x', address: 'x', phone: 'x', email: 'x',
    hours: { monday: { open: '17:00', close: '22:00', kitchen_close: '21:30' } },
    reservation_policy: {
      slots: [], weekend_slots: [], min_party_size: 1, max_party_size: 8,
      deposit_required_party_size: 6, deposit_amount_per_person: 20,
      cancellation_policy: 'x',
    },
    // Intentionally omit: payment, accessibility, kids, bar, happy_hour, seating, pets
  };
  const facts = buildKeyFacts(minimal, minimal.reservation_policy, minimal.payment);
  // Deposit still renders, the rest gracefully degrade.
  assert.match(facts, /Reservations are FREE for parties of 1–5\./);
  // Outdoor seating defaults to "We do not have outdoor seating" when seating is missing.
  assert.match(facts, /We do not have outdoor seating/);
  // Pets defaults to the conservative line.
  assert.match(facts, /Service animals are always welcome\. Pets are not permitted\./);
});
