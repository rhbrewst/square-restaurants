const test = require('node:test');
const assert = require('node:assert');
const { DateTime } = require('luxon');
const { buildSystemPrompt } = require('../src/systemPrompt');
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
