/**
 * scripts/dev.js
 * Starts the voice server + ngrok, then auto-updates the Twilio webhook.
 * Run with: npm run dev
 */

require('dotenv').config();
const { spawn } = require('child_process');
const twilio = require('twilio');

const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER } = process.env;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function startProcess(cmd, args, label, color) {
  const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  proc.stdout.on('data', (d) => {
    d.toString().split('\n').filter(Boolean).forEach(line => {
      process.stdout.write(`${color}[${label}]\x1b[0m ${line}\n`);
    });
  });

  proc.stderr.on('data', (d) => {
    d.toString().split('\n').filter(Boolean).forEach(line => {
      process.stderr.write(`${color}[${label}]\x1b[0m ${line}\n`);
    });
  });

  proc.on('exit', (code) => {
    console.log(`\n${color}[${label}]\x1b[0m exited (${code}) — shutting down`);
    process.exit(code ?? 1);
  });

  return proc;
}

async function getNgrokUrl(retries = 15, delayMs = 1000) {
  for (let i = 0; i < retries; i++) {
    for (const port of [4040, 4041, 4042]) {
      try {
        const res  = await fetch(`http://localhost:${port}/api/tunnels`);
        const data = await res.json();
        const url  = data.tunnels?.find(t => t.proto === 'https')?.public_url;
        if (url) return url;
      } catch {}
    }
    await new Promise(r => setTimeout(r, delayMs));
  }
  throw new Error('Timed out waiting for ngrok tunnel');
}

async function updateTwilioWebhook(ngrokUrl) {
  const client   = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  const numbers  = await client.incomingPhoneNumbers.list({ phoneNumber: TWILIO_PHONE_NUMBER });
  const num      = numbers[0];
  if (!num) throw new Error(`Phone number ${TWILIO_PHONE_NUMBER} not found in Twilio account`);
  await client.incomingPhoneNumbers(num.sid).update({
    voiceUrl:    `${ngrokUrl}/incoming-call`,
    voiceMethod: 'POST',
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\x1b[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m');
  console.log('\x1b[36m  The Ember Room — Dev Launcher\x1b[0m');
  console.log('\x1b[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m\n');

  // Kill anything already on port 3000 or running ngrok
  spawn('sh', ['-c', 'lsof -ti :3000 | xargs kill -9 2>/dev/null; pkill -f "ngrok http" 2>/dev/null || true'], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 1000));

  // 1. Start voice server
  const server = startProcess('node', ['src/server.js'], 'server', '\x1b[32m');

  // 2. Start ngrok
  const ngrok  = startProcess('ngrok', ['http', '3000', '--log=stdout'], 'ngrok', '\x1b[33m');

  // 3. Wait for ngrok, update Twilio
  console.log('\n⏳ Waiting for ngrok tunnel…');
  try {
    const url = await getNgrokUrl();
    await updateTwilioWebhook(url);
    console.log(`\n\x1b[32m✅ Ready!\x1b[0m`);
    console.log(`   ngrok  : ${url}`);
    console.log(`   webhook: ${url}/incoming-call`);
    console.log(`   number : ${TWILIO_PHONE_NUMBER}`);
    console.log('\n\x1b[36m📞 Call the number above to test.\x1b[0m\n');
  } catch (err) {
    console.error('\n\x1b[31m❌ Setup error:\x1b[0m', err.message);
    process.exit(1);
  }

  // Keep alive — Ctrl+C to stop both
  process.on('SIGINT', () => {
    console.log('\n\nShutting down…');
    server.kill();
    ngrok.kill();
    process.exit(0);
  });
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
