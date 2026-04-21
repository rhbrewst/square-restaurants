const twilio = require('twilio');
const { DateTime } = require('luxon');
const locationStore = require('./locationStore');

function client() {
  return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

function formatPhone(raw) {
  const digits = raw.replace(/\D/g, '');
  return digits.startsWith('1') ? `+${digits}` : `+1${digits}`;
}

function formatDateTime(date, time, timezone) {
  // Postgres DATE serialises to "YYYY-MM-DD" in NOTIFY payloads; TIME to "HH:MM:SS".
  const d = String(date).slice(0, 10);
  const t = String(time).slice(0, 5);
  return DateTime
    .fromFormat(`${d} ${t}`, 'yyyy-MM-dd HH:mm', { zone: timezone })
    .toFormat('cccc, LLLL d, h:mm a');
}

// ─── Pure body builders (exported for testing) ───────────────────────────────

function buildConfirmationMessage(location, payload) {
  const { id, customer_name, customer_phone, date, time, party_size } = payload;
  const firstName = customer_name.split(' ')[0];
  const when      = formatDateTime(date, time, location.timezone);
  const from      = location.sms_from_number || location.twilio_number;
  const callback  = location.config?.phone || from;

  return {
    from,
    to:   formatPhone(customer_phone),
    body: `Hi ${firstName}! Your reservation at ${location.name} is confirmed — ${when} for ${party_size}. Confirmation code: ${id}. We'll see you then! To cancel, call us at ${callback}.`,
  };
}

function buildReminderMessage(location, payload) {
  const { id, customer_name, customer_phone, date, time, party_size } = payload;
  const firstName = customer_name.split(' ')[0];
  const when      = formatDateTime(date, time, location.timezone);
  const from      = location.sms_from_number || location.twilio_number;
  const callback  = location.config?.phone || from;

  return {
    from,
    to:   formatPhone(customer_phone),
    body: `Hi ${firstName}! Just a reminder about your reservation at ${location.name} tomorrow — ${when} for ${party_size}. We look forward to seeing you! Code: ${id}. Need to cancel? Call us at ${callback}.`,
  };
}

// ─── Senders ─────────────────────────────────────────────────────────────────

async function resolveLocation(payload, channel) {
  if (!payload.location_id) {
    console.error(`sms(${channel}): payload missing location_id, skipping — ${payload.id}`);
    return null;
  }
  const location = await locationStore.loadById(payload.location_id);
  if (!location) {
    console.error(`sms(${channel}): unknown location_id ${payload.location_id}, skipping — ${payload.id}`);
    return null;
  }
  return location;
}

async function sendSmsConfirmation(payload) {
  const location = await resolveLocation(payload, 'confirmation');
  if (!location) return;
  await client().messages.create(buildConfirmationMessage(location, payload));
}

async function sendSmsReminder(payload) {
  const location = await resolveLocation(payload, 'reminder');
  if (!location) return;
  await client().messages.create(buildReminderMessage(location, payload));
}

module.exports = {
  sendSmsConfirmation,
  sendSmsReminder,
  buildConfirmationMessage,
  buildReminderMessage,
};
