const twilio = require('twilio');
const { DateTime } = require('luxon');
const restaurant = require('../config/restaurant.json');

const FROM = process.env.TWILIO_PHONE_NUMBER;

function client() {
  return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

function formatPhone(raw) {
  const digits = raw.replace(/\D/g, '');
  return digits.startsWith('1') ? `+${digits}` : `+1${digits}`;
}

function formatDateTime(date, time) {
  // Postgres DATE serialises to "YYYY-MM-DD" in NOTIFY payloads; TIME to "HH:MM:SS".
  const d = String(date).slice(0, 10);
  const t = String(time).slice(0, 5);
  return DateTime
    .fromFormat(`${d} ${t}`, 'yyyy-MM-dd HH:mm', { zone: restaurant.timezone })
    .toFormat('cccc, LLLL d, h:mm a');
}

async function sendSmsConfirmation({ id, customer_name, customer_phone, date, time, party_size, table_location }) {
  const name = customer_name.split(' ')[0];
  const dt   = formatDateTime(date, time);
  await client().messages.create({
    from: FROM,
    to:   formatPhone(customer_phone),
    body: `Hi ${name}! Your reservation at The Ember Room is confirmed — ${dt} for ${party_size}. Confirmation code: ${id}. We'll see you then! To cancel, call us at ${process.env.RESTAURANT_PHONE}.`,
  });
}

async function sendSmsReminder({ id, customer_name, customer_phone, date, time, party_size }) {
  const name = customer_name.split(' ')[0];
  const dt   = formatDateTime(date, time);
  await client().messages.create({
    from: FROM,
    to:   formatPhone(customer_phone),
    body: `Hi ${name}! Just a reminder about your reservation at The Ember Room tomorrow — ${dt} for ${party_size}. We look forward to seeing you! Code: ${id}. Need to cancel? Call us at ${process.env.RESTAURANT_PHONE}.`,
  });
}

module.exports = { sendSmsConfirmation, sendSmsReminder };
