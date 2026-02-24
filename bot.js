import { Telegraf } from 'telegraf';
import { spawn } from 'child_process';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import dotenv from 'dotenv';

dotenv.config();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_USER_ID = parseInt(process.env.TELEGRAM_ALLOWED_USER_ID, 10);
const CLAUDE_BIN = resolve(process.env.HOME, '.local/bin/claude');
const CWD = process.env.HOME;
const SESSION_FILE = './session-id.txt';
const RESPONSE_TIMEOUT_MS = 120_000;

if (!BOT_TOKEN) throw new Error('Missing TELEGRAM_BOT_TOKEN in .env');
if (!ALLOWED_USER_ID) throw new Error('Missing TELEGRAM_ALLOWED_USER_ID in .env');

// sessionId starts null — first message creates a real session, then we --resume it
let sessionId = existsSync(SESSION_FILE) ? readFileSync(SESSION_FILE, 'utf8').trim() || null : null;
let isBusy = false;

const bot = new Telegraf(BOT_TOKEN);

bot.use((ctx, next) => {
  if (ctx.from?.id !== ALLOWED_USER_ID) return;
  return next();
});

bot.command('start', (ctx) => {
  ctx.reply(`Claude Code bot is live.\n\nCommands:\n/reset — fresh context\n/compact — compress history\n\nSession: ${sessionId || 'none'}`);
});

bot.command('reset', async (ctx) => {
  if (isBusy) { await ctx.reply('Claude is still responding. Please wait...'); return; }
  sessionId = null;
  writeFileSync(SESSION_FILE, '');
  await ctx.reply('Session reset. Fresh context started.');
});

bot.command('compact', async (ctx) => {
  await sendToClaude(ctx, '/compact');
});

bot.on('text', async (ctx) => {
  if (ctx.message.text.startsWith('/')) return;
  await sendToClaude(ctx, ctx.message.text);
});

async function sendToClaude(ctx, prompt) {
  if (isBusy) { await ctx.reply('Claude is still responding, please wait...'); return; }

  isBusy = true;
  let sentMsg;
  try {
    sentMsg = await ctx.reply('...');
  } catch (e) {
    console.error('[bot] placeholder failed:', e.message);
    isBusy = false;
    return;
  }

  async function editMessage(text) {
    const safe = text.length > 4000 ? text.slice(0, 4000) + '\n\n[truncated]' : text;
    await bot.telegram.editMessageText(ctx.chat.id, sentMsg.message_id, undefined, safe)
      .catch((e) => { if (e.description !== 'Bad Request: message is not modified') console.error('[edit]', e.description); });
  }

  // First message: no session flag (Claude creates one)
  // Subsequent messages: --resume with real session ID from previous response
  const args = ['-p', prompt, '--output-format', 'json', '--dangerously-skip-permissions'];
  if (sessionId) args.push('--resume', sessionId);

  console.log('[bot] args:', args.join(' '));

  const spawnEnv = { ...process.env };
  delete spawnEnv.CLAUDECODE;

  const proc = spawn(CLAUDE_BIN, args, { cwd: CWD, env: spawnEnv, stdio: ['ignore', 'pipe', 'pipe'] });

  const timeoutHandle = setTimeout(() => {
    console.error('[bot] timeout — killing claude');
    proc.kill();
    editMessage('(timed out after 2 minutes)').catch(() => {});
    isBusy = false;
  }, RESPONSE_TIMEOUT_MS);

  const chunks = [];
  proc.stdout.on('data', (d) => chunks.push(d));
  proc.stderr.on('data', (d) => console.error('[stderr]', d.toString().trim()));

  proc.on('close', async (code) => {
    clearTimeout(timeoutHandle);
    isBusy = false;
    const raw = Buffer.concat(chunks).toString().trim();
    console.log('[bot] exit:', code, 'raw:', raw.slice(0, 300));

    try {
      const parsed = JSON.parse(raw);
      // Save real session ID for next message
      if (parsed.session_id) {
        sessionId = parsed.session_id;
        writeFileSync(SESSION_FILE, sessionId);
        console.log('[bot] session:', sessionId);
      }
      await editMessage(parsed.result || '(no response)');
    } catch {
      console.error('[bot] bad JSON:', raw.slice(0, 200));
      await editMessage('(error reading response)');
    }
  });
}

bot.launch();
console.log(`[bot] started, user ${ALLOWED_USER_ID}, session: ${sessionId || 'none'}`);
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
