require('dotenv').config({ override: true });
const express    = require('express');
const http       = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const { Client } = require('pg');
const twilio     = require('twilio');
const rateLimit  = require('express-rate-limit');
const pool       = require('./db');
const { handleToolCall }                  = require('./tools');
const { startCall }                       = require('./callLogger');
const { sendSmsConfirmation, sendSmsReminder } = require('./sms');
const restaurant = require('../config/restaurant.json');

// ─── Startup env check (Task 2.3) ────────────────────────────────────────────
// Crashes in production if any required variable is missing; warns in dev.

const REQUIRED_ENV = [
  'ELEVENLABS_API_KEY', 'ELEVENLABS_AGENT_ID',
  'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_PHONE_NUMBER',
  'DATABASE_URL', 'PUBLIC_URL',
];

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    const msg = `Missing required environment variable: ${key}`;
    if (process.env.NODE_ENV === 'production') {
      console.error(msg);
      process.exit(1);
    } else {
      console.warn(`⚠️  ${msg}`);
    }
  }
}

const {
  PORT = 3000,
  ELEVENLABS_API_KEY,
  ELEVENLABS_AGENT_ID,
} = process.env;

// Capture caller info from the Twilio webhook before the WebSocket upgrades.
const pendingCalls = new Map();

const app = express();
// Trust Railway's load balancer so X-Forwarded-For is used correctly by
// express-rate-limit and req.ip. '1' = trust the first proxy hop only.
app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ─── Rate limiting (Task 2.2) ─────────────────────────────────────────────────
// Cap webhook hits to guard against accidental or malicious flooding.

const callLimiter = rateLimit({
  windowMs:       60_000,
  max:            20,
  standardHeaders: true,
  legacyHeaders:  false,
  message:        'Too many requests',
});

app.use('/incoming-call', callLimiter);

// ─── Twilio signature validation (Task 2.1) ───────────────────────────────────
// Only enforced when PUBLIC_URL is set (always in production; skipped in local dev).
// Body must already be parsed (urlencoded above) before this middleware runs.

if (process.env.PUBLIC_URL) {
  app.use('/incoming-call', (req, res, next) => {
    const valid = twilio.validateExpressRequest(req, process.env.TWILIO_AUTH_TOKEN, {
      url: process.env.PUBLIC_URL + '/incoming-call',
    });
    if (!valid) {
      console.warn('Rejected request with invalid Twilio signature from', req.ip);
      return res.status(403).send('Forbidden');
    }
    next();
  });
}

// ─── Twilio webhook ───────────────────────────────────────────────────────────

app.post('/incoming-call', (req, res) => {
  if (req.body.CallSid) {
    pendingCalls.set(req.body.CallSid, {
      callSid: req.body.CallSid,
      from:    req.body.From || null,
      to:      req.body.To   || null,
    });
  }
  const twiml   = new twilio.twiml.VoiceResponse();
  const connect = twiml.connect();
  connect.stream({ url: `wss://${req.headers.host}/media-stream` });
  res.type('text/xml').send(twiml.toString());
});

// ─── Health check (Task 3.1) ──────────────────────────────────────────────────

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'ok', uptime: process.uptime() });
  } catch (err) {
    res.status(503).json({ status: 'error', db: err.message });
  }
});

// ─── HTTP + WebSocket server ──────────────────────────────────────────────────

const server = http.createServer(app);
const wss    = new WebSocketServer({ server, path: '/media-stream' });

// Tracks live WebSocket sessions for graceful shutdown (Task 3.2)
const activeSessions = new Set();

wss.on('connection', (twilioWs) => {
  console.log('\n📞 Incoming call — connecting to ElevenLabs…');
  activeSessions.add(twilioWs);

  let streamSid = null;
  let callSid   = null;   // hoisted for ElevenLabs error recovery (Task 3.3)
  const logger  = startCall();

  const elWs = new WebSocket(
    `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${ELEVENLABS_AGENT_ID}`,
    { headers: { 'xi-api-key': ELEVENLABS_API_KEY } },
  );

  elWs.on('open', () => {
    console.log('✅ ElevenLabs connected');
    elWs.send(JSON.stringify({
      type: 'conversation_initiation_client_data',
      conversation_config_override: {
        agent: {
          prompt:        { prompt: buildSystemPrompt() },
          first_message: `Thank you for calling ${restaurant.name}. How can I help you today?`,
        },
      },
    }));
  });

  // ── Twilio → ElevenLabs ───────────────────────────────────────────────────

  twilioWs.on('message', (raw) => {
    const msg = JSON.parse(raw);

    switch (msg.event) {
      case 'start': {
        streamSid = msg.start.streamSid;
        callSid   = msg.start.callSid;
        console.log(`📡 Media stream started (${streamSid})`);
        const callInfo = pendingCalls.get(msg.start.callSid) || {};
        pendingCalls.delete(msg.start.callSid);
        logger.setCallInfo({ ...callInfo, streamSid });
        break;
      }

      case 'media':
        if (elWs.readyState === WebSocket.OPEN) {
          elWs.send(JSON.stringify({ user_audio_chunk: msg.media.payload }));
        }
        break;

      case 'stop':
        console.log('📵 Call ended by Twilio');
        logger.endCall().catch((e) => console.error('endCall error:', e));
        elWs.close();
        break;
    }
  });

  // ── ElevenLabs → Twilio ───────────────────────────────────────────────────

  elWs.on('message', async (raw) => {
    const msg = JSON.parse(raw);

    switch (msg.type) {
      case 'conversation_initiation_metadata':
        console.log('🎙️  Agent ready:', JSON.stringify(msg));
        logger.setConversationId(msg.conversation_initiation_metadata_event?.conversation_id);
        break;

      case 'ping':
        break;

      case 'agent_response_correction':
        console.log(`✏️   Corrected: ${msg.agent_response_correction_event?.corrected_agent_response ?? ''}`);
        break;

      case 'audio':
        if (twilioWs.readyState === WebSocket.OPEN) {
          twilioWs.send(JSON.stringify({
            event:     'media',
            streamSid,
            media:     { payload: msg.audio_event.audio_base_64 },
          }));
        }
        break;

      case 'interruption':
        if (twilioWs.readyState === WebSocket.OPEN) {
          twilioWs.send(JSON.stringify({ event: 'clear', streamSid }));
        }
        break;

      case 'agent_response': {
        const agentText = msg.agent_response_event?.agent_response ?? '';
        console.log(`🤖  Agent : ${agentText}`);
        logger.logTranscript('agent', agentText);
        break;
      }

      case 'user_transcript': {
        const userText = msg.user_transcription_event?.user_transcript ?? '';
        console.log(`👤  Caller: ${userText}`);
        logger.logTranscript('user', userText);
        break;
      }

      case 'client_tool_call': {
        const { tool_call_id, tool_name, parameters } = msg.client_tool_call;
        console.log(`\n🔧  Tool  : ${tool_name}(${JSON.stringify(parameters)})`);
        try {
          const t0      = Date.now();
          const result  = await handleToolCall(tool_name, parameters);
          const latency = Date.now() - t0;
          console.log(`📋  Result: ${JSON.stringify(result).slice(0, 120)}…\n`);
          logger.logToolCall(tool_name, parameters, result, latency);
          elWs.send(JSON.stringify({
            type: 'client_tool_result', tool_call_id,
            result: JSON.stringify(result), is_error: false,
          }));
        } catch (err) {
          console.error(`Tool ${tool_name} threw:`, err.message);
          logger.logError(`tool_${tool_name}`, err);
          elWs.send(JSON.stringify({
            type: 'client_tool_result', tool_call_id,
            result: JSON.stringify({ error: 'An internal error occurred. Please try again.' }),
            is_error: true,
          }));
        }
        break;
      }

      default:
        console.log('⚠️  Unhandled ElevenLabs msg:', JSON.stringify(msg).slice(0, 200));
        break;
    }
  });

  // ── Cleanup ───────────────────────────────────────────────────────────────

  twilioWs.on('close', () => {
    activeSessions.delete(twilioWs);
    logger.endCall().catch((e) => console.error('endCall error:', e));
    if (elWs.readyState !== WebSocket.CLOSED) elWs.close();
  });

  // Task 3.3 — ElevenLabs drop recovery:
  // If ElevenLabs closes unexpectedly mid-call, inject a TwiML apology via the
  // Twilio REST API so the caller hears something instead of silence.
  elWs.on('close', async (code, reason) => {
    const reasonStr    = reason.toString() || '(none)';
    const isUnexpected = code !== 1000 && code !== 1001;
    console.log(`🔌 ElevenLabs disconnected — code: ${code}, reason: ${reasonStr}`);

    if (isUnexpected) {
      logger.logError('elevenlabs_ws', { code, reason: reasonStr });
    }

    logger.endCall().catch((e) => console.error('endCall error:', e));

    if (isUnexpected && twilioWs.readyState === WebSocket.OPEN && callSid) {
      try {
        const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
        await twilioClient.calls(callSid).update({
          twiml: `<Response><Say voice="Polly.Joanna">I'm sorry, I'm having a technical difficulty. Please call back in a moment and we'll be happy to help you.</Say><Hangup/></Response>`,
        });
      } catch (e) {
        console.error('Failed to inject TwiML fallback:', e.message);
      }
    }

    if (twilioWs.readyState !== WebSocket.CLOSED) twilioWs.close();
  });

  twilioWs.on('error', (err) => {
    console.error('Twilio WS error:', err.message);
    logger.logError('twilio_ws', err);
  });

  elWs.on('error', (err) => {
    console.error('ElevenLabs error:', err.message);
    logger.logError('elevenlabs_ws', err);
  });
});

// ─── System prompt ────────────────────────────────────────────────────────────

function buildSystemPrompt() {
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
  const pol = restaurant.reservation_policy;
  const pay = restaurant.payment;

  return `You are a friendly and professional reservations assistant for ${restaurant.name}, ${restaurant.tagline}.

About the restaurant:
${restaurant.description}

Address: ${restaurant.address}
Phone: ${restaurant.phone}
Email: ${restaurant.email}

Hours:
${Object.entries(restaurant.hours).map(([d, h]) => `  ${d.charAt(0).toUpperCase() + d.slice(1)}: ${h.open}–${h.close} (kitchen closes ${h.kitchen_close})`).join('\n')}

Key facts you must know and state accurately — never guess these:
- Reservations are FREE for parties of 1–${pol.deposit_required_party_size - 1}. A $${pol.deposit_amount_per_person}/person deposit (credited to the bill) is required for parties of ${pol.deposit_required_party_size}+.
- Auto-gratuity of ${pay.auto_gratuity.percentage}% is added for parties of ${pay.auto_gratuity.applies_to_party_size}+. For smaller parties gratuity is at the guest's discretion.
- We are fully wheelchair accessible — step-free entrance, accessible restrooms and tables.
- We have high chairs and booster seats for children.
- Bar seating has ${restaurant.bar.seat_count} seats, is walk-in only (not reservable), and the full menu is available at the bar.
- Happy hour is Mon–Fri ${restaurant.happy_hour.start}–${restaurant.happy_hour.end} at the bar only.
- We do not have outdoor seating.
- Service animals are always welcome. Pets are not permitted.
- For lost and found, feedback, complaints, private event inquiries, farm/supplier questions, or anything else you cannot fully resolve, offer to take a message so management can call them back. Do NOT just redirect them to ring the main line — collect their name, phone number, and details using the leave_message tool.

Your tools:
- get_restaurant_info(topic) — use for detailed questions about parking, accessibility, seating, payment, kids, allergens, private dining, special occasions, corkage, ambiance, holiday hours, or sourcing
- get_menu(section) — use for food and drink questions
- check_availability(date, time, party_size) — always call this before booking
- book_reservation(...) — call after confirming availability
- cancel_reservation(confirmation_code, customer_phone) — use when a caller wants to cancel; verify their code and phone first, then confirm details before cancelling
- leave_message(caller_name, caller_phone, subject, message) — use when someone has feedback, a complaint, a lost item, a private event inquiry, or any request that needs management follow-up. Always get their name and number first.

Guidelines:
- Be warm, concise, and conversational — this is a phone call
- When checking availability or booking, always confirm the details back to the caller
- If a slot is not available, proactively suggest the nearest alternatives
- Always clarify the full date (day, month, year) to avoid confusion
- Today's date is ${today}
- Always use tools to look up information — never guess or make up facts
- After a successful booking, read the confirmation code clearly, one letter or digit at a time
- Keep responses brief and natural for voice — no bullet points, no markdown`;
}

// ─── Postgres LISTEN/NOTIFY (Task 1.6 / Task 4.1) ────────────────────────────
// notifyClient is module-scoped so shutdown() can close it cleanly, preventing
// the "SSL error: unexpected eof" that appears in Postgres logs on hard exit.

let notifyClient = null;

async function startNotificationListener() {
  notifyClient = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  });
  await notifyClient.connect();
  await notifyClient.query('LISTEN new_reservation');
  await notifyClient.query('LISTEN reminder_due');

  notifyClient.on('notification', async (msg) => {
    const payload = JSON.parse(msg.payload);
    try {
      if (msg.channel === 'new_reservation') {
        await sendSmsConfirmation(payload);
        console.log('📱 SMS confirmation sent:', payload.id);
      }
      if (msg.channel === 'reminder_due') {
        await sendSmsReminder(payload);
        console.log('📱 SMS reminder sent:', payload.id);
      }
    } catch (err) {
      console.error(`SMS error (${msg.channel}):`, err.message);
    }
  });

  notifyClient.on('error', (err) => {
    console.error('Notification listener error — reconnecting in 5s:', err.message);
    notifyClient = null;
    setTimeout(startNotificationListener, 5_000);
  });
}

// ─── Graceful shutdown (Task 3.2) ─────────────────────────────────────────────
// Railway sends SIGTERM before stopping or redeploying. We drain active calls
// (up to 45s) before closing the DB pool and exiting cleanly.

async function shutdown(signal) {
  console.log(`\n${signal} received — draining ${activeSessions.size} active call(s)…`);
  server.close();

  const deadline = setTimeout(() => {
    console.warn('Drain deadline reached — force-closing remaining sessions');
    for (const ws of activeSessions) ws.close();
  }, 45_000);

  await new Promise((resolve) => {
    const check = setInterval(() => {
      if (activeSessions.size === 0) { clearInterval(check); resolve(); }
    }, 500);
  });

  clearTimeout(deadline);
  // Close the LISTEN client first so Postgres sees a clean disconnect
  if (notifyClient) {
    try { await notifyClient.end(); } catch (_) {}
  }
  await pool.end();
  console.log('Shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// ─── Start ────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  ${restaurant.name} — Voice Server`);
  console.log(`  Listening on port ${PORT}`);
  console.log(`  POST /incoming-call  ← point Twilio webhook here`);
  console.log(`  GET  /health`);
  console.log(`  WS   /media-stream  ← Twilio Media Streams`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  if (process.env.DATABASE_URL) {
    startNotificationListener().catch((err) =>
      console.error('Failed to start notification listener:', err.message),
    );
  }
});
