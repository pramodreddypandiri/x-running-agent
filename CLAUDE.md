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

**Important Telegram caveat:** `getUpdates` is single-consumer per bot token. Running more than one bot simultaneously against the same `TELEGRAM_BOT_TOKEN` causes them to eat each other's updates and silently drop commands. To run multiple bots concurrently, create distinct BotFather bots and set per-bot tokens (see `.env.example`):

- `WHALE_TELEGRAM_BOT_TOKEN` / `WHALE_TELEGRAM_CHAT_ID`
- `MANUAL_TELEGRAM_BOT_TOKEN` / `MANUAL_TELEGRAM_CHAT_ID`
- `JR_TELEGRAM_BOT_TOKEN` / `JR_TELEGRAM_CHAT_ID`
- `POST_TELEGRAM_BOT_TOKEN` / `POST_TELEGRAM_CHAT_ID`
- `COMMENT_TELEGRAM_BOT_TOKEN` / `COMMENT_TELEGRAM_CHAT_ID`

Each bot falls back to `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` when its per-bot var is unset. All bots also enforce a chat-ID guard: updates from any chat other than the configured `*_TELEGRAM_CHAT_ID` are dropped.

Other optional env overrides:
- `X_DISPLAY_NAME` — human display name used in inline reply prompts
- `SESSION_PATH` — path to Playwright session file (default: `./x-session.json`)
- `CONFIG_PATH` — path to config.json
- `WHALE_PROMPT_PATH` / `MANUAL_PROMPT_PATH` / `JOB_RADAR_PROMPT_PATH` / `POST_PROMPT_PATH` — voice prompt files
- `LINKEDIN_URL` / `GITHUB_URL` / `PORTFOLIO_URL` — profile URLs used by job-radar
- `ANTHROPIC_MODEL` — override the Claude model (default: `claude-sonnet-4-20250514`)
- `POST_HOUR_PT` — hour (PT) for daily post (default: 8)

## Architecture

### Shared library

All bots are independent processes that share a `lib/` layer:

| Module | Purpose |
|---|---|
| `lib/storage.js` | `loadJSON`, `saveJSON`, `loadText`, `loadTextNoComments`, `loadSet`, `saveSet` |
| `lib/env.js` | `resolveTelegramAuth(botName)`, `requireEnv`, `resolveEnv` |
| `lib/identity.js` | `getIdentity()` reads `X_USERNAME` / `X_DISPLAY_NAME` |
| `lib/telegram.js` | `createTelegramClient({ token, chatId })` — `send`, `answerCallback`, `editMessage`, `pollUpdates` (with chat-ID guard) |
| `lib/anthropic.js` | `callClaude` (with retry-on-overloaded), `parseLetterOptions`, `weightedPick` |
| `lib/x-browser.js` | `launchBrowser`, `verifyLogin` |
| `lib/x-scrape.js` | `scrapeList`, `scrapeHomeTimeline`, `postComment`, `postOriginalTweet`, `deleteOwnComment`, `randomLike` |
| `lib/rate-limit.js` | `makeRateLimiter(config)` — `canComment`, `canCommentOnAuthor`, `recordComment` |
| `lib/pending.js` | `makePendingStore(filePath)` — JSON-backed pending-action store that survives restarts |
| `lib/feedback.js` | `buildFeedbackContext({ feedbackPath, whaleFeedbackPath })` |

Each bot composes these into its own behavior. Bots stay separate so they can be restarted, paused, or run individually.

### Bot pattern

Every bot follows the same shape:
1. Launch headless Chromium with the saved X session via `launchBrowser`
2. Poll an X list every N seconds via `scrapeList`
3. For each new tweet: call Claude API → generate comment(s)
4. **whale-bot**: auto-post, then notify Telegram with Good/Feedback/Delete buttons
5. **manual-bot**: send 5 options to Telegram, wait for user to tap one, then post
6. **job-radar**: scan flagged lists for hiring profiles, auto-follow, engage selectively
7. **post-scheduler**: at `POST_HOUR_PT`, fetch RSS, generate 3 options, await tap-to-post
8. **comment-bot**: on-demand fan-out — `/comment <text>` posts the same text to N tweets (used for promotion)

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

Polling lives in `lib/telegram.js`. Each `createTelegramClient({ token, chatId })` returns a client with its own offset; `pollUpdates` enforces a chat-ID guard and silently drops updates from any chat other than the configured `chatId`.

Pending callback actions (Good/Feedback/Delete buttons, edit-in-progress, daily-post options) are persisted via `makePendingStore(file)` so they survive process restarts. Stale entries get garbage-collected by `pendingStore.gc(ttlMs)`.

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
- `whale-seen.json` / `manual-seen.json` / `jr-seen.json` — sets of already-processed tweet URLs
- `whale-state.json` / `manual-state.json` / `jr-state.json` / `post-state.json` — pause state + per-bot config
- `whale-logs.json` / `manual-logs.json` / `jr-logs.json` / `post-log.json` — comment/post history + counts
- `whale-watch.json` — watchlist for whale-bot's auto-reply
- `whale-pending.json` / `manual-pending.json` / `jr-pending.json` / `post-pending.json` — persistent pending Telegram actions (so callbacks survive restart)
- `feedback.json` — manual-bot/job-radar shared approval/rejection/edit corpus
- `whale-feedback.json` — whale-bot's Good/Feedback/Delete corpus
- `post-feedback.json` — post-scheduler approval corpus

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
