# Square Restaurants — Voice AI Reservation Agent

A voice AI prototype that lets customers call a phone number, ask questions about a restaurant, and book reservations. Powered by Twilio (telephony), ElevenLabs (voice), and Anthropic Claude (conversational brain).

---

## Getting Started

### Accounts You Need to Create

Work through these in order. Each takes 5–10 minutes. You only need free tiers for local development.

---

#### 1. Anthropic (Claude API)

**Sign up:** https://console.anthropic.com/login

**What to grab:**
- **API Key** — after logging in, go to **Settings → API Keys → Create Key**. Copy the value immediately; it won't be shown again.

**Free tier:** New accounts get a small credit. No credit card required to start.

---

#### 2. Twilio

**Sign up:** https://www.twilio.com/try-twilio

**What to grab once inside the Console (https://console.twilio.com):**
- **Account SID** — shown on the main dashboard, starts with `AC`
- **Auth Token** — shown on the main dashboard (click the eye icon to reveal)
- **Phone Number** — go to **Phone Numbers → Manage → Buy a Number**, search for a US number with Voice capability, buy it (~$1/month, covered by free trial credit)

**Free tier:** Trial accounts get ~$15 credit. You'll need to verify your personal phone number during signup.

---

#### 3. ElevenLabs

**Sign up:** https://elevenlabs.io/sign-up

**What to grab:**
- **API Key** — go to **Profile → API Keys → Create API Key**
- **Agent ID** — go to **Conversational AI → Agents → Create an Agent**, set it up with a voice and a basic system prompt (we'll refine this later), then copy the Agent ID from the agent's settings page

**Free tier:** Free plan includes 10,000 characters/month and access to Conversational AI.

---

#### 4. ngrok (local tunnel for dev)

**Sign up:** https://dashboard.ngrok.com/signup

**What to grab:**
- **Auth Token** — after logging in, go to **Your Authtoken** in the left sidebar, copy the token

**Install ngrok locally:**
```bash
# macOS (Homebrew)
brew install ngrok

# Or download directly: https://ngrok.com/download
```

**Connect your token:**
```bash
ngrok config add-authtoken YOUR_TOKEN_HERE
```

**Free tier:** Free plan supports one static URL per session, which is enough for development.

---

### Environment Variables

Copy `.env.example` to `.env` and fill in your credentials:

```bash
cp .env.example .env
```

Then open `.env` and paste in each key from the accounts above.

---

## Project Structure

```
Square-Restaurants/
├── src/                  # Application code (server, handlers, tools)
├── config/               # Restaurant JSON config (name, hours, menu, policies)
├── data/                 # Mock reservation store (gitignored — runtime only)
├── .env                  # Your real credentials (never commit this)
├── .env.example          # Credential template (safe to commit)
├── .gitignore
├── package.json
└── README.md
```

---

## Build Phases

| Phase | What gets built | Status |
|-------|----------------|--------|
| 1 | Environment setup, folder structure, accounts | ✅ Done |
| 2 | Mock data — `restaurant.json`, `reservations.json` | ✅ Done |
| 3 | Claude tool use — availability, booking, menu (text loop) | ✅ Done |
| 4 | Voice layer — ElevenLabs + Twilio Media Streams | ✅ Done |
| 5 | Deployment — Railway/Render, production webhook | Pending |

---

## Testing Each Phase

### Phase 3 — Text conversation loop
```bash
node src/conversation.js
```

### Phase 4 — Voice via ngrok

#### One-time: configure ElevenLabs Agent

In your [ElevenLabs Agent settings](https://elevenlabs.io/app/conversational-ai):

1. **LLM** — set to Claude (claude-sonnet-4-5 or newer)
2. **Tools** — add three tools with type **Client** (handled by your server over WebSocket):

| Tool name | Parameters |
|-----------|-----------|
| `get_menu` | `section` (string, enum: starters/mains/sides/desserts/drinks/all) |
| `check_availability` | `date` (string YYYY-MM-DD), `time` (string HH:MM), `party_size` (integer) |
| `book_reservation` | `date`, `time`, `party_size`, `customer_name`, `customer_phone`, `special_requests` (optional) |

The system prompt and opening message are injected at runtime — no need to set them in the dashboard.

#### Run it

```bash
# Terminal 1: start the voice server
node src/server.js

# Terminal 2: expose it with ngrok
ngrok http 3000
```

Copy the ngrok HTTPS URL (e.g. `https://abc123.ngrok.io`) and set it as the **Voice webhook** on your Twilio phone number:

- Go to [Twilio Console → Phone Numbers → Manage → your number](https://console.twilio.com)
- Under **Voice Configuration → A call comes in**, paste: `https://abc123.ngrok.io/incoming-call`
- Method: **HTTP POST**
- Save

Then call your Twilio number. Watch the terminal for live transcripts and tool calls.

### Phase 5 — Production
Deploy to Railway or Render and update the Twilio webhook to the production URL.
