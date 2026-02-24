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
const GO_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours
const SCRIPTS_DIR = resolve(process.env.HOME, 'scripts');
const GO_SYSTEM_PROMPT = `You are running as an autonomous Claude Code agent. You have full tool access including bash, file read/write, and subagents. You also have access to a telegram-notify command in your PATH — use it to send progress updates to the user at meaningful milestones (not every step). Example: telegram-notify "Finished scaffolding the dashboard". When you finish your task, use telegram-notify to send a brief summary of what you did. If you are about to hit your turn limit and cannot finish, use telegram-notify to tell the user where you left off.`;

if (!BOT_TOKEN) throw new Error('Missing TELEGRAM_BOT_TOKEN in .env');
if (!ALLOWED_USER_ID) throw new Error('Missing TELEGRAM_ALLOWED_USER_ID in .env');

// sessionId starts null — first message creates a real session, then we --resume it
let sessionId = existsSync(SESSION_FILE) ? readFileSync(SESSION_FILE, 'utf8').trim() || null : null;
let isBusy = false;
let goProc = null;
let goTimeoutHandle = null;

const bot = new Telegraf(BOT_TOKEN);

bot.use((ctx, next) => {
  if (ctx.from?.id !== ALLOWED_USER_ID) return;
  return next();
});

bot.command('start', (ctx) => {
  ctx.reply(`Claude Code bot is live.\n\nCommands:\n/reset — fresh context\n/compact — compress history\n/go <task> — run autonomous task in background\n/go <turns> <task> — same with custom turn limit (default: 20)\n/stop — cancel running /go task\n\nStatus: ${sessionId ? 'active session' : 'no session yet'}${goProc ? ' | go task running' : ''}`);
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

bot.command('go', async (ctx) => {
  if (goProc) {
    await ctx.reply('Already running a task. Use /stop to cancel first.');
    return;
  }

  // Parse: /go [N] <task> where N is optional max turns
  const rawInput = ctx.message.text.replace(/^\/go\s*/, '').trim();
  const turnMatch = rawInput.match(/^(\d+)\s+(.+)$/s);
  let maxTurns = 20;
  let taskText;

  if (turnMatch) {
    maxTurns = parseInt(turnMatch[1], 10);
    taskText = turnMatch[2].trim();
  } else {
    taskText = rawInput;
  }

  if (!taskText) {
    await ctx.reply('Usage:\n/go <task>\n/go <max_turns> <task>\n\nExample:\n/go Build a dashboard for subagent tasks\n/go 50 Build a dashboard for subagent tasks');
    return;
  }

  const fullPrompt = `${GO_SYSTEM_PROMPT}\n\nTask: ${taskText}`;

  const args = [
    '-p', fullPrompt,
    '--output-format', 'json',
    '--dangerously-skip-permissions',
    '--max-turns', String(maxTurns),
  ];

  const spawnEnv = { ...process.env };
  delete spawnEnv.CLAUDECODE;
  spawnEnv.PATH = `${SCRIPTS_DIR}:${spawnEnv.PATH || '/usr/bin:/bin'}`;

  await ctx.reply(`On it (max ${maxTurns} turns). I'll update you as I go.\n\nTask: ${taskText}`);

  goProc = spawn(CLAUDE_BIN, args, {
    cwd: CWD,
    env: spawnEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  goTimeoutHandle = setTimeout(async () => {
    if (goProc) {
      console.error('[go] 2-hour timeout — killing');
      try { goProc.kill(); } catch (e) { console.error('[go] kill failed:', e.message); }
      goProc = null;
      goTimeoutHandle = null;
      await bot.telegram.sendMessage(ctx.chat.id, 'Task timed out after 2 hours and was stopped.');
    }
  }, GO_TIMEOUT_MS);

  const chunks = [];
  goProc.stdout.on('data', (d) => chunks.push(d));
  goProc.stderr.on('data', (d) => console.error('[go stderr]', d.toString().trim()));

  goProc.on('close', async (code) => {
    clearTimeout(goTimeoutHandle);
    goTimeoutHandle = null;
    const hadProc = goProc !== null;
    goProc = null;

    if (!hadProc) return; // was killed by /stop, already notified

    try {
      const rawOutput = Buffer.concat(chunks).toString().trim();
      console.log('[go] exit code:', code, 'output length:', rawOutput.length);

      if (code !== 0) {
        await bot.telegram.sendMessage(ctx.chat.id, `Task ended with an error (exit ${code}). Check ~/Projects/claude-telegram-bot/bot.log.`);
        return;
      }

      const parsed = JSON.parse(rawOutput);
      if (parsed.result && /turn limit|max.?turns|maximum turns/i.test(parsed.result)) {
        await bot.telegram.sendMessage(ctx.chat.id, `Hit the ${maxTurns}-turn limit. Use /go to continue if needed.`);
      }
    } catch (e) {
      console.error('[go] close handler error:', e.message);
      bot.telegram.sendMessage(ctx.chat.id, 'Internal error finishing task.').catch(() => {});
    }
  });
});

bot.command('stop', async (ctx) => {
  if (!goProc) {
    await ctx.reply('No task is currently running.');
    return;
  }
  clearTimeout(goTimeoutHandle);
  goTimeoutHandle = null;
  try { goProc.kill(); } catch (e) { console.error('[stop] kill failed:', e.message); }
  goProc = null;
  await ctx.reply('Task stopped.');
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
    console.log('[bot] exit:', code, 'output length:', raw.length);

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
