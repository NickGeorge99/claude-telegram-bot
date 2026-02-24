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
  if (ctx.message.text.startsWith('/')) return; // commands have their own handlers
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
    '--output-format', 'json',
    '--session-id', sessionId,
    '--dangerously-skip-permissions',
  ];

  // Strip CLAUDECODE so claude doesn't refuse to run inside another Claude session
  const spawnEnv = { ...process.env };
  delete spawnEnv.CLAUDECODE;

  proc = spawn(CLAUDE_BIN, args, { cwd: CWD, env: spawnEnv });

  // Kill if Claude doesn't finish within timeout
  timeoutHandle = setTimeout(() => {
    console.error('[bot] Claude response timed out, killing process');
    proc.kill();
    editMessage('(response timed out after 2 minutes)').catch(() => {});
    isBusy = false;
  }, RESPONSE_TIMEOUT_MS);

  const stdoutChunks = [];

  proc.stdout.on('data', (chunk) => {
    stdoutChunks.push(chunk);
  });

  proc.stderr.on('data', (data) => {
    console.error('[claude stderr]', data.toString().trim());
  });

  proc.on('close', async (code) => {
    clearTimeout(timeoutHandle);
    isBusy = false;
    console.log(`[claude] exited with code ${code}`);

    const raw = Buffer.concat(stdoutChunks).toString().trim();
    try {
      const parsed = JSON.parse(raw);
      const result = parsed.result || '(no response)';
      await editMessage(result);
    } catch {
      console.error('[bot] Failed to parse JSON response:', raw.slice(0, 200));
      await editMessage('(error reading response)');
    }
  });
}

bot.launch();
console.log(`[bot] Started. Listening for user ${ALLOWED_USER_ID}`);

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
