/**
 * conversation.js
 * Text-based REPL for testing Claude + tools without the voice layer.
 * Fetches the Ember Room's location row from DB at startup so the tool
 * handlers behave identically to the phone path.
 *
 * Run with:  node src/conversation.js
 */

require('dotenv').config();
const readline  = require('readline');
const { DateTime } = require('luxon');
const Anthropic = require('@anthropic-ai/sdk');

const { TOOL_DEFINITIONS, handleToolCall } = require('./tools');
const { buildSystemPrompt }                = require('./systemPrompt');
const locationStore                        = require('./locationStore');
const pool                                 = require('./db');

const client = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─────────────────────────────────────────
// Agentic loop: send message, handle tools, repeat
// ─────────────────────────────────────────

async function sendMessage(messages, systemPrompt, location) {
  let response = await client.messages.create({
    model:      'claude-sonnet-4-5',
    max_tokens: 1024,
    system:     systemPrompt,
    tools:      TOOL_DEFINITIONS,
    messages,
  });

  while (response.stop_reason === 'tool_use') {
    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');

    const toolResults = await Promise.all(toolUseBlocks.map(async (block) => {
      console.log(`\n  🔧 Tool call: ${block.name}(${JSON.stringify(block.input)})`);
      const result = await handleToolCall(block.name, block.input, location);
      console.log(`  📋 Result:    ${JSON.stringify(result).slice(0, 120)}…`);
      return {
        type:       'tool_result',
        tool_use_id: block.id,
        content:    JSON.stringify(result),
      };
    }));

    messages = [
      ...messages,
      { role: 'assistant', content: response.content },
      { role: 'user',      content: toolResults },
    ];

    response = await client.messages.create({
      model:      'claude-sonnet-4-5',
      max_tokens: 1024,
      system:     systemPrompt,
      tools:      TOOL_DEFINITIONS,
      messages,
    });
  }

  const textBlock = response.content.find(b => b.type === 'text');
  return { reply: textBlock?.text ?? '(no text response)', messages };
}

// ─────────────────────────────────────────
// REPL
// ─────────────────────────────────────────

async function main() {
  const location = await locationStore.loadById('ember-room');
  if (!location) {
    console.error('No ember-room location found — run scripts/backfill-tenant.js first.');
    process.exit(1);
  }

  const now = DateTime.now().setZone(location.timezone);
  const systemPrompt = buildSystemPrompt(location, now);

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  ${location.name} — Voice Agent (Text Mode)`);
  console.log('  Type your message and press Enter.');
  console.log('  Type "exit" to quit.');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let messages = [];

  const { reply, messages: updated } = await sendMessage([
    { role: 'user', content: 'Hello, I just called the restaurant.' },
  ], systemPrompt, location);
  messages = updated;
  messages.push({ role: 'assistant', content: reply });
  console.log(`\n🍽️  ${location.name}: ${reply}\n`);

  const ask = () => {
    rl.question('You: ', async (input) => {
      const trimmed = input.trim();
      if (!trimmed) return ask();
      if (trimmed.toLowerCase() === 'exit') {
        console.log('\nGoodbye!\n');
        rl.close();
        await pool.end().catch(() => {});
        return;
      }

      try {
        messages.push({ role: 'user', content: trimmed });
        const { reply, messages: updated } = await sendMessage(messages, systemPrompt, location);
        messages = updated;
        messages.push({ role: 'assistant', content: reply });
        console.log(`\n🍽️  ${location.name}: ${reply}\n`);
      } catch (err) {
        console.error('\n❌ Error:', err.message, '\n');
      }

      ask();
    });
  };

  ask();
}

main().catch(console.error);
