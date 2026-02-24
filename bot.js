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
const RESPONSE_TIMEOUT_MS = 120_000; // 2 minutes max per response
const THROTTLE_MS = 1200;

if (!BOT_TOKEN) throw new Error('Missing TELEGRAM_BOT_TOKEN in .env');
if (!ALLOWED_USER_ID) throw new Error('Missing TELEGRAM_ALLOWED_USER_ID in .env');

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
let isBusy = false; // concurrency lock — one Claude response at a time

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
  if (isBusy) {
    await ctx.reply('Claude is still responding. Please wait...');
    return;
  }
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
  if (isBusy) {
    await ctx.reply('Claude is still responding, please wait...');
    return;
  }

  isBusy = true;
  let sentMsg;

  try {
    sentMsg = await ctx.reply('...');
  } catch (e) {
    console.error('[bot] Failed to send placeholder:', e.message);
    isBusy = false;
    return;
  }

  let fullText = '';
  let lastEditAt = 0;
  let proc = null;
  let timeoutHandle = null;

  async function editMessage(text) {
    const safe = text.length > 4000
      ? text.slice(0, 4000) + '\n\n[truncated — response exceeded 4000 chars]'
      : text;
    await bot.telegram
      .editMessageText(ctx.chat.id, sentMsg.message_id, undefined, safe)
      .catch((e) => {
        if (e.description !== 'Bad Request: message is not modified') {
          console.error('[edit error]', e.description);
        }
      });
  }

  const args = [
    '-p', prompt,
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--session-id', sessionId,
    '--dangerously-skip-permissions',
  ];

  proc = spawn(CLAUDE_BIN, args, { cwd: CWD });

  // Kill if Claude doesn't finish within timeout
  timeoutHandle = setTimeout(() => {
    console.error('[bot] Claude response timed out, killing process');
    proc.kill();
    editMessage('(response timed out after 2 minutes)').catch(() => {});
    isBusy = false;
  }, RESPONSE_TIMEOUT_MS);

  let stdoutBuffer = '';

  proc.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString();
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop();

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        handleStreamEvent(event);
      } catch {
        // ignore non-JSON lines
      }
    }
  });

  function handleStreamEvent(event) {
    if (event.type === 'assistant' && event.message?.content) {
      const text = event.message.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');

      if (text && text !== fullText) {
        fullText = text;
        const now = Date.now();
        if (now - lastEditAt > THROTTLE_MS) {
          lastEditAt = now;
          editMessage(fullText);
        }
      }
    }
  }

  proc.stderr.on('data', (data) => {
    console.error('[claude stderr]', data.toString().trim());
  });

  proc.on('close', async (code) => {
    clearTimeout(timeoutHandle);
    isBusy = false;
    console.log(`[claude] exited with code ${code}`);
    const finalText = fullText || '(no response)';
    if (!fullText) {
      console.error('[bot] Claude produced no output. Exit code:', code);
    }
    await editMessage(finalText);
  });
}

bot.launch();
console.log(`[bot] Started. Listening for user ${ALLOWED_USER_ID}`);

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
