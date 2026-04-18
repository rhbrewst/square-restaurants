/**
 * reservationStore.js
 * Thin read/write layer over data/reservations.json.
 * All functions are synchronous for simplicity in Phase 3.
 */

const fs   = require('fs');
const path = require('path');

const STORE_PATH = path.join(__dirname, '..', 'data', 'reservations.json');

/** Return all reservations */
function loadAll() {
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

/** Persist the full reservations array */
function saveAll(reservations) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(reservations, null, 2));
}

/**
 * Find reservations that overlap with a given date + time slot.
 * We treat every booking as occupying a 90-minute window.
 */
function findConflicts(reservations, date, time, tableId) {
  const slotStart = toMinutes(time);
  const slotEnd   = slotStart + 90;

  return reservations.filter(r => {
    if (r.date !== date || r.tableId !== tableId) return false;
    const rStart = toMinutes(r.time);
    const rEnd   = rStart + 90;
    return slotStart < rEnd && slotEnd > rStart; // overlap
  });
}

/** Add a new reservation and persist */
function addReservation(reservation) {
  const all = loadAll();
  all.push(reservation);
  saveAll(all);
  return reservation;
}

/** Generate a short human-readable confirmation code */
function generateId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

/** Convert "HH:MM" to total minutes since midnight */
function toMinutes(time) {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

module.exports = { loadAll, saveAll, findConflicts, addReservation, generateId, toMinutes };
