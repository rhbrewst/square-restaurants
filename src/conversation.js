/**
 * conversation.js
 * Text-based REPL for testing Claude + tools before adding the voice layer.
 * Run with:  node src/conversation.js
 */

require('dotenv').config({ override: true });
const readline  = require('readline');
const Anthropic = require('@anthropic-ai/sdk');

const { TOOL_DEFINITIONS, handleToolCall } = require('./tools');
const restaurant = require('../config/restaurant.json');

const client = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are a friendly and professional reservations assistant for ${restaurant.name}, ${restaurant.tagline}.

About the restaurant:
${restaurant.description}

Address: ${restaurant.address}
Phone: ${restaurant.phone}

Your job is to:
1. Answer questions about the menu, hours, location, and policies
2. Check table availability for requested dates and times
3. Book reservations when the caller is ready

Guidelines:
- Be warm, concise, and conversational — this will eventually be a phone call
- When checking availability or booking, always confirm the details back to the caller
- If a slot isn't available, proactively suggest alternatives
- For the date, always clarify the full date (day, month, year) to avoid confusion
- Today's date is ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
- Always use the tools to check real availability — never guess
- After a successful booking, read out the confirmation code clearly`;

// ─────────────────────────────────────────
// Agentic loop: send message, handle tools, repeat
// ─────────────────────────────────────────

async function sendMessage(messages) {
  let response = await client.messages.create({
    model:      'claude-sonnet-4-5',
    max_tokens: 1024,
    system:     SYSTEM_PROMPT,
    tools:      TOOL_DEFINITIONS,
    messages,
  });

  // Keep processing until Claude stops using tools
  while (response.stop_reason === 'tool_use') {
    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');

    // Build tool results
    const toolResults = toolUseBlocks.map(block => {
      console.log(`\n  🔧 Tool call: ${block.name}(${JSON.stringify(block.input)})`);
      const result = handleToolCall(block.name, block.input);
      console.log(`  📋 Result:    ${JSON.stringify(result).slice(0, 120)}…`);
      return {
        type:       'tool_result',
        tool_use_id: block.id,
        content:    JSON.stringify(result),
      };
    });

    // Append assistant turn + tool results, then call again
    messages = [
      ...messages,
      { role: 'assistant', content: response.content },
      { role: 'user',      content: toolResults },
    ];

    response = await client.messages.create({
      model:      'claude-sonnet-4-5',
      max_tokens: 1024,
      system:     SYSTEM_PROMPT,
      tools:      TOOL_DEFINITIONS,
      messages,
    });
  }

  // Extract final text reply
  const textBlock = response.content.find(b => b.type === 'text');
  return { reply: textBlock?.text ?? '(no text response)', messages };
}

// ─────────────────────────────────────────
// REPL
// ─────────────────────────────────────────

async function main() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  ${restaurant.name} — Voice Agent (Text Mode)`);
  console.log('  Type your message and press Enter.');
  console.log('  Type "exit" to quit.');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let messages = [];

  // Opening greeting
  const { reply, messages: updated } = await sendMessage([
    { role: 'user', content: 'Hello, I just called the restaurant.' },
  ]);
  messages = updated;
  messages.push({ role: 'assistant', content: reply });
  console.log(`\n🍽️  ${restaurant.name}: ${reply}\n`);

  const ask = () => {
    rl.question('You: ', async (input) => {
      const trimmed = input.trim();
      if (!trimmed) return ask();
      if (trimmed.toLowerCase() === 'exit') {
        console.log('\nGoodbye!\n');
        rl.close();
        return;
      }

      try {
        messages.push({ role: 'user', content: trimmed });
        const { reply, messages: updated } = await sendMessage(messages);
        messages = updated;
        messages.push({ role: 'assistant', content: reply });
        console.log(`\n🍽️  ${restaurant.name}: ${reply}\n`);
      } catch (err) {
        console.error('\n❌ Error:', err.message, '\n');
      }

      ask();
    });
  };

  ask();
}

main().catch(console.error);
