/**
 * messageStore.js
 * Persists messages left for management to data/messages.json.
 * Mirrors the pattern in reservationStore.js.
 */

const fs   = require('fs');
const path = require('path');

const DATA_DIR   = path.join(__dirname, '..', 'data');
const STORE_PATH = path.join(DATA_DIR, 'messages.json');

function loadAll() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch {
    return [];
  }
}

function saveAll(messages) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(messages, null, 2));
}

function addMessage(message) {
  const all = loadAll();
  all.push(message);
  saveAll(all);
  return message;
}

function generateId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return 'MSG-' + Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

module.exports = { loadAll, addMessage, generateId };
