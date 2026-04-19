# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

An AI-powered X (Twitter) commenting agent. It uses Playwright to scrape X lists via browser automation (cookie-based auth), calls the Anthropic API to generate comments in the user's voice, posts them automatically, and sends notifications + control commands via Telegram.

## Running the Bots

```bash
# Autonomous mode — posts comments without approval
npm run whale
# or
node whale-bot.js

# Manual mode — sends 5 options to Telegram for user to approve
npm run manual
# or
node manual-bot.js

# Job Radar — scans startup founder profiles for hiring signals, auto-follows, engages
npm run job-radar
# or
node job-radar.js [--dry-run] [--scan-only]

# Convert exported browser cookies to Playwright session format
npm run setup-cookies
# or
node scripts/setup-cookies.js [cookies-raw.json] [x-session.json]
```

No build step. No tests. Run directly with Node.js 22+.

## Required Environment Variables

Set in `.env` (copy from `.env.example`):

```
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
ANTHROPIC_API_KEY=
X_USERNAME=          # without @
```

Optional env overrides:
- `SESSION_PATH` — path to Playwright session file (default: `./x-session.json`)
- `WHALE_LIST_URL` — X list URL to monitor (default in `whale-bot.js`)
- `WHALE_PROMPT_PATH` / `MANUAL_PROMPT_PATH` — path to voice prompt files
- `LINKEDIN_URL` / `GITHUB_URL` / `PORTFOLIO_URL` — Pramod's profile URLs (used by job-radar)

## Architecture

### Two bots, one shared pattern

Both `whale-bot.js` and `manual-bot.js` follow the same structure:
1. Launch headless Chromium with a saved X session
2. Poll an X list every N seconds via `scrapeList()`
3. For each new tweet: call Claude API → generate comment(s)
4. **whale-bot**: auto-post, then notify Telegram with Good/Feedback/Delete buttons
5. **manual-bot**: send 5 options to Telegram, wait for user to tap one, then post

### Authentication

X login is cookie-based. `scripts/setup-cookies.js` converts EditThisCookie JSON exports into Playwright's `storageState` format saved as `x-session.json`. The session expires every few weeks.

### Claude API integration

Both bots call `https://api.anthropic.com/v1/messages` directly via `fetch` (no SDK). Model: `claude-sonnet-4-20250514`. The voice prompt template lives in `prompts/` and uses `{FEEDBACK_CONTEXT}`, `{AUTHOR}`, `{TWEET_TEXT}`, `{LIST_STRATEGY}`, `{VIRAL_PATTERNS}` placeholders.

- **whale-bot**: generates 1 comment (picks randomly from A–E options with weighted selection)
- **manual-bot**: generates 5 options (A–E), sends all to Telegram for selection

### Feedback loop

Feedback is persisted to `data/` as JSON files:
- `data/feedback.json` — approvals, rejections, edits from manual-bot
- `data/whale-feedback.json` — Good/Feedback/Delete actions from whale-bot

Both bots load recent feedback and inject it into the Claude prompt as `{FEEDBACK_CONTEXT}` to improve future comments.

### Telegram polling

Both bots poll Telegram's `getUpdates` API in their main loop (long-poll offset tracking via `tgOff`). They handle both callback button clicks and text message commands. whale-bot also uses `pendingActions` (in-memory Map) to track which Telegram message corresponds to which posted comment, so Delete/Feedback actions know which tweet to act on.

### Rate limiting (whale-bot)

All limits are constants at the top of `whale-bot.js`:
- `MAX_PER_HOUR` (15), `MAX_PER_DAY` (40)
- `MIN_GAP_MS` (3 min), `SAME_AUTHOR_COOLDOWN_MS` (4 hr)
- `BURST_LIMIT` (5 in 30 min) triggers a 15-min cooldown
- `RANDOM_SKIP_RATE` (20%), `MAX_TWEET_AGE_MS` (10 min)

### Auto-reply (whale-bot only)

After posting a comment, whale-bot adds the tweet to `data/whale-watch.json`. Every cycle it checks watched comments for replies directed at the bot, generates a contextual reply via `generateReply()`, and posts it. Watches expire after 2 hours (`REPLY_WATCH_DURATION`).

### Data directory

All runtime state is in `./data/` (not committed):
- `whale-seen.json` / `manual-seen.json` — set of already-processed tweet URLs
- `whale-state.json` / `manual-state.json` — pause state
- `whale-logs.json` / `manual-logs.json` — comment history + hourly/daily counts
- `whale-watch.json` — watchlist for reply detection
- `jr-state.json` / `jr-logs.json` / `jr-seen.json` — job-radar bot state

### Deployment (Linux server)

The `services/` directory contains systemd unit files. Deploy to `/etc/systemd/system/` and use `systemctl enable/start/stop/restart whale-bot`. Logs via `journalctl -u whale-bot -f`. Server is expected at `/root/x-running-agent/`.

## Key Files

| File | Purpose |
|------|---------|
| `whale-bot.js` | Autonomous commenting bot (primary) |
| `manual-bot.js` | Manual approval bot |
| `prompts/whale-prompt.txt` | Voice prompt (copy from `.example.txt`, customize) |
| `prompts/manual-prompt.txt` | Voice prompt for manual mode |
| `config.json` | X list URLs and per-list strategies (copy from `config.example.json`) |
| `x-session.json` | Playwright session (generated by setup-cookies script) |
| `scripts/setup-cookies.js` | Converts browser cookie export to session file |
| `job-radar.js` | Job radar — scans startup profiles for hiring, auto-follows, engages |
| `prompts/job-radar-prompt.txt` | Engagement prompt for job radar comments |
| `jobs/prospects.md` | Auto-generated hiring prospects file |
| `jobs/prospects.json` | Structured prospect data |
