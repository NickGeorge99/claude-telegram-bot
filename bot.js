import { Telegraf } from 'telegraf';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import dotenv from 'dotenv';

dotenv.config();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_USER_ID = parseInt(process.env.TELEGRAM_ALLOWED_USER_ID, 10);
const CLAUDE_BIN = resolve(process.env.HOME, '.local/bin/claude');
const CWD = process.env.HOME;
const SESSION_FILE = './session-id.txt';

if (!BOT_TOKEN) throw new Error('Missing TELEGRAM_BOT_TOKEN in .env');
if (!ALLOWED_USER_ID) throw new Error('Missing TELEGRAM_ALLOWED_USER_ID in .env');

// Persist session ID across restarts
function loadSessionId() {
  if (existsSync(SESSION_FILE)) {
    return readFileSync(SESSION_FILE, 'utf8').trim();
  }
  const id = randomUUID();
  writeFileSync(SESSION_FILE, id);
  return id;
}

function saveSessionId(id) {
  writeFileSync(SESSION_FILE, id);
}

let sessionId = loadSessionId();

const bot = new Telegraf(BOT_TOKEN);

// Auth guard — silently ignore all other users
bot.use((ctx, next) => {
  if (ctx.from?.id !== ALLOWED_USER_ID) {
    console.log(`Rejected user: ${ctx.from?.id}`);
    return;
  }
  return next();
});

bot.command('start', (ctx) => {
  ctx.reply(
    `Claude Code bot is live.\n\nCommands:\n/reset — fresh context\n/compact — compress history\n\nSession: ${sessionId}`
  );
});

bot.command('reset', async (ctx) => {
  sessionId = randomUUID();
  saveSessionId(sessionId);
  await ctx.reply('Session reset. Fresh context started.');
});

bot.command('compact', async (ctx) => {
  await sendToClaude(ctx, '/compact');
});

bot.on('text', async (ctx) => {
  await sendToClaude(ctx, ctx.message.text);
});

async function sendToClaude(ctx, prompt) {
  // Send placeholder immediately so user knows we received it
  const sentMsg = await ctx.reply('...');

  let fullText = '';
  let lastEditAt = 0;
  const THROTTLE_MS = 1200; // edit at most once per 1.2s to stay under Telegram rate limits

  const args = [
    '-p', prompt,
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--session-id', sessionId,
    '--dangerously-skip-permissions',
  ];

  const proc = spawn(CLAUDE_BIN, args, { cwd: CWD });

  let stdoutBuffer = '';

  proc.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString();
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop(); // hold back incomplete line

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        handleStreamEvent(event);
      } catch {
        // ignore non-JSON lines (e.g. debug output)
      }
    }
  });

  function handleStreamEvent(event) {
    if (event.type === 'assistant' && event.message?.content) {
      // Concatenate all text blocks in this message
      const text = event.message.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');

      if (text && text !== fullText) {
        fullText = text;
        const now = Date.now();
        if (now - lastEditAt > THROTTLE_MS) {
          lastEditAt = now;
          editMessage(fullText).catch(() => {});
        }
      }
    }
  }

  proc.stderr.on('data', (data) => {
    console.error('[claude stderr]', data.toString());
  });

  proc.on('close', async (code) => {
    console.log(`[claude] exited with code ${code}`);
    const finalText = fullText || '(no response)';
    // Always do a final edit to show complete response
    await editMessage(finalText).catch(() => {});
  });

  async function editMessage(text) {
    // Telegram message limit is 4096 chars — truncate with notice if needed
    const safe = text.length > 4000
      ? text.slice(0, 4000) + '\n\n[truncated — response exceeded 4000 chars]'
      : text;
    await bot.telegram.editMessageText(ctx.chat.id, sentMsg.message_id, undefined, safe);
  }
}

bot.launch();
console.log(`[bot] Started. Listening for user ${ALLOWED_USER_ID}`);

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
