require('dotenv').config({ override: true });
const express   = require('express');
const http      = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const twilio    = require('twilio');
const { handleToolCall } = require('./tools');
const restaurant = require('../config/restaurant.json');

const {
  PORT = 3000,
  ELEVENLABS_API_KEY,
  ELEVENLABS_AGENT_ID,
} = process.env;

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ─── Twilio webhook ───────────────────────────────────────────────────────────
// Twilio hits this when someone calls the restaurant number.
// We reply with TwiML that opens a Media Stream back to this server.

app.post('/incoming-call', (req, res) => {
  const twiml   = new twilio.twiml.VoiceResponse();
  const connect = twiml.connect();
  connect.stream({ url: `wss://${req.headers.host}/media-stream` });
  res.type('text/xml').send(twiml.toString());
});

// ─── HTTP + WebSocket server ──────────────────────────────────────────────────

const server = http.createServer(app);
const wss    = new WebSocketServer({ server, path: '/media-stream' });

wss.on('connection', (twilioWs) => {
  console.log('\n📞 Incoming call — connecting to ElevenLabs…');

  let streamSid = null;

  // Open a WebSocket to ElevenLabs Conversational AI
  const elWs = new WebSocket(
    `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${ELEVENLABS_AGENT_ID}`,
    { headers: { 'xi-api-key': ELEVENLABS_API_KEY } },
  );

  elWs.on('open', () => {
    console.log('✅ ElevenLabs connected');

    // Override the agent's system prompt and opening line at runtime
    // so we don't have to re-edit the ElevenLabs dashboard after code changes.
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
      case 'start':
        streamSid = msg.start.streamSid;
        console.log(`📡 Media stream started (${streamSid})`);
        break;

      case 'media':
        // Twilio sends mulaw 8 kHz audio as base64 — forward it directly.
        if (elWs.readyState === WebSocket.OPEN) {
          elWs.send(JSON.stringify({ user_audio_chunk: msg.media.payload }));
        }
        break;

      case 'stop':
        console.log('📵 Call ended by Twilio');
        elWs.close();
        break;
    }
  });

  // ── ElevenLabs → Twilio ───────────────────────────────────────────────────

  elWs.on('message', (raw) => {
    const msg = JSON.parse(raw);

    switch (msg.type) {
      case 'conversation_initiation_metadata':
        console.log('🎙️  Agent ready:', JSON.stringify(msg));
        break;

      case 'ping':
        // Keepalive — no action needed
        break;

      default:
        console.log('⚠️  Unhandled ElevenLabs msg:', JSON.stringify(msg).slice(0, 200));
        break;

      case 'audio':
        // Forward agent speech back to the caller.
        if (twilioWs.readyState === WebSocket.OPEN) {
          twilioWs.send(JSON.stringify({
            event:     'media',
            streamSid,
            media:     { payload: msg.audio_event.audio_base_64 },
          }));
        }
        break;

      case 'interruption':
        // Caller spoke over the agent — clear Twilio's playback buffer immediately.
        if (twilioWs.readyState === WebSocket.OPEN) {
          twilioWs.send(JSON.stringify({ event: 'clear', streamSid }));
        }
        break;

      case 'agent_response':
        console.log(`🤖  Agent : ${msg.agent_response_event?.agent_response ?? ''}`);
        break;

      case 'user_transcript':
        console.log(`👤  Caller: ${msg.user_transcription_event?.user_transcript ?? ''}`);
        break;

      case 'client_tool_call': {
        const { tool_call_id, tool_name, parameters } = msg.client_tool_call;
        console.log(`\n🔧  Tool  : ${tool_name}(${JSON.stringify(parameters)})`);

        const result = handleToolCall(tool_name, parameters);
        console.log(`📋  Result: ${JSON.stringify(result).slice(0, 120)}…\n`);

        elWs.send(JSON.stringify({
          type:         'client_tool_result',
          tool_call_id,
          result:       JSON.stringify(result),
          is_error:     false,
        }));
        break;
      }
    }
  });

  // ── Cleanup ───────────────────────────────────────────────────────────────

  twilioWs.on('close', () => {
    if (elWs.readyState !== WebSocket.CLOSED) elWs.close();
  });

  elWs.on('close', (code, reason) => {
    console.log(`🔌 ElevenLabs disconnected — code: ${code}, reason: ${reason.toString() || '(none)'}`);
    if (twilioWs.readyState !== WebSocket.CLOSED) twilioWs.close();
  });

  twilioWs.on('error', (err) => console.error('Twilio WS error:', err.message));
  elWs.on('error',     (err) => console.error('ElevenLabs error:', err.message));
});

// ─── System prompt ────────────────────────────────────────────────────────────

function buildSystemPrompt() {
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  return `You are a friendly and professional reservations assistant for ${restaurant.name}, ${restaurant.tagline}.

About the restaurant:
${restaurant.description}

Address: ${restaurant.address}
Phone: ${restaurant.phone}

Your job is to:
1. Answer questions about the menu, hours, location, and policies
2. Check table availability for requested dates and times
3. Book reservations when the caller is ready

Guidelines:
- Be warm, concise, and conversational — this is a phone call
- When checking availability or booking, always confirm the details back to the caller
- If a slot is not available, proactively suggest the nearest alternatives
- Always clarify the full date (day, month, year) to avoid confusion
- Today's date is ${today}
- Always use the tools to check real availability — never guess
- After a successful booking, read the confirmation code out clearly, one letter or digit at a time
- Keep responses brief and natural for voice — no bullet points, no markdown`;
}

// ─── Start ────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  ${restaurant.name} — Voice Server`);
  console.log(`  Listening on port ${PORT}`);
  console.log(`  POST /incoming-call  ← point Twilio webhook here`);
  console.log(`  WS   /media-stream  ← Twilio Media Streams`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
});
