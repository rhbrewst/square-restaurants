const pool = require('./db');

// Rates sourced from cost-dashboard.html (April 2026)
const TWILIO_PER_MIN     = 0.0085;
const ELEVENLABS_PER_MIN = 0.10;   // Creator/Pro plan; Business annual = $0.08/min
// Claude: ~2 tool exchanges/min, ~350 input + 175 output tokens each
const CLAUDE_PER_MIN     = 2 * (350 * 3e-6 + 175 * 15e-6); // ~$0.00735/min

function startCall() {
  const startTime = Date.now();
  let ended = false;

  const session = {
    call_sid:                    null,
    stream_sid:                  null,
    caller_number:               null,
    called_number:               null,
    elevenlabs_conversation_id:  null,
    outcome:                     'no_action',
    transcript:                  [],
    tools_called:                [],
    reservation_id:              null,
    message_id:                  null,
    inquiry_topics:              [],
    errors:                      [],
  };

  // Insert the call row immediately so we have a DB id to UPDATE at end.
  // Other fields are filled in via UPDATE in endCall().
  // NOTE: started_at is ms-truncated BOTH on store and on return, because
  // JS Date is ms-precision but `DEFAULT NOW()` gives µs-precision. Without
  // truncation, the UPDATE's `WHERE started_at = $N` never matches (the JS
  // Date we pass back is ms, the stored value is µs) and the call data is
  // silently dropped.
  const dbRowPromise = pool.query(
    `INSERT INTO calls (started_at) VALUES (date_trunc('milliseconds', NOW()))
     RETURNING id, started_at`,
  ).then((r) => r.rows[0]).catch((err) => {
    console.error('Failed to create call row in DB:', err.message);
    return null;
  });

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

      if (toolName === 'get_restaurant_info' && params.topic) {
        if (!session.inquiry_topics.includes(params.topic)) {
          session.inquiry_topics.push(params.topic);
        }
      }

      if (toolName === 'book_reservation' && result?.success) {
        session.outcome       = 'reservation_booked';
        session.reservation_id = result.confirmation_code;
      } else if (toolName === 'leave_message' && result?.success) {
        if (session.outcome !== 'reservation_booked') session.outcome = 'message_left';
        session.message_id = result.message_id;
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

    async endCall() {
      if (ended) return;
      ended = true;

      const endedAt        = new Date();
      const durationSeconds = Math.round((Date.now() - startTime) / 1000);
      const mins            = durationSeconds / 60;
      const breakdown = {
        twilio:     parseFloat((mins * TWILIO_PER_MIN).toFixed(4)),
        elevenlabs: parseFloat((mins * ELEVENLABS_PER_MIN).toFixed(4)),
        claude:     parseFloat((mins * CLAUDE_PER_MIN).toFixed(4)),
      };
      breakdown.total = parseFloat((breakdown.twilio + breakdown.elevenlabs + breakdown.claude).toFixed(4));

      const dbRow = await dbRowPromise;
      if (!dbRow) {
        console.error('endCall: no DB row to update — call data lost');
        return;
      }

      try {
        await pool.query(
          `UPDATE calls SET
             call_sid                   = $1,
             stream_sid                 = $2,
             caller_number              = $3,
             called_number              = $4,
             elevenlabs_conversation_id = $5,
             ended_at                   = $6,
             duration_seconds           = $7,
             outcome                    = $8,
             cost_estimate_usd          = $9,
             cost_breakdown_usd         = $10,
             transcript                 = $11,
             tools_called               = $12,
             inquiry_topics             = $13,
             reservation_id             = $14,
             message_id                 = $15,
             errors                     = $16
           WHERE id = $17 AND started_at = $18`,
          [
            session.call_sid,
            session.stream_sid,
            session.caller_number,
            session.called_number,
            session.elevenlabs_conversation_id,
            endedAt,
            durationSeconds,
            session.outcome,
            breakdown.total,
            JSON.stringify(breakdown),
            JSON.stringify(session.transcript),
            JSON.stringify(session.tools_called),
            session.inquiry_topics,
            session.reservation_id,
            session.message_id,
            JSON.stringify(session.errors),
            dbRow.id,
            dbRow.started_at,
          ],
        );
        console.log(
          `📊  Call logged — ${durationSeconds}s | ${session.outcome} | $${breakdown.total}`,
        );
      } catch (err) {
        console.error('endCall: failed to write to DB:', err.message);
      }
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
