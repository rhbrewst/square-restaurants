/**
 * tools.js
 * Tool definitions (shared schema; tenant-agnostic) + async handlers.
 *
 * Every handler takes the resolved `location` as its last argument. Tenant
 * identity is communicated to the model via the system prompt at conversation
 * init — tool descriptions are intentionally generic so the same schema works
 * for every tenant.
 */

const { DateTime } = require('luxon');
const store        = require('./reservationStore');
const messageStore = require('./messageStore');
const pool         = require('./db');

// ─────────────────────────────────────────
// Tool Definitions (shared across tenants)
// ─────────────────────────────────────────

const TOOL_DEFINITIONS = [
  {
    name: 'get_restaurant_info',
    description:
      'Returns detailed information about the restaurant for a given topic. ' +
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
      'Returns menu items. Can return the full menu or a specific section. ' +
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
      'Checks whether a table is available for a given date, time, and party size. ' +
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
      'Books a table after availability has been confirmed. ' +
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
      'Records a message for the management team to follow up on. ' +
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

function get_restaurant_info({ topic }, location) {
  const cfg = location.config;
  const topicMap = {
    parking:           cfg.parking,
    accessibility:     cfg.accessibility,
    seating:           cfg.seating,
    bar:               cfg.bar,
    payment:           cfg.payment,
    kids:              cfg.kids,
    allergens:         cfg.allergens,
    private_dining:    cfg.private_dining,
    special_occasions: cfg.special_occasions,
    corkage:           cfg.corkage,
    pets:              cfg.pets,
    ambiance:          cfg.ambiance,
    happy_hour:        cfg.happy_hour,
    holiday_hours:     cfg.holiday_hours,
    sourcing:          cfg.sourcing,
    faqs:              cfg.faqs,
  };
  const data = topicMap[topic];
  if (!data) {
    return { error: `Unknown topic "${topic}". Valid topics: ${Object.keys(topicMap).join(', ')}.` };
  }
  return { topic, data };
}

function get_menu({ section }, location) {
  const { menu } = location.config;
  if (section === 'all') return { menu };
  if (!menu[section]) {
    return { error: `Unknown section "${section}". Valid sections: starters, mains, sides, desserts, drinks, all.` };
  }
  return { section, items: menu[section] };
}

async function check_availability({ date, time, party_size }, location) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { available: false, reason: 'Date must be in YYYY-MM-DD format.' };
  }
  if (!/^\d{2}:\d{2}$/.test(time)) {
    return { available: false, reason: 'Time must be in HH:MM 24-hour format.' };
  }

  const requested = DateTime.fromFormat(
    `${date} ${time}`, 'yyyy-MM-dd HH:mm',
    { zone: location.timezone },
  );
  const now = DateTime.now().setZone(location.timezone);

  if (!requested.isValid) {
    return { available: false, reason: 'Invalid date or time.' };
  }
  if (requested <= now) {
    return { available: false, reason: 'Reservation must be in the future.' };
  }

  const dayName = requested.toFormat('cccc').toLowerCase();
  const hours   = location.config.hours[dayName];

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

  const pol        = location.config.reservation_policy;
  const isWeekend  = ['saturday', 'sunday'].includes(dayName);
  const validSlots = isWeekend ? pol.weekend_slots : pol.slots;

  if (!validSlots.includes(time)) {
    return {
      available: false,
      reason: `${time} is not a valid slot. Available slots: ${validSlots.join(', ')}.`,
    };
  }

  const { max_party_size, min_party_size } = pol;
  if (party_size < min_party_size || party_size > max_party_size) {
    return {
      available: false,
      reason: `We accept parties of ${min_party_size}–${max_party_size} guests. Please call for larger groups.`,
    };
  }

  // location.tables is hydrated by locationStore from location_tables rows.
  // `location_label` is the seating-area name (e.g. "window", "main floor");
  // `id` is the tenant-local table id (e.g. "T1").
  const suitableTables = location.tables
    .filter((t) => t.capacity >= party_size)
    .sort((a, b) => a.capacity - b.capacity);

  const conflictingIds = await store.findConflictingTableIds(date, time, location.id);
  const freeTable = suitableTables.find((t) => !conflictingIds.includes(t.id));

  if (!freeTable) {
    const alternatives = [];
    for (const slot of validSlots) {
      if (slot === time) continue;
      const slotConflicts = await store.findConflictingTableIds(date, slot, location.id);
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

  const depositRequired = party_size >= pol.deposit_required_party_size;

  return {
    available:      true,
    date,
    time,
    party_size,
    table_id:       freeTable.id,
    table_location: freeTable.location_label,
    table_capacity: freeTable.capacity,
    deposit_required: depositRequired,
    deposit_info: depositRequired
      ? `A $${pol.deposit_amount_per_person * party_size} deposit ($${pol.deposit_amount_per_person}/person) is required for parties of ${pol.deposit_required_party_size}+. Our team will follow up to collect it.`
      : null,
    cancellation_policy: pol.cancellation_policy,
  };
}

async function book_reservation({ date, time, party_size, customer_name, customer_phone, special_requests }, location) {
  // Basic phone validation (Task 3.4)
  const cleaned = customer_phone.replace(/\D/g, '');
  if (cleaned.length < 10 || cleaned.length > 15) {
    return { success: false, reason: 'Please provide a valid phone number so we can confirm your reservation.' };
  }

  const avail = await check_availability({ date, time, party_size }, location);
  if (!avail.available) {
    return { success: false, reason: avail.reason, alternatives: avail.alternatives };
  }

  try {
    const reservation = await store.addReservation({
      date, time, party_size, customer_name, customer_phone,
      special_requests, table_id: avail.table_id, table_location: avail.table_location,
      location_id: location.id,
    });
    return {
      success:             true,
      confirmation_code:   reservation.id,
      restaurant:          location.name,
      date,
      time,
      party_size,
      table_location:      avail.table_location,
      customer_name,
      deposit_required:    avail.deposit_required,
      deposit_info:        avail.deposit_info,
      cancellation_policy: location.config.reservation_policy.cancellation_policy,
      message: `Your reservation is confirmed! Confirmation code: ${reservation.id}. We look forward to seeing you at ${location.name}.`,
    };
  } catch (err) {
    if (err.code === '23P01') {
      return { success: false, reason: 'That table is no longer available. Let me check for another option.' };
    }
    throw err;
  }
}

async function cancel_reservation({ confirmation_code, customer_phone, reason }, location) {
  const result = await pool.query(
    `SELECT * FROM reservations
      WHERE id = LOWER($1)
        AND location_id = $2
        AND status = 'confirmed'`,
    [confirmation_code, location.id],
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

  const resTime = DateTime.fromFormat(
    `${String(res.date).slice(0, 10)} ${String(res.time).slice(0, 5)}`,
    'yyyy-MM-dd HH:mm',
    { zone: location.timezone },
  );
  const hoursUntil = resTime.diffNow('hours').hours;
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

async function leave_message({ caller_name, caller_phone, subject, message }, location) {
  const record = await messageStore.addMessage({
    caller_name, caller_phone, subject, message,
    location_id: location.id,
  });
  return {
    success:      true,
    message_id:   record.id,
    confirmation: `Thank you, ${caller_name}. I've passed your message to our team and someone will be in touch at ${caller_phone} as soon as possible.`,
  };
}

// ─────────────────────────────────────────
// Dispatch
// ─────────────────────────────────────────

async function handleToolCall(toolName, toolInput, location) {
  if (!location) {
    return { error: 'Internal error: tenant not resolved.' };
  }
  if (Array.isArray(location.enabled_tools) && !location.enabled_tools.includes(toolName)) {
    return { error: 'This tool is not enabled for this location.' };
  }

  switch (toolName) {
    case 'get_restaurant_info': return get_restaurant_info(toolInput, location);
    case 'get_menu':            return get_menu(toolInput, location);
    case 'check_availability':  return check_availability(toolInput, location);
    case 'book_reservation':    return book_reservation(toolInput, location);
    case 'cancel_reservation':  return cancel_reservation(toolInput, location);
    case 'leave_message':       return leave_message(toolInput, location);
    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

module.exports = { TOOL_DEFINITIONS, handleToolCall };
