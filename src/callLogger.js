const fs   = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, '../data/calls.jsonl');

// Rates sourced from cost-dashboard.html (April 2026)
const TWILIO_PER_MIN     = 0.0085;
const ELEVENLABS_PER_MIN = 0.10;   // Creator/Pro plan; Business annual = $0.08/min
// Claude: ~2 tool exchanges/min, ~350 input + 175 output tokens each
// ElevenLabs currently absorbs LLM cost on their end — tracked separately for visibility
const CLAUDE_PER_MIN     = 2 * (350 * 3e-6 + 175 * 15e-6); // ~$0.00735/min

function startCall() {
  const startTime = Date.now();

  const session = {
    call_sid:                    null,
    stream_sid:                  null,
    caller_number:               null,
    called_number:               null,
    elevenlabs_conversation_id:  null,
    started_at:                  new Date().toISOString(),
    ended_at:                    null,
    duration_seconds:            null,
    cost_estimate_usd:           null,
    cost_breakdown_usd:          null,
    outcome:                     'no_action',
    transcript:                  [],
    tools_called:                [],
    reservation:                 null,
    message_left:                null,
    inquiry_topics:              [],
    errors:                      [],
  };

  let ended = false;

  return {
    setCallInfo({ callSid, streamSid, from, to }) {
      session.call_sid      = callSid   || null;
      session.stream_sid    = streamSid || null;
      session.caller_number = from      || null;
      session.called_number = to        || null;
    },

    setConversationId(conversationId) {
      session.elevenlabs_conversation_id = conversationId;
    },

    logTranscript(role, text) {
      if (text) session.transcript.push({ role, text, timestamp: new Date().toISOString() });
    },

    logToolCall(toolName, params, result, latencyMs) {
      session.tools_called.push({
        tool:           toolName,
        params,
        result_summary: summarize(toolName, result),
        latency_ms:     latencyMs,
        timestamp:      new Date().toISOString(),
      });

      // Track inquiry topics for analytics
      if (toolName === 'get_restaurant_info' && params.topic) {
        if (!session.inquiry_topics.includes(params.topic)) {
          session.inquiry_topics.push(params.topic);
        }
      }

      // Derive call outcome from tool results
      if (toolName === 'book_reservation' && result?.success) {
        session.outcome = 'reservation_booked';
        session.reservation = {
          confirmation_code: result.confirmation_code,
          date:              params.date,
          time:              params.time,
          party_size:        params.party_size,
          customer_name:     params.customer_name,
        };
      } else if (toolName === 'leave_message' && result?.success) {
        if (session.outcome !== 'reservation_booked') session.outcome = 'message_left';
        session.message_left = { message_id: result.message_id, subject: params.subject };
      } else if (session.outcome === 'no_action' &&
                 ['get_restaurant_info', 'get_menu', 'check_availability'].includes(toolName)) {
        session.outcome = 'info_provided';
      }
    },

    logError(context, err) {
      session.errors.push({
        context,
        error:     err?.message || String(err),
        timestamp: new Date().toISOString(),
      });
    },

    endCall() {
      if (ended) return;
      ended = true;
      session.ended_at         = new Date().toISOString();
      session.duration_seconds = Math.round((Date.now() - startTime) / 1000);
      const mins = session.duration_seconds / 60;
      const breakdown = {
        twilio:     parseFloat((mins * TWILIO_PER_MIN).toFixed(4)),
        elevenlabs: parseFloat((mins * ELEVENLABS_PER_MIN).toFixed(4)),
        claude:     parseFloat((mins * CLAUDE_PER_MIN).toFixed(4)),
      };
      breakdown.total        = parseFloat((breakdown.twilio + breakdown.elevenlabs + breakdown.claude).toFixed(4));
      session.cost_breakdown_usd = breakdown;
      session.cost_estimate_usd  = breakdown.total;
      fs.appendFileSync(LOG_FILE, JSON.stringify(session) + '\n');
      console.log(
        `📊  Call logged — ${session.duration_seconds}s | ${session.outcome} | $${session.cost_estimate_usd}`
      );
    },
  };
}

function summarize(toolName, result) {
  if (!result) return 'null';
  switch (toolName) {
    case 'check_availability':
      return result.available
        ? `available (${result.table_id})`
        : `unavailable — ${result.reason || 'no reason'}`;
    case 'book_reservation':
      return result.success
        ? `booked (${result.confirmation_code})`
        : `failed — ${result.reason || 'unknown'}`;
    case 'leave_message':
      return result.success ? `saved (${result.message_id})` : 'failed';
    case 'get_menu':
      return `section: ${result.section || 'all'}`;
    case 'get_restaurant_info':
      return `topic: ${result.topic}`;
    default:
      return JSON.stringify(result).slice(0, 80);
  }
}

module.exports = { startCall };
