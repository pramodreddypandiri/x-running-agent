require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const RSSParser = require('rss-parser');

// ─── PATHS ───
const CONFIG_PATH = process.env.CONFIG_PATH || './config.json';
const SESSION_PATH = process.env.SESSION_PATH || './x-session.json';
const PROMPT_PATH = process.env.POST_PROMPT_PATH || './prompts/post-prompt.txt';
const STATE_PATH = './data/post-state.json';
const LOG_PATH = './data/post-log.json';
const FEEDBACK_PATH = './data/post-feedback.json';

// ─── CONFIG ───
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;
const API_KEY = process.env.ANTHROPIC_API_KEY;

// Post at 8:00–9:00 AM PT (random minute within the hour, consistent per day)
const POST_HOUR_PT = 8;
const MAX_POSTS_PER_DAY = 1;
const PENDING_EXPIRY_MS = 2 * 60 * 60 * 1000; // options expire after 2 hours
const CHECK_INTERVAL_MS = 60 * 1000;

// Default RSS feeds — override in config.json under post_scheduler.rss_feeds
const DEFAULT_RSS_FEEDS = [
  { url: 'https://news.ycombinator.com/rss', name: 'Hacker News' },
  { url: 'https://simonwillison.net/atom/everything/', name: 'Simon Willison' },
];

const AI_KEYWORDS = [
  'ai ', ' ai ', 'llm', 'gpt', 'claude', 'gemini', 'llama', 'openai', 'anthropic', 'mistral',
  'machine learning', 'deep learning', 'neural', 'transformer', 'agent', 'rag ',
  'fine-tun', 'context window', 'prompt', 'inference', 'model', 'embedding',
  'rust', 'coding agent', 'developer tool', 'open source', 'startup', 'founder',
  'wasm', 'webassembly', 'typescript', 'deno', 'bun',
];

// ─── HELPERS ───
function loadJSON(p, fb) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } }
function saveJSON(p, d) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(d, null, 2)); }
function loadText(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } }

function loadState() { return loadJSON(STATE_PATH, { paused: false, lastPostedDate: null, pendingPost: null, todayJitter: null }); }
function saveState(s) { saveJSON(STATE_PATH, s); }
function loadLogs() { return loadJSON(LOG_PATH, { posts: [] }); }
function saveLogs(l) { saveJSON(LOG_PATH, l); }

function getTodayKey() { return new Date().toISOString().split('T')[0]; }

// ─── POST FEEDBACK ───
function loadPostFeedback() { return loadJSON(FEEDBACK_PATH, { approved: [], skipped: 0, edited: 0 }); }
function savePostFeedback(fb) { saveJSON(FEEDBACK_PATH, fb); }
function recordApproval(option, text) {
  const fb = loadPostFeedback();
  fb.approved.push({ date: new Date().toISOString(), option, text: text.substring(0, 280) });
  savePostFeedback(fb);
}
function recordSkip() { const fb = loadPostFeedback(); fb.skipped++; savePostFeedback(fb); }
function recordEdit(text) { const fb = loadPostFeedback(); fb.edited++; fb.approved.push({ date: new Date().toISOString(), option: 'EDIT', text: text.substring(0, 280) }); savePostFeedback(fb); }
function buildPostFeedback() {
  const fb = loadPostFeedback();
  const recent = fb.approved.slice(-10);
  if (recent.length === 0) return 'No post feedback yet.';
  let ctx = 'POSTS PRAMOD APPROVED:\n';
  recent.forEach(a => { ctx += '- [' + a.option + '] "' + a.text + '"\n'; });
  return ctx;
}

// ─── PACIFIC TIME ───
function getPTHourMinute() {
  const now = new Date();
  const year = now.getUTCFullYear();
  // DST: second Sunday in March → first Sunday in November
  const marchFirst = new Date(Date.UTC(year, 2, 1));
  const dstStart = new Date(Date.UTC(year, 2, 8 + (7 - marchFirst.getUTCDay()) % 7, 2));
  const novFirst = new Date(Date.UTC(year, 10, 1));
  const dstEnd = new Date(Date.UTC(year, 10, 1 + (7 - novFirst.getUTCDay()) % 7, 2));
  const isDST = now >= dstStart && now < dstEnd;
  const offset = isDST ? -7 : -8;
  const ptHour = (now.getUTCHours() + 24 + offset) % 24;
  const ptMinute = now.getUTCMinutes();
  return { hour: ptHour, minute: ptMinute };
}

// ─── RSS FETCH ───
async function fetchFeeds(feeds) {
  const parser = new RSSParser({ timeout: 15000 });
  const stories = [];
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;

  for (const feed of feeds) {
    try {
      const parsed = await parser.parseURL(feed.url);
      for (const item of (parsed.items || [])) {
        const title = (item.title || '').trim();
        if (!title) continue;
        const snippet = (item.contentSnippet || item.summary || '').substring(0, 200);
        const textLower = (title + ' ' + snippet).toLowerCase();
        const pubDate = item.pubDate ? new Date(item.pubDate).getTime() : Date.now();

        if (pubDate < cutoff) continue;
        if (!AI_KEYWORDS.some(kw => textLower.includes(kw))) continue;

        stories.push({ title, url: item.link || '', source: feed.name, pubDate });
      }
      console.log('Fetched ' + feed.name + ': ' + (parsed.items || []).length + ' items');
    } catch (e) {
      console.log('Feed error (' + feed.name + '): ' + e.message.substring(0, 80));
    }
  }

  // Sort by recency, dedupe by title prefix, cap at 10
  stories.sort((a, b) => b.pubDate - a.pubDate);
  const seen = new Set();
  return stories.filter(s => {
    const key = s.title.toLowerCase().substring(0, 50);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 10);
}

// ─── GENERATE POST OPTIONS ───
async function generatePostOptions(stories, promptTemplate) {
  const context = stories.map(s => '- ' + s.title + ' [' + s.source + ']').join('\n');
  const feedbackCtx = buildPostFeedback();
  const currentWork = loadText('./prompts/current-work.txt').replace(/^#.*$/gm, '').trim();
  const prompt = promptTemplate.replace('{RSS_CONTEXT}', context).replace('{POST_FEEDBACK}', feedbackCtx).replace('{CURRENT_WORK}', currentWork || 'No current work context available.');

  let d = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 600, messages: [{ role: 'user', content: prompt }] })
    });
    d = await r.json();
    if (d.content && d.content[0]) break;
    if (d.error && d.error.type === 'overloaded_error') {
      const wait = (attempt + 1) * 10;
      console.log('API overloaded, retrying in ' + wait + 's (attempt ' + (attempt+1) + '/3)');
      await new Promise(resolve => setTimeout(resolve, wait * 1000));
    } else {
      console.error('Claude API error:', JSON.stringify(d));
      return null;
    }
  }
  if (!d || !d.content || !d.content[0]) { console.error('Claude failed after retries:', JSON.stringify(d)); return null; }

  const text = d.content[0].text.trim();
  const opts = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if (line.match(/^[A-C]:/)) {
      if (cur) opts.push(cur.trim());
      cur = line.replace(/^[A-C]:\s*/, '').replace(/^["']|["']$/g, '');
    } else if (cur && line.trim()) {
      cur += ' ' + line.trim();
    }
  }
  if (cur) opts.push(cur.trim());
  return opts.length > 0 ? opts : null;
}

// ─── POST ORIGINAL TWEET ───
async function postTweet(page, text) {
  await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2000 + Math.random() * 2000);
  const box = await page.waitForSelector('div[data-testid="tweetTextarea_0"]', { timeout: 10000 });
  await box.click();
  await page.waitForTimeout(400 + Math.random() * 400);
  await page.keyboard.type(text, { delay: 30 + Math.random() * 40 });
  await page.waitForTimeout(1000 + Math.random() * 1000);
  const btn = await page.waitForSelector('button[data-testid="tweetButtonInline"]', { timeout: 5000 });
  await btn.click();
  await page.waitForTimeout(3000);
  return true;
}

// ─── TELEGRAM ───
let tgOff = 0;
let pageRef = null;
const pendingPosts = new Map(); // id → { options, stories, waitingEdit, createdAt }

async function sendTG(text, rm) {
  const b = { chat_id: TG_CHAT, text, parse_mode: 'HTML' };
  if (rm) b.reply_markup = JSON.stringify(rm);
  const r = await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b)
  });
  return await r.json();
}

async function answerCB(id) {
  await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/answerCallbackQuery', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ callback_query_id: id })
  });
}

async function sendOptions(options, stories) {
  const id = Date.now().toString();
  const headlines = stories.slice(0, 5).map(s => '• ' + s.title.substring(0, 70)).join('\n');

  let msg = '📝 <b>Daily post options</b>\n\n';
  msg += '<b>From feeds today:</b>\n' + headlines + '\n\n';
  options.forEach((o, i) => { msg += '<b>' + ['A', 'B', 'C'][i] + ':</b> ' + o + '\n\n'; });

  const optBtns = options.map((_, i) => ({ text: '✅ ' + ['A', 'B', 'C'][i], callback_data: 'pa_' + id + '_' + i }));
  const ctrlBtns = [{ text: '✏️ Edit', callback_data: 'pe_' + id }, { text: '⏭ Skip', callback_data: 'ps_' + id }];
  await sendTG(msg, { inline_keyboard: [optBtns, ctrlBtns] });

  pendingPosts.set(id, { options, stories, waitingEdit: false, createdAt: Date.now() });
  const state = loadState();
  state.pendingPost = { id, createdAt: Date.now() };
  saveState(state);
}

function clearPending(id) {
  pendingPosts.delete(id);
  const state = loadState();
  state.pendingPost = null;
  saveState(state);
}

function recordPost(text) {
  const logs = loadLogs();
  logs.posts.push({ date: new Date().toISOString(), text: text.substring(0, 280) });
  if (logs.posts.length > 500) logs.posts = logs.posts.slice(-500);
  saveLogs(logs);
  const state = loadState();
  state.lastPostedDate = getTodayKey();
  state.pendingPost = null;
  saveState(state);
}

async function handlePost(id, text) {
  clearPending(id);
  await sendTG('⏳ Posting...');
  try {
    await postTweet(pageRef, text);
    recordPost(text);
    await sendTG('✅ <b>Posted!</b>\n\n' + text);
  } catch (e) {
    console.error('Post error:', e.message);
    await sendTG('⚠️ Failed to post: ' + e.message.substring(0, 100));
  }
}

async function checkTGCommands() {
  try {
    const r = await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/getUpdates?offset=' + tgOff + '&timeout=1');
    const u = await r.json();
    if (!u.ok || !u.result) return;

    for (const up of u.result) {
      tgOff = up.update_id + 1;

      // ── Callback buttons ──
      if (up.callback_query) {
        const data = up.callback_query.data; // e.g. "pa_1234_0", "pe_1234", "ps_1234"
        await answerCB(up.callback_query.id);

        const action = data.substring(0, 2); // "pa", "pe", "ps"

        if (action === 'pa') {
          // pa_ID_idx
          const lastUnderscore = data.lastIndexOf('_');
          const id = data.substring(3, lastUnderscore);
          const idx = parseInt(data.substring(lastUnderscore + 1));
          const pending = pendingPosts.get(id);
          if (!pending) continue;
          recordApproval(['A', 'B', 'C'][idx], pending.options[idx]);
          await handlePost(id, pending.options[idx]);
        } else if (action === 'pe') {
          const id = data.substring(3);
          const pending = pendingPosts.get(id);
          if (!pending) continue;
          pending.waitingEdit = true;
          await sendTG('✏️ Type your tweet (max 280 chars):');
        } else if (action === 'ps') {
          const id = data.substring(3);
          clearPending(id);
          recordSkip();
          // Mark today as skipped so we don't re-trigger
          const state = loadState();
          state.lastPostedDate = getTodayKey();
          saveState(state);
          await sendTG('⏭ Skipped today\'s post.');
        }
        continue;
      }

      // ── Text messages ──
      if (up.message && up.message.text) {
        const txt = up.message.text.trim();

        // Handle edit reply
        const editEntry = [...pendingPosts.entries()].find(([, p]) => p.waitingEdit);
        if (editEntry && !txt.startsWith('/')) {
          const [editId] = editEntry;
          if (txt.length > 280) {
            await sendTG('⚠️ Too long (' + txt.length + ' chars). Max 280. Try again:');
            continue;
          }
          recordEdit(txt);
          await handlePost(editId, txt);
          continue;
        }

        // Commands
        const cmd = txt.toLowerCase();
        if (cmd === '/pstop') {
          const state = loadState(); state.paused = true; saveState(state);
          await sendTG('⏸ <b>Post scheduler paused.</b> /pstart to resume.');
        } else if (cmd === '/pstart') {
          const state = loadState(); state.paused = false; saveState(state);
          await sendTG('▶️ <b>Post scheduler resumed!</b>');
        } else if (cmd === '/ppost') {
          await sendTG('🔄 Fetching feeds and generating options...');
          await triggerGenerate();
        } else if (cmd === '/pstats') {
          await sendStats();
        } else if (cmd === '/phelp') {
          await sendTG('📝 <b>Post Scheduler Commands</b>\n\n/ppost — Generate options now\n/pstop — Pause daily posting\n/pstart — Resume\n/pstats — Stats\n/phelp — This message');
        }
      }
    }
  } catch (e) { console.log('TG poll error: ' + e.message); }
}

async function sendStats() {
  const logs = loadLogs();
  const state = loadState();
  const today = getTodayKey();
  const todayPosts = logs.posts.filter(p => p.date.startsWith(today));
  const weekPosts = logs.posts.filter(p => Date.now() - new Date(p.date).getTime() < 7 * 24 * 60 * 60 * 1000);
  const { hour, minute } = getPTHourMinute();

  let msg = '📊 <b>Post Scheduler Stats</b>\n\n';
  msg += 'State: ' + (state.paused ? '⏸ Paused' : '▶️ Running') + '\n';
  msg += 'PT time now: ' + String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0') + '\n';
  msg += 'Posts today: ' + todayPosts.length + '/' + MAX_POSTS_PER_DAY + '\n';
  msg += 'This week: ' + weekPosts.length + '\n';
  msg += 'All-time: ' + logs.posts.length + '\n';
  if (state.lastPostedDate) msg += 'Last posted: ' + state.lastPostedDate + '\n';
  if (logs.posts.length > 0) {
    const last = logs.posts[logs.posts.length - 1];
    msg += '\n<b>Last post:</b>\n' + last.text.substring(0, 120);
  }
  await sendTG(msg);
}

// ─── GENERATE ───
async function triggerGenerate() {
  const prompt = loadText(PROMPT_PATH);
  if (!prompt) { await sendTG('⚠️ Missing prompt at ' + PROMPT_PATH); return; }

  const config = loadJSON(CONFIG_PATH, {});
  const feedList = (config.post_scheduler && config.post_scheduler.rss_feeds) || DEFAULT_RSS_FEEDS;

  const stories = await fetchFeeds(feedList);
  console.log('Found ' + stories.length + ' relevant stories');
  if (stories.length === 0) { await sendTG('⚠️ No relevant AI/dev stories found in feeds today.'); return; }

  const options = await generatePostOptions(stories, prompt);
  if (!options || options.length === 0) { await sendTG('⚠️ Claude returned no post options. Check your prompt.'); return; }

  await sendOptions(options, stories);
}

// ─── MAIN ───
async function main() {
  console.log('📝 Post Scheduler starting...');
  if (!TG_TOKEN || !TG_CHAT || !API_KEY) { console.error('Missing env vars (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, ANTHROPIC_API_KEY)'); process.exit(1); }

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'] });
  const ctx = await browser.newContext({
    storageState: SESSION_PATH,
    viewport: { width: 1280, height: 720 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await ctx.newPage();

  console.log('Verifying login...');
  await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);
  if ((await page.url()).includes('/login')) {
    await sendTG('❌ Post scheduler: X session expired. Re-run setup-cookies.');
    process.exit(1);
  }
  console.log('Logged in!');
  pageRef = page;

  // Set a consistent jitter for today's post time
  const initState = loadState();
  if (initState.todayJitter === null || initState.lastPostedDate !== getTodayKey()) {
    initState.todayJitter = Math.floor(Math.random() * 60);
    saveState(initState);
  }

  const { hour, minute } = getPTHourMinute();
  await sendTG(
    '📝 <b>Post Scheduler online!</b>\n\n' +
    '• Daily post: 8:' + String(initState.todayJitter).padStart(2, '0') + ' AM PT\n' +
    '• PT now: ' + String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0') + '\n' +
    '• State: ' + (initState.paused ? 'PAUSED' : 'RUNNING') + '\n\n' +
    '/ppost /pstop /pstart /pstats /phelp'
  );

  while (true) {
    try {
      await checkTGCommands();

      // Expire stale pending options
      for (const [id, p] of pendingPosts.entries()) {
        if (Date.now() - p.createdAt > PENDING_EXPIRY_MS) {
          console.log('Pending post options expired.');
          clearPending(id);
        }
      }

      const state = loadState();
      if (!state.paused && pendingPosts.size === 0) {
        const { hour: ptH, minute: ptM } = getPTHourMinute();
        const jitter = state.todayJitter !== null ? state.todayJitter : 0;

        if (ptH === POST_HOUR_PT && ptM >= jitter) {
          if (state.lastPostedDate !== getTodayKey()) {
            console.log('Triggering daily post generation...');
            // Mark today to prevent duplicate triggers on restart
            state.lastPostedDate = getTodayKey();
            state.todayJitter = Math.floor(Math.random() * 60);
            saveState(state);
            await triggerGenerate();
          }
        }
      }

      await page.waitForTimeout(CHECK_INTERVAL_MS);
    } catch (e) {
      console.error('Error:', e.message);
      await sendTG('⚠️ Post scheduler error: ' + e.message.substring(0, 100));
      await page.waitForTimeout(30000);
    }
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
