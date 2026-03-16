# X Growth Agent — Project Context for Claude Code

## Who I am
- **Name:** Pramod Reddy Pandiri — @PramodReddy1606
- **Role:** Software Engineer · AI/ML · Agents · San Francisco
- **Bio:** "Software Engineer. AI/ML, Agents"
- **Posts:** 495 · **Following:** 467 · Joined Dec 2017
- **GitHub:** github.com/pramodreddypandiri
- **Substack:** pramodreddypandiri.substack.com
- **Goal:** Build an X agent to grow followers, establish authority in AI/ML/agents, connect with startup founders + AI researchers, and land a job at an AI company (Anthropic, Mistral, Cohere, Together AI, etc.)

---

## My X profile analysis (from claude.ai session)

**Interests:** AI/ML, LLMs, coding agents, context engineering, React Native, Rust CLI, mobile apps, Claude Code, indie building, Substack writing

**Tweet voice:** Builder/maker energy (88%), honest/vulnerable (70%), opinionated (60%), technical (55%), casual (40%). Core mode: **build-in-public storytelling**.

**Key projects I've built:**
- React Native mobile app (got App Store rejected — wrote about it honestly)
- Rust CLI tool to reduce AI token usage (it actually used MORE tokens — wrote a Substack post-mortem)
- Working with Claude Code and coding agents for codebase context engineering

**What needs improvement on my X profile:**
- Bio too short — needs a clear hook + CTA to Substack
- Too many hashtags (16 on one tweet) — drop to 1-2 max
- No reply strategy — not engaging in conversations
- Tweets don't end with a hook/question
- Low followers/following ratio

---

## Base repo we're building on

**Repo:** https://github.com/talhaasiif/x-comment-agent

**What it is:** A production-ready X engagement agent. Node.js + Playwright (headless Chrome). Uses **cookie-based auth** (not the X API) — free, no rate limits. Controlled via Telegram from phone.

**Stack:**
- Node.js + Playwright (headless Chrome)
- Cookie auth via `x-session.json` (exported from browser with EditThisCookie)
- Claude API (Anthropic) for comment generation
- Telegram bot for control + notifications
- systemd service on Hetzner VPS (~$8/mo)
- Total cost: ~$30/mo

**Key files in the repo:**
- `whale-bot.js` — autonomous mode (posts without approval, sends Telegram notifications)
- `manual-bot.js` — manual mode (sends 5 options per tweet, you tap to approve)
- `prompts/whale-prompt.txt` — your voice prompt (THE most important file)
- `config.json` — X list URLs + strategy per list
- `.env` — API keys (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, ANTHROPIC_API_KEY, X_USERNAME)
- `scripts/setup-cookies.js` — converts raw cookies to Playwright session format
- `services/whale-bot.service` — systemd service file

**Safety limits (in whale-bot.js, configurable):**
- Max 20 comments/hour, 100/day
- 3 min minimum gap between comments
- Burst protection: 5 in 30min → 15min cooldown
- 4 hour cooldown per author
- 20% random skip rate
- Only comments on tweets < 30 min old
- Human delay: 30–90 sec before posting

**Telegram commands:** `/wstart` `/wstop` `/wstats` `/wfeedback` `/whelp`
**Per-comment buttons:** ✅ Good · 💬 Feedback · 🗑 Delete

---

## Voice prompt (whale-prompt.txt) — DONE

Already written and saved. Key rules:
- 1–3 sentences max, short is better
- No hashtags ever
- Never start with "Great", "Love this", "Amazing"
- Max one exclamation mark, rarely
- Return `SKIP` when nothing genuine to add
- Reference real projects when relevant (Rust tool, RN app, Claude Code work)
- Never use: leverage, synergy, unlock, excited to share, Web3 slang

---

## Modules to build (planned in claude.ai session)

The base repo only does engagement (replying). We need to add 5 modules:

### Module A — `post-scheduler.js` [NEXT TO BUILD]
Daily original tweet posting. Generates tweet via Claude using voice prompt + trending AI/dev context. Posts at 8–9am PT via Playwright. Reuses existing `x-session.json`.

### Module B — `thread-builder.js`
Takes a topic, builds a 5–7 tweet thread with hook/body/CTA. Posts with 30s delay between tweets. Triggered via Telegram command `/thread [topic]`.

### Module C — `job-radar.js` [HIGH PRIORITY]
Monitors a special "Startups and founders" X list. Flags posts from Startup employees as HIGH PRIORITY in Telegram. Tracks engagement history per target. After 3+ engagements, Claude drafts a DM introduction.

### Module D — `analytics.js`
SQLite database tracking: tweets posted, impressions, follower delta per day, best-performing replies. Weekly summary report to Telegram every Sunday. Feeds top patterns back into voice prompt.

### Module E — `substack-sync.js`
Polls Substack RSS feed daily. On new post, Claude generates a thread teaser (hook + key insight + link). asks for review in Telegram before posting. 

---

## X Lists to create (all private)

| List name | Purpose | Who to add |
|-----------|---------|------------|
| Startups and founders | Job radar | Anthropic, OpenAI, Mistral, Cohere, Together AI, xAI employees + founders |
| AI Builders / Agents | Core niche audience | @swyx, @simonw, @jeremyphoward, @fchollet, agent builders |
| Startups and founders | Network targets | YC AI alumni, indie hackers building with LLMs |
| OSS Contributors | Peers | Active contributors in AI tools, dev tools, Rust ecosystem |
| Peer Builders | AI powered application building niche | AI-powered products or serives builders |

---

## Build order

1. ✅ Fork + read the base repo (done)
2. ✅ Write whale-prompt.txt (done — see `prompts/whale-prompt.txt`)
3. **[NOW]** Set up the base repo: Hetzner server, Node.js, cookies, Telegram bot, .env, 5 X lists
4. Run `whale-bot.js` in **manual mode** for 1 week — review every reply, tune the prompt
5. Build `post-scheduler.js` — daily original posts
6. Build `job-radar.js` — AI company insider targeting
7. Build `thread-builder.js` — weekly thread automation
8. Build `analytics.js` + `substack-sync.js`

---

## Key decisions made

- **Cookie auth over X API** — saves $100/mo, no rate limits, behaves like a real user
- **Manual mode first** — never go fully autonomous until prompt is well-tuned
- **Human-in-the-loop on replies** — authentic voice > volume
- **SKIP is better than a hollow reply** — quality over quantity hardcoded in prompt
- **Job radar is the real pipeline** — systematic warm engagement with AI company people over weeks beats cold applications

---

## Files already created

- `prompts/whale-prompt.txt` — full voice prompt customized for @PramodReddy1606

---
