#!/usr/bin/env node
/**
 * Usage:
 *   node scripts/report.js               # all-time summary
 *   node scripts/report.js --days 7      # last 7 days
 *   node scripts/report.js --month 2026-04  # specific month
 */

const fs   = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, '../data/calls.jsonl');

// ── Args ──────────────────────────────────────────────────────────────────────

const args  = process.argv.slice(2);
const days  = argVal(args, '--days');
const month = argVal(args, '--month');

function argVal(arr, flag) {
  const i = arr.indexOf(flag);
  return i !== -1 ? arr[i + 1] : null;
}

// ── Load & filter calls ───────────────────────────────────────────────────────

if (!fs.existsSync(LOG_FILE)) {
  console.log('No call log found yet. Calls will be logged to data/calls.jsonl once the server receives its first call.');
  process.exit(0);
}

let calls = fs
  .readFileSync(LOG_FILE, 'utf8')
  .trim()
  .split('\n')
  .filter(Boolean)
  .map(line => JSON.parse(line));

const cutoff = days
  ? new Date(Date.now() - Number(days) * 86400_000).toISOString()
  : month
    ? new Date(`${month}-01`).toISOString()
    : null;

const cutoffEnd = month
  ? new Date(new Date(`${month}-01`).setMonth(new Date(`${month}-01`).getMonth() + 1)).toISOString()
  : null;

if (cutoff)    calls = calls.filter(c => c.started_at >= cutoff);
if (cutoffEnd) calls = calls.filter(c => c.started_at <  cutoffEnd);

if (!calls.length) {
  console.log('No calls found for the specified period.');
  process.exit(0);
}

// ── Aggregate ─────────────────────────────────────────────────────────────────

const totalCalls    = calls.length;
const totalDuration = calls.reduce((s, c) => s + (c.duration_seconds || 0), 0);
const totalCost     = calls.reduce((s, c) => s + (c.cost_estimate_usd || 0), 0);
const avgDuration   = Math.round(totalDuration / totalCalls);

const outcomes = tally(calls, c => c.outcome);
const topics   = tally(flatMap(calls, c => c.inquiry_topics), v => v);
const tools    = tally(flatMap(calls, c => c.tools_called.map(t => t.tool)), v => v);

const reservations = calls.filter(c => c.reservation).map(c => ({
  date:              c.reservation.date,
  time:              c.reservation.time,
  party_size:        c.reservation.party_size,
  customer_name:     c.reservation.customer_name,
  confirmation_code: c.reservation.confirmation_code,
  call_date:         c.started_at.slice(0, 10),
}));

const messages = calls.filter(c => c.message_left).map(c => ({
  subject:    c.message_left.subject,
  message_id: c.message_left.message_id,
  call_date:  c.started_at.slice(0, 10),
}));

const errors = calls.filter(c => c.errors.length > 0).length;

// ── Print report ──────────────────────────────────────────────────────────────

const period = days   ? `Last ${days} days`
             : month  ? `Month: ${month}`
             :          'All time';

line('═', 56);
console.log(`  SQUARE RESTAURANTS — CALL ANALYTICS REPORT`);
console.log(`  ${period}`);
line('═', 56);

const twilioTotal     = calls.reduce((s, c) => s + (c.cost_breakdown_usd?.twilio     || 0), 0);
const elevenLabsTotal = calls.reduce((s, c) => s + (c.cost_breakdown_usd?.elevenlabs || 0), 0);
const claudeTotal     = calls.reduce((s, c) => s + (c.cost_breakdown_usd?.claude     || 0), 0);

section('VOLUME & COST');
row('Total calls',          totalCalls);
row('Total duration',       fmtDuration(totalDuration));
row('Average call length',  fmtDuration(avgDuration));
row('Total cost (est.)',    `$${totalCost.toFixed(4)} USD`);
row('  ↳ Twilio',           `$${twilioTotal.toFixed(4)}  ($0.0085/min)`);
row('  ↳ ElevenLabs',       `$${elevenLabsTotal.toFixed(4)}  ($0.10/min)`);
row('  ↳ Claude',           `$${claudeTotal.toFixed(4)}  (~$0.00735/min)`);
row('Calls with errors',    errors);

section('OUTCOMES');
for (const [outcome, count] of sorted(outcomes)) {
  row(fmtOutcome(outcome), `${count}  (${pct(count, totalCalls)})`);
}

section('INQUIRY TOPICS  (get_restaurant_info calls)');
if (Object.keys(topics).length) {
  for (const [topic, count] of sorted(topics)) {
    row(topic, `${count}  (${pct(count, Object.values(topics).reduce((a, b) => a + b, 0))})`);
  }
} else {
  console.log('  none');
}

section('TOOL USAGE');
for (const [tool, count] of sorted(tools)) {
  row(tool, count);
}

section(`RESERVATIONS BOOKED  (${reservations.length})`);
if (reservations.length) {
  for (const r of reservations.slice(-10)) {
    console.log(`  ${r.call_date}  ${r.date} ${r.time}  party of ${r.party_size}  — ${r.customer_name}  [${r.confirmation_code}]`);
  }
  if (reservations.length > 10) console.log(`  … and ${reservations.length - 10} earlier`);
} else {
  console.log('  none');
}

section(`MESSAGES LEFT FOR MANAGEMENT  (${messages.length})`);
if (messages.length) {
  for (const m of messages.slice(-10)) {
    console.log(`  ${m.call_date}  ${m.subject}  [${m.message_id}]`);
  }
  if (messages.length > 10) console.log(`  … and ${messages.length - 10} earlier`);
} else {
  console.log('  none');
}

line('─', 56);
console.log(`  Log file: ${LOG_FILE}`);
console.log(`  Rates: Twilio $0.0085/min · ElevenLabs $0.10/min · Claude ~$0.00735/min`);
console.log(`  Source: cost-dashboard.html · update rates in src/callLogger.js if they change.\n`);

// ── Helpers ───────────────────────────────────────────────────────────────────

function section(title) {
  console.log('');
  line('─', 56);
  console.log(`  ${title}`);
  line('─', 56);
}

function row(label, value) {
  console.log(`  ${label.padEnd(30)} ${value}`);
}

function line(char, len) {
  console.log(char.repeat(len));
}

function pct(n, total) {
  return total ? `${Math.round(n / total * 100)}%` : '0%';
}

function fmtDuration(secs) {
  if (!secs) return '0s';
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return m ? `${m}m ${s}s` : `${s}s`;
}

function fmtOutcome(o) {
  return { reservation_booked: 'Reservation booked', message_left: 'Message left for management',
           info_provided: 'Info / menu inquiry', no_action: 'No action' }[o] || o;
}

function tally(items, keyFn = v => v) {
  const counts = {};
  for (const item of items) {
    const k = keyFn(item);
    counts[k] = (counts[k] || 0) + 1;
  }
  return counts;
}

function flatMap(arr, fn) {
  return arr.flatMap(fn);
}

function sorted(obj) {
  return Object.entries(obj).sort(([, a], [, b]) => b - a);
}
