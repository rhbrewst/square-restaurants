/**
 * tools.js
 * Claude tool definitions + async handler functions.
 *
 * DEFINITIONS — passed to the Anthropic API as the `tools` array.
 * HANDLERS    — called when Claude returns a tool_use block.
 */

const restaurant   = require('../config/restaurant.json');
const store        = require('./reservationStore');
const messageStore = require('./messageStore');
const pool         = require('./db');

// ─────────────────────────────────────────
// Tool Definitions (Claude API schema)
// ─────────────────────────────────────────

const TOOL_DEFINITIONS = [
  {
    name: 'get_restaurant_info',
    description:
      'Returns detailed information about The Ember Room for a given topic. ' +
      'Use this when the caller asks about parking, accessibility, seating, bar, ' +
      'payment, kids facilities, allergens, private dining, special occasions, ' +
      'corkage, pets, ambiance, happy hour, holiday hours, or local sourcing. ' +
      'Do NOT use this for menu or reservation questions — use get_menu or check_availability instead.',
    input_schema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          enum: [
            'parking', 'accessibility', 'seating', 'bar', 'payment', 'kids',
            'allergens', 'private_dining', 'special_occasions', 'corkage',
            'pets', 'ambiance', 'happy_hour', 'holiday_hours', 'sourcing', 'faqs',
          ],
          description: 'The topic the caller is asking about.',
        },
      },
      required: ['topic'],
    },
  },
  {
    name: 'get_menu',
    description:
      'Returns menu items from The Ember Room. Can return the full menu or a specific section. ' +
      'Use this when the caller asks about food, drinks, prices, or dietary options.',
    input_schema: {
      type: 'object',
      properties: {
        section: {
          type: 'string',
          enum: ['starters', 'mains', 'sides', 'desserts', 'drinks', 'all'],
          description: 'Which menu section to return. Use "all" for the full menu.',
        },
      },
      required: ['section'],
    },
  },
  {
    name: 'check_availability',
    description:
      'Checks whether The Ember Room has a table available for a given date, time, and party size. ' +
      'Returns available time slots if the requested slot is taken. ' +
      'Date must be in YYYY-MM-DD format. Time must be in HH:MM (24-hour) format.',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Reservation date in YYYY-MM-DD format (e.g. "2026-04-25")' },
        time: { type: 'string', description: 'Desired start time in HH:MM 24-hour format (e.g. "19:00")' },
        party_size: { type: 'integer', description: 'Number of guests (1–8)' },
      },
      required: ['date', 'time', 'party_size'],
    },
  },
  {
    name: 'book_reservation',
    description:
      'Books a table at The Ember Room after availability has been confirmed. ' +
      'Always call check_availability first. Returns a confirmation code.',
    input_schema: {
      type: 'object',
      properties: {
        date:             { type: 'string', description: 'Reservation date in YYYY-MM-DD format' },
        time:             { type: 'string', description: 'Start time in HH:MM 24-hour format' },
        party_size:       { type: 'integer', description: 'Number of guests' },
        customer_name:    { type: 'string', description: 'Full name for the reservation' },
        customer_phone:   { type: 'string', description: 'Caller phone number for confirmation / reminders' },
        special_requests: { type: 'string', description: 'Any dietary needs, special occasions, or seating preferences (optional)' },
      },
      required: ['date', 'time', 'party_size', 'customer_name', 'customer_phone'],
    },
  },
  {
    name: 'cancel_reservation',
    description:
      'Cancels an existing reservation by confirmation code. ' +
      'Ask the caller for their confirmation code and phone number to verify ownership. ' +
      'Cancellations must be more than 24 hours before the reservation time to avoid a fee. ' +
      'Always confirm the reservation details back to the caller before cancelling.',
    input_schema: {
      type: 'object',
      properties: {
        confirmation_code: { type: 'string', description: 'The confirmation code from the original booking' },
        customer_phone:    { type: 'string', description: 'Phone number used when booking, for verification' },
        reason:            { type: 'string', description: 'Optional cancellation reason' },
      },
      required: ['confirmation_code', 'customer_phone'],
    },
  },
  {
    name: 'leave_message',
    description:
      'Records a message for the restaurant management team to follow up on. ' +
      'Use this instead of directing callers to ring back when they: have feedback about a prior visit, ' +
      'have a lost and found inquiry, want to discuss a private event, have a complaint or compliment, ' +
      'have a question you cannot answer, or request a callback for any reason. ' +
      'Always collect the caller\'s name and phone number before calling this tool.',
    input_schema: {
      type: 'object',
      properties: {
        caller_name:  { type: 'string', description: 'Full name of the caller' },
        caller_phone: { type: 'string', description: 'Phone number to call back' },
        subject:      { type: 'string', description: 'Brief subject — e.g. "Lost item", "Feedback", "Private event inquiry", "General question", "Complaint"' },
        message:      { type: 'string', description: 'Full details of what the caller wants management to know or follow up on' },
      },
      required: ['caller_name', 'caller_phone', 'subject', 'message'],
    },
  },
];

// ─────────────────────────────────────────
// Tool Handlers
// ─────────────────────────────────────────

function get_restaurant_info({ topic }) {
  const topicMap = {
    parking:           restaurant.parking,
    accessibility:     restaurant.accessibility,
    seating:           restaurant.seating,
    bar:               restaurant.bar,
    payment:           restaurant.payment,
    kids:              restaurant.kids,
    allergens:         restaurant.allergens,
    private_dining:    restaurant.private_dining,
    special_occasions: restaurant.special_occasions,
    corkage:           restaurant.corkage,
    pets:              restaurant.pets,
    ambiance:          restaurant.ambiance,
    happy_hour:        restaurant.happy_hour,
    holiday_hours:     restaurant.holiday_hours,
    sourcing:          restaurant.sourcing,
    faqs:              restaurant.faqs,
  };
  const data = topicMap[topic];
  if (!data) {
    return { error: `Unknown topic "${topic}". Valid topics: ${Object.keys(topicMap).join(', ')}.` };
  }
  return { topic, data };
}

function get_menu({ section }) {
  const { menu } = restaurant;
  if (section === 'all') return { menu };
  if (!menu[section]) {
    return { error: `Unknown section "${section}". Valid sections: starters, mains, sides, desserts, drinks, all.` };
  }
  return { section, items: menu[section] };
}

async function check_availability({ date, time, party_size }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { available: false, reason: 'Date must be in YYYY-MM-DD format.' };
  }
  if (!/^\d{2}:\d{2}$/.test(time)) {
    return { available: false, reason: 'Time must be in HH:MM 24-hour format.' };
  }

  const requested = new Date(`${date}T${time}:00`);
  const now        = new Date();

  if (isNaN(requested.getTime())) {
    return { available: false, reason: 'Invalid date or time.' };
  }
  if (requested <= now) {
    return { available: false, reason: 'Reservation must be in the future.' };
  }

  const dayName = requested.toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
  const hours   = restaurant.hours[dayName];

  if (!hours) {
    return { available: false, reason: `We are closed on ${dayName}s.` };
  }

  const { toMinutes } = store;
  const reqMins   = toMinutes(time);
  const openMins  = toMinutes(hours.open);
  const closeMins = toMinutes(hours.close);

  if (reqMins < openMins || reqMins >= closeMins - 30) {
    return {
      available: false,
      reason: `We are open ${hours.open}–${hours.close} on ${dayName}s. Last seating is 30 minutes before close.`,
    };
  }

  const isWeekend  = ['saturday', 'sunday'].includes(dayName);
  const validSlots = isWeekend
    ? restaurant.reservation_policy.weekend_slots
    : restaurant.reservation_policy.slots;

  if (!validSlots.includes(time)) {
    return {
      available: false,
      reason: `${time} is not a valid slot. Available slots: ${validSlots.join(', ')}.`,
    };
  }

  const { max_party_size, min_party_size } = restaurant.reservation_policy;
  if (party_size < min_party_size || party_size > max_party_size) {
    return {
      available: false,
      reason: `We accept parties of ${min_party_size}–${max_party_size} guests. Please call for larger groups.`,
    };
  }

  const suitableTables = restaurant.tables
    .filter((t) => t.capacity >= party_size)
    .sort((a, b) => a.capacity - b.capacity);

  const conflictingIds = await store.findConflictingTableIds(date, time);
  const freeTable = suitableTables.find((t) => !conflictingIds.includes(t.id));

  if (!freeTable) {
    const alternatives = [];
    for (const slot of validSlots) {
      if (slot === time) continue;
      const slotConflicts = await store.findConflictingTableIds(date, slot);
      if (suitableTables.some((t) => !slotConflicts.includes(t.id))) {
        alternatives.push(slot);
        if (alternatives.length >= 3) break;
      }
    }
    return {
      available: false,
      reason: `No tables for ${party_size} are available at ${time} on ${date}.`,
      alternatives: alternatives.length
        ? `Available slots on the same day: ${alternatives.join(', ')}`
        : 'No other slots available that day — please try a different date.',
    };
  }

  const policy          = restaurant.reservation_policy;
  const depositRequired = party_size >= policy.deposit_required_party_size;

  return {
    available:      true,
    date,
    time,
    party_size,
    table_id:       freeTable.id,
    table_location: freeTable.location,
    table_capacity: freeTable.capacity,
    deposit_required: depositRequired,
    deposit_info: depositRequired
      ? `A $${policy.deposit_amount_per_person * party_size} deposit ($${policy.deposit_amount_per_person}/person) is required for parties of ${policy.deposit_required_party_size}+. Our team will follow up to collect it.`
      : null,
    cancellation_policy: policy.cancellation_policy,
  };
}

async function book_reservation({ date, time, party_size, customer_name, customer_phone, special_requests }) {
  // Basic phone validation (Task 3.4)
  const cleaned = customer_phone.replace(/\D/g, '');
  if (cleaned.length < 10 || cleaned.length > 15) {
    return { success: false, reason: 'Please provide a valid phone number so we can confirm your reservation.' };
  }

  const avail = await check_availability({ date, time, party_size });
  if (!avail.available) {
    return { success: false, reason: avail.reason, alternatives: avail.alternatives };
  }

  try {
    const reservation = await store.addReservation({
      date, time, party_size, customer_name, customer_phone,
      special_requests, table_id: avail.table_id, table_location: avail.table_location,
    });
    return {
      success:             true,
      confirmation_code:   reservation.id,
      restaurant:          restaurant.name,
      date,
      time,
      party_size,
      table_location:      avail.table_location,
      customer_name,
      deposit_required:    avail.deposit_required,
      deposit_info:        avail.deposit_info,
      cancellation_policy: restaurant.reservation_policy.cancellation_policy,
      message: `Your reservation is confirmed! Confirmation code: ${reservation.id}. We look forward to seeing you at ${restaurant.name}.`,
    };
  } catch (err) {
    if (err.code === '23P01') {
      return { success: false, reason: 'That table is no longer available. Let me check for another option.' };
    }
    throw err;
  }
}

async function cancel_reservation({ confirmation_code, customer_phone, reason }) {
  const result = await pool.query(
    `SELECT * FROM reservations WHERE id = LOWER($1) AND status = 'confirmed'`,
    [confirmation_code],
  );

  if (!result.rows.length) {
    return { success: false, reason: 'No confirmed reservation found with that code.' };
  }

  const res         = result.rows[0];
  const phoneDigits = (customer_phone || '').replace(/\D/g, '').slice(-10);
  const storedDigits = (res.customer_phone || '').replace(/\D/g, '').slice(-10);

  if (phoneDigits !== storedDigits) {
    return { success: false, reason: 'Phone number does not match the reservation. Please double-check.' };
  }

  const resTime    = new Date(`${String(res.date).slice(0, 10)}T${String(res.time).slice(0, 5)}`);
  const hoursUntil = (resTime - new Date()) / 3_600_000;
  const lateFee    = hoursUntil < 24 && res.party_size >= 5;

  await pool.query(
    `UPDATE reservations SET status = 'cancelled', cancelled_at = NOW(), cancellation_reason = $2 WHERE id = $1`,
    [res.id, reason || null],
  );

  return {
    success:           true,
    confirmation_code: res.id,
    date:              res.date,
    time:              res.time,
    party_size:        res.party_size,
    late_fee_notice:   lateFee
      ? `Please note: cancellations within 24 hours for parties of 5 or more may be subject to a $25 per person fee. Our team will be in touch.`
      : null,
    message: `Your reservation has been cancelled. We hope to see you again soon.`,
  };
}

async function leave_message({ caller_name, caller_phone, subject, message }) {
  const record = await messageStore.addMessage({ caller_name, caller_phone, subject, message });
  return {
    success:      true,
    message_id:   record.id,
    confirmation: `Thank you, ${caller_name}. I've passed your message to our team and someone will be in touch at ${caller_phone} as soon as possible.`,
  };
}

// ─────────────────────────────────────────
// Dispatch
// ─────────────────────────────────────────

async function handleToolCall(toolName, toolInput) {
  switch (toolName) {
    case 'get_restaurant_info': return get_restaurant_info(toolInput);
    case 'get_menu':            return get_menu(toolInput);
    case 'check_availability':  return check_availability(toolInput);
    case 'book_reservation':    return book_reservation(toolInput);
    case 'cancel_reservation':  return cancel_reservation(toolInput);
    case 'leave_message':       return leave_message(toolInput);
    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

module.exports = { TOOL_DEFINITIONS, handleToolCall };
