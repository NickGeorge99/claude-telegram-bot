# Claude Code Telegram Bot

Chat with a live [Claude Code](https://claude.ai/claude-code) session from your phone via Telegram. Send messages, get responses, and maintain full conversation history — all while away from your Mac.

## What it does

- Bridges Telegram to a real Claude Code CLI session running on your Mac
- Persistent conversation — Claude remembers context across messages
- Full Claude Code capabilities: file access, bash, everything
- Only you can use it (locked to your Telegram user ID)
- Runs as a background service — auto-starts on login, restarts if it crashes

## Requirements

- Mac with [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed (`claude` in your PATH)
- A Claude Max plan (the bot uses your existing Claude Code session)
- Node.js 18+
- A Telegram account

## Setup

### 1. Create a Telegram bot

Message [@BotFather](https://t.me/botfather) on Telegram:
```
/newbot
```
Follow the prompts and copy the token it gives you.

### 2. Get your Telegram user ID

Message [@userinfobot](https://t.me/userinfobot) on Telegram:
```
/start
```
Copy your numeric user ID (e.g. `123456789`).

### 3. Clone and install

```bash
git clone https://github.com/NickGeorge99/claude-telegram-bot.git
cd claude-telegram-bot
npm install
```

### 4. Configure

```bash
cp .env.example .env
```

Edit `.env`:
```
TELEGRAM_BOT_TOKEN=your_token_from_botfather
TELEGRAM_ALLOWED_USER_ID=your_numeric_telegram_user_id
```

### 5. Test it

```bash
npm start
```

Open Telegram, message your bot, and say hello.

### 6. Run as a background service (macOS)

Find your Node path:
```bash
which node
```

Create `~/Library/LaunchAgents/com.claudebot.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.claudebot</string>

    <key>ProgramArguments</key>
    <array>
        <string>/path/to/your/node</string>
        <string>--dns-result-order=ipv4first</string>
        <string>/path/to/claude-telegram-bot/bot.js</string>
    </array>

    <key>WorkingDirectory</key>
    <string>/path/to/claude-telegram-bot</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>/Users/yourusername</string>
        <key>PATH</key>
        <string>/your/node/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>

    <key>StandardOutPath</key>
    <string>/path/to/claude-telegram-bot/bot.log</string>

    <key>StandardErrorPath</key>
    <string>/path/to/claude-telegram-bot/bot.log</string>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>ThrottleInterval</key>
    <integer>10</integer>
</dict>
</plist>
```

Load it:
```bash
launchctl load ~/Library/LaunchAgents/com.claudebot.plist
```

## Commands

| Command | Description |
|---------|-------------|
| `/start` | Show bot status and current session ID |
| `/reset` | Start a fresh conversation (clears context) |
| `/compact` | Compress conversation history to free up context |
| Any message | Sent directly to Claude |

## How it works

Each message spawns `claude -p <prompt> --output-format json` as a subprocess. The bot uses `--resume <session_id>` to maintain conversation continuity across messages. The session ID is extracted from Claude's JSON response and persisted to disk, so conversation survives bot restarts.

The `CLAUDECODE` environment variable is stripped before spawning to avoid Claude refusing to run inside another Claude session.

## Usage & billing

The bot uses your existing Claude Code installation and Max plan. Each message counts against your normal Claude Code usage — no additional API costs.

## Troubleshooting

**Bot connects but Claude hangs with no response**
- Make sure `claude` is in your PATH and works in your terminal
- Check logs: `tail -f bot.log`

**ETIMEDOUT connecting to Telegram**
- Run node with `--dns-result-order=ipv4first` (already in `npm start`)

**"Claude Code cannot be launched inside another Claude Code session"**
- This is handled automatically — the bot strips the `CLAUDECODE` env var before spawning

## License

MIT
