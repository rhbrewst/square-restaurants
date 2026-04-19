#!/usr/bin/env node
/**
 * Usage:
 *   node scripts/report.js               # last 30 days
 *   node scripts/report.js --days 7      # last N days
 *   node scripts/report.js --month 2026-04  # specific month
 */

require('dotenv').config();
const pool = require('../src/db');

// ── Args ──────────────────────────────────────────────────────────────────────

const args  = process.argv.slice(2);
const days  = argVal(args, '--days');
const month = argVal(args, '--month');

function argVal(arr, flag) {
  const i = arr.indexOf(flag);
  return i !== -1 ? arr[i + 1] : null;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // Build date range filter
  let dateFilter  = '';
  let dateParams  = [];
  let periodLabel = 'All time';

  if (days) {
    dateFilter  = `WHERE call_date >= NOW() - ($1 || ' days')::interval`;
    dateParams  = [parseInt(days)];
    periodLabel = `Last ${days} days`;
  } else if (month) {
    dateFilter  = `WHERE call_date >= $1 AND call_date < $1::date + interval '1 month'`;
    dateParams  = [`${month}-01`];
    periodLabel = `Month: ${month}`;
  } else {
    // Default to last 30 days for the analytics view query
    dateFilter  = `WHERE call_date >= NOW() - interval '30 days'`;
    dateParams  = [];
    periodLabel = 'Last 30 days';
  }

  // ── Aggregates from materialized view ──
  const viewResult = await pool.query(
    `SELECT
       SUM(total_calls)          AS total_calls,
       SUM(total_seconds)        AS total_seconds,
       ROUND(AVG(avg_seconds))   AS avg_seconds,
       SUM(total_cost_usd)       AS total_cost_usd,
       SUM(bookings)             AS bookings,
       SUM(messages_left)        AS messages_left,
       SUM(info_calls)           AS info_calls,
       SUM(no_action)            AS no_action,
       SUM(calls_with_errors)    AS calls_with_errors
     FROM call_analytics_daily
     ${dateFilter}`,
    dateParams,
  );

  const agg = viewResult.rows[0];

  if (!agg || !agg.total_calls) {
    console.log('No calls found for the specified period.');
    await pool.end();
    return;
  }

  // ── Per-call detail from calls table (for cost breakdown + detailed sections) ──
  let callsFilter = '';
  let callsParams = [];

  if (days) {
    callsFilter  = `WHERE started_at >= NOW() - ($1 || ' days')::interval`;
    callsParams  = [parseInt(days)];
  } else if (month) {
    callsFilter  = `WHERE started_at >= $1 AND started_at < $1::timestamptz + interval '1 month'`;
    callsParams  = [`${month}-01`];
  } else {
    callsFilter  = `WHERE started_at >= NOW() - interval '30 days'`;
    callsParams  = [];
  }

  const callsResult = await pool.query(
    `SELECT outcome, tools_called, inquiry_topics, cost_breakdown_usd,
            started_at, reservation_id
     FROM calls
     ${callsFilter}
     ORDER BY started_at`,
    callsParams,
  );

  const calls = callsResult.rows;

  // Per-provider cost totals
  const twilioTotal     = calls.reduce((s, c) => s + (c.cost_breakdown_usd?.twilio     || 0), 0);
  const elevenLabsTotal = calls.reduce((s, c) => s + (c.cost_breakdown_usd?.elevenlabs || 0), 0);
  const claudeTotal     = calls.reduce((s, c) => s + (c.cost_breakdown_usd?.claude     || 0), 0);

  // Topic and tool tallies from JSONB
  const topics = {};
  const tools  = {};
  for (const c of calls) {
    for (const topic of (c.inquiry_topics || [])) {
      topics[topic] = (topics[topic] || 0) + 1;
    }
    for (const t of (c.tools_called || [])) {
      tools[t.tool] = (tools[t.tool] || 0) + 1;
    }
  }

  // Recent reservations booked — join on reservation_id
  const resResult = await pool.query(
    `SELECT r.id, r.date, r.time, r.party_size, r.customer_name, c.started_at
     FROM reservations r
     JOIN calls c ON c.reservation_id = r.id
     ${callsFilter.replace('started_at', 'c.started_at')}
     ORDER BY c.started_at DESC
     LIMIT 10`,
    callsParams,
  );

  // Recent messages left
  const msgResult = await pool.query(
    `SELECT m.id, m.subject, c.started_at
     FROM messages m
     JOIN calls c ON c.message_id = m.id
     ${callsFilter.replace('started_at', 'c.started_at')}
     ORDER BY c.started_at DESC
     LIMIT 10`,
    callsParams,
  );

  // ── Print report ──────────────────────────────────────────────────────────
  const totalCalls    = Number(agg.total_calls);
  const totalSeconds  = Number(agg.total_seconds) || 0;
  const avgSeconds    = Number(agg.avg_seconds) || 0;
  const totalCost     = parseFloat(agg.total_cost_usd) || 0;

  line('═', 56);
  console.log(`  SQUARE RESTAURANTS — CALL ANALYTICS REPORT`);
  console.log(`  ${periodLabel}`);
  line('═', 56);

  section('VOLUME & COST');
  row('Total calls',         totalCalls);
  row('Total duration',      fmtDuration(totalSeconds));
  row('Average call length', fmtDuration(avgSeconds));
  row('Total cost (est.)',   `$${totalCost.toFixed(4)} USD`);
  row('  ↳ Twilio',          `$${twilioTotal.toFixed(4)}  ($0.0085/min)`);
  row('  ↳ ElevenLabs',      `$${elevenLabsTotal.toFixed(4)}  ($0.10/min)`);
  row('  ↳ Claude',          `$${claudeTotal.toFixed(4)}  (~$0.00735/min)`);
  row('Calls with errors',   Number(agg.calls_with_errors) || 0);

  section('OUTCOMES');
  row(fmtOutcome('reservation_booked'), `${agg.bookings}  (${pct(agg.bookings, totalCalls)})`);
  row(fmtOutcome('message_left'),       `${agg.messages_left}  (${pct(agg.messages_left, totalCalls)})`);
  row(fmtOutcome('info_provided'),      `${agg.info_calls}  (${pct(agg.info_calls, totalCalls)})`);
  row(fmtOutcome('no_action'),          `${agg.no_action}  (${pct(agg.no_action, totalCalls)})`);

  section('INQUIRY TOPICS  (get_restaurant_info calls)');
  const topicEntries = sorted(topics);
  if (topicEntries.length) {
    const topicTotal = Object.values(topics).reduce((a, b) => a + b, 0);
    for (const [topic, count] of topicEntries) {
      row(topic, `${count}  (${pct(count, topicTotal)})`);
    }
  } else {
    console.log('  none');
  }

  section('TOOL USAGE');
  for (const [tool, count] of sorted(tools)) {
    row(tool, count);
  }

  const reservations = resResult.rows;
  section(`RESERVATIONS BOOKED  (${Number(agg.bookings)})`);
  if (reservations.length) {
    for (const r of reservations) {
      console.log(`  ${r.started_at.toISOString().slice(0, 10)}  ${r.date} ${r.time}  party of ${r.party_size}  — ${r.customer_name}  [${r.id}]`);
    }
  } else {
    console.log('  none');
  }

  const messages = msgResult.rows;
  section(`MESSAGES LEFT FOR MANAGEMENT  (${Number(agg.messages_left)})`);
  if (messages.length) {
    for (const m of messages) {
      console.log(`  ${m.started_at.toISOString().slice(0, 10)}  ${m.subject}  [${m.id}]`);
    }
  } else {
    console.log('  none');
  }

  line('─', 56);
  console.log(`  Source: call_analytics_daily view + calls table`);
  console.log(`  Rates: Twilio $0.0085/min · ElevenLabs $0.10/min · Claude ~$0.00735/min`);
  console.log(`  Update rates in src/callLogger.js if they change.\n`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function section(title) {
  console.log('');
  line('─', 56);
  console.log(`  ${title}`);
  line('─', 56);
}

function row(label, value) {
  console.log(`  ${String(label).padEnd(30)} ${value}`);
}

function line(char, len) {
  console.log(char.repeat(len));
}

function pct(n, total) {
  return total ? `${Math.round(Number(n) / Number(total) * 100)}%` : '0%';
}

function fmtDuration(secs) {
  if (!secs) return '0s';
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return m ? `${m}m ${s}s` : `${s}s`;
}

function fmtOutcome(o) {
  return {
    reservation_booked: 'Reservation booked',
    message_left:       'Message left for management',
    info_provided:      'Info / menu inquiry',
    no_action:          'No action',
  }[o] || o;
}

function sorted(obj) {
  return Object.entries(obj).sort(([, a], [, b]) => b - a);
}

main().catch((err) => {
  console.error('Report failed:', err.message);
  process.exit(1);
}).finally(() => pool.end());
