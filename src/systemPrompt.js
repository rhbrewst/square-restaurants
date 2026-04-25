const { DateTime } = require('luxon');

const TOOL_DESCRIPTIONS = {
  get_restaurant_info:
    '- get_restaurant_info(topic) — use for detailed questions about parking, accessibility, seating, payment, kids, allergens, private dining, special occasions, corkage, ambiance, holiday hours, or sourcing',
  get_menu:
    '- get_menu(section) — use for food and drink questions',
  check_availability:
    '- check_availability(date, time, party_size) — always call this before booking',
  book_reservation:
    '- book_reservation(...) — call after confirming availability',
  cancel_reservation:
    '- cancel_reservation(confirmation_code, customer_phone) — use when a caller wants to cancel; verify their code and phone first, then confirm details before cancelling',
  leave_message:
    '- leave_message(caller_name, caller_phone, subject, message) — use when someone has feedback, a complaint, a lost item, a private event inquiry, or any request that needs management follow-up. Always get their name and number first.',
};

// ─── Per-tenant fact helpers ─────────────────────────────────────────────────
// Each helper reads from location.config and returns a one-line fact for the
// "Key facts" block, or null to skip. The point of these is to keep the prompt
// truthful for whichever tenant is on the call — every fact lived as hardcoded
// English in this file before The Tide House surfaced "We do not have outdoor
// seating" leaking onto a tenant that very much does have a patio.

function depositFact(pol) {
  if (!pol?.deposit_required_party_size || !pol?.deposit_amount_per_person) return null;
  return (
    `Reservations are FREE for parties of 1–${pol.deposit_required_party_size - 1}. ` +
    `A $${pol.deposit_amount_per_person}/person deposit (credited to the bill) is required for parties of ${pol.deposit_required_party_size}+.`
  );
}

function autoGratuityFact(pay) {
  const g = pay?.auto_gratuity;
  if (!g?.percentage || !g?.applies_to_party_size) return null;
  return (
    `Auto-gratuity of ${g.percentage}% is added for parties of ${g.applies_to_party_size}+. ` +
    `For smaller parties gratuity is at the guest's discretion.`
  );
}

function accessibilityFact(cfg) {
  // Prefer a tenant-supplied human note; fall back to deriving one from the
  // structured booleans for tenants whose config (Ember) predates the `.note`
  // convention.
  if (cfg.accessibility?.note) return cfg.accessibility.note;
  const a = cfg.accessibility;
  if (a?.step_free_entrance && a?.accessible_restrooms) {
    return 'We are fully wheelchair accessible — step-free entrance, accessible restrooms and tables.';
  }
  return null;
}

function kidsFact(cfg) {
  if (cfg.kids?.note) return cfg.kids.note;
  if (cfg.kids?.high_chairs && cfg.kids?.booster_seats) {
    return 'We have high chairs and booster seats for children.';
  }
  return null;
}

function barFact(cfg) {
  if (cfg.bar?.note) return cfg.bar.note;
  if (cfg.bar?.seat_count) {
    return `Bar seating has ${cfg.bar.seat_count} seats and the full menu is available at the bar.`;
  }
  return null;
}

function happyHourFact(cfg) {
  return cfg.happy_hour?.note || null;
}

function outdoorSeatingFact(cfg) {
  if (cfg.seating?.outdoor_note) return cfg.seating.outdoor_note;
  return cfg.seating?.outdoor_seating
    ? 'We have outdoor seating.'
    : 'We do not have outdoor seating.';
}

function petsFact(cfg) {
  return cfg.pets?.note || 'Service animals are always welcome. Pets are not permitted.';
}

function buildKeyFacts(cfg, pol, pay) {
  const lines = [
    depositFact(pol),
    autoGratuityFact(pay),
    accessibilityFact(cfg),
    kidsFact(cfg),
    barFact(cfg),
    happyHourFact(cfg),
    outdoorSeatingFact(cfg),
    petsFact(cfg),
    'For lost and found, feedback, complaints, private event inquiries, farm/supplier questions, ' +
      'or anything else you cannot fully resolve, offer to take a message so management can call them back. ' +
      'Do NOT just redirect them to ring the main line — collect their name, phone number, and details ' +
      'using the leave_message tool.',
  ];
  return lines.filter(Boolean).map((l) => `- ${l}`).join('\n');
}

// ─── Main ────────────────────────────────────────────────────────────────────

function buildSystemPrompt(location, now) {
  const nowLocal = now ?? DateTime.now().setZone(location.timezone);
  const todayStr = nowLocal.toFormat('cccc, LLLL d, yyyy');
  const timeStr  = nowLocal.toFormat('h:mm a');
  const cfg = location.config;
  const pol = cfg.reservation_policy;
  const pay = cfg.payment;

  const enabledTools = Array.isArray(location.enabled_tools) ? location.enabled_tools : Object.keys(TOOL_DESCRIPTIONS);
  const toolLines = enabledTools
    .map((name) => TOOL_DESCRIPTIONS[name])
    .filter(Boolean)
    .join('\n');

  return `You are a friendly and professional reservations assistant for ${location.name}, ${cfg.tagline}.

About the restaurant:
${cfg.description}

Address: ${cfg.address}
Phone: ${cfg.phone}
Email: ${cfg.email}

Hours:
${Object.entries(cfg.hours).map(([d, h]) => `  ${d.charAt(0).toUpperCase() + d.slice(1)}: ${h.open}–${h.close} (kitchen closes ${h.kitchen_close})`).join('\n')}

Key facts you must know and state accurately — never guess these:
${buildKeyFacts(cfg, pol, pay)}

Your tools:
${toolLines}

Guidelines:
- Be warm, concise, and conversational — this is a phone call
- When checking availability or booking, always confirm the details back to the caller
- If a slot is not available, proactively suggest the nearest alternatives
- Always clarify the full date (day, month, year) to avoid confusion
- Today is ${todayStr}. The current time is ${timeStr}.
- Always use tools to look up information — never guess or make up facts
- After a successful booking, read the confirmation code clearly, one letter or digit at a time
- Keep responses brief and natural for voice — no bullet points, no markdown`;
}

module.exports = { buildSystemPrompt, buildKeyFacts, TOOL_DESCRIPTIONS };
