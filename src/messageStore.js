const pool = require('./db');

/**
 * Inserts a new message and returns the full row (including the DB-generated id).
 * `location_id` is nullable on the column for now (NOT NULL flip is a follow-up
 * deploy after 6.4 has baked) but is always populated by current callers.
 */
async function addMessage({ caller_name, caller_phone, subject, message, location_id }) {
  const result = await pool.query(
    `INSERT INTO messages (caller_name, caller_phone, subject, message, location_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, caller_name, caller_phone, subject, message, status, location_id, created_at`,
    [caller_name, caller_phone, subject, message, location_id],
  );
  return result.rows[0];
}

module.exports = { addMessage };
