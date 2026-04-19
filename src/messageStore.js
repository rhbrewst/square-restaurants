const pool = require('./db');

/**
 * Inserts a new message and returns the full row (including the DB-generated id).
 */
async function addMessage({ caller_name, caller_phone, subject, message }) {
  const result = await pool.query(
    `INSERT INTO messages (caller_name, caller_phone, subject, message)
     VALUES ($1, $2, $3, $4)
     RETURNING id, caller_name, caller_phone, subject, message, status, created_at`,
    [caller_name, caller_phone, subject, message],
  );
  return result.rows[0];
}

module.exports = { addMessage };
