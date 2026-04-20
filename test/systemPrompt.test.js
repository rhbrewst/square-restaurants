const test = require('node:test');
const assert = require('node:assert');
const { DateTime } = require('luxon');
const { buildSystemPrompt } = require('../src/systemPrompt');
const restaurant = require('../config/restaurant.json');

// 02:00 UTC on 2026-04-20. In US timezones under DST, this is the previous
// evening — a case where a server-TZ-naive prompt would report "Monday" and
// be wrong for the caller.
const fixedUtc = DateTime.fromISO('2026-04-20T02:00:00', { zone: 'utc' });

test('buildSystemPrompt reports tenant-local date/time in America/Chicago', () => {
  const now = fixedUtc.setZone('America/Chicago');
  const prompt = buildSystemPrompt({ ...restaurant, timezone: 'America/Chicago' }, now);
  assert.match(prompt, /Today is Sunday, April 19, 2026\./);
  assert.match(prompt, /The current time is 9:00 PM\./);
});

test('buildSystemPrompt reports tenant-local date/time in America/New_York', () => {
  const now = fixedUtc.setZone('America/New_York');
  const prompt = buildSystemPrompt({ ...restaurant, timezone: 'America/New_York' }, now);
  assert.match(prompt, /Today is Sunday, April 19, 2026\./);
  assert.match(prompt, /The current time is 10:00 PM\./);
});
