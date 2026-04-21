const pool = require('./db');

/**
 * Returns the table_ids of all confirmed reservations at the given location
 * that overlap the 90-minute window starting at (date, time). The DB exclusion
 * constraint enforces non-overlap at write time; this query is used by
 * check_availability to find which tables are free for suggestion.
 */
async function findConflictingTableIds(date, time, locationId) {
  const result = await pool.query(
    `SELECT DISTINCT table_id FROM reservations
     WHERE status = 'confirmed'
       AND location_id = $3
       AND tsrange(
         (date::text || ' ' || time::text)::timestamp,
         (date::text || ' ' || time::text)::timestamp + interval '90 minutes',
         '[)'
       ) && tsrange(
         ($1::text || ' ' || $2::text)::timestamp,
         ($1::text || ' ' || $2::text)::timestamp + interval '90 minutes',
         '[)'
       )`,
    [date, time, locationId],
  );
  return result.rows.map((r) => r.table_id);
}

/**
 * Inserts a new confirmed reservation and returns the full row (including
 * the DB-generated id). Requires location_id — the NOT NULL + exclusion
 * constraint on reservations.location_id will reject inserts without it.
 */
async function addReservation({ date, time, party_size, customer_name, customer_phone, special_requests, table_id, table_location, location_id }) {
  const result = await pool.query(
    `INSERT INTO reservations
       (date, time, party_size, customer_name, customer_phone, special_requests, table_id, table_location, location_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, date, time, party_size, customer_name, customer_phone,
               special_requests, table_id, table_location, status, location_id, created_at`,
    [date, time, party_size, customer_name, customer_phone, special_requests || '', table_id, table_location, location_id],
  );
  return result.rows[0];
}

/** Convert "HH:MM" to total minutes since midnight — used for hours-of-operation checks */
function toMinutes(time) {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

module.exports = { findConflictingTableIds, addReservation, toMinutes };
