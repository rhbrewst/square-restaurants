const cron = require('node-cron');
const pool = require('./db');

// Replaces the pg_cron jobs described in PRODUCTION_PLAN.md task 5.4.
// Railway's managed Postgres image does not ship pg_cron, so we run the same
// three jobs from the Node process via node-cron. The SQL functions themselves
// still live in the database (migrate.js) — this file only schedules calls to them.

const JOBS = [
  {
    name:     'queue-reminders',
    schedule: '0 * * * *',
    sql:      'SELECT queue_upcoming_reminders()',
  },
  {
    name:     'ensure-partition',
    schedule: '0 0 25 * *',
    sql:      'SELECT ensure_next_calls_partition()',
  },
  {
    name:     'refresh-analytics',
    schedule: '0 3 * * *',
    sql:      'REFRESH MATERIALIZED VIEW CONCURRENTLY call_analytics_daily',
  },
];

const tasks   = new Map();
const running = new Map();

async function runJob(name, sql) {
  if (running.get(name)) {
    console.warn(`[scheduler] ${name} still running from previous tick — skipping`);
    return;
  }
  running.set(name, true);
  const t0 = Date.now();
  try {
    await pool.query(sql);
    console.log(`[scheduler] ${name} ok (${Date.now() - t0}ms)`);
  } catch (err) {
    console.error(`[scheduler] ${name} failed:`, err.message);
  } finally {
    running.set(name, false);
  }
}

function startScheduler() {
  for (const { name, schedule, sql } of JOBS) {
    const task = cron.schedule(schedule, () => runJob(name, sql), { name });
    tasks.set(name, task);
    console.log(`[scheduler] registered ${name} (${schedule})`);
  }
}

async function stopScheduler() {
  for (const [name, task] of tasks) {
    task.destroy();
    console.log(`[scheduler] stopped ${name}`);
  }
  tasks.clear();

  // Wait briefly for any in-flight job to finish before the caller closes the pool.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (![...running.values()].some(Boolean)) break;
    await new Promise((r) => setTimeout(r, 200));
  }
}

module.exports = { startScheduler, stopScheduler };
