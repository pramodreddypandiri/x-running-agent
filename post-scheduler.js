require('dotenv').config();
const RSSParser = require('rss-parser');
const {
  loadJSON, saveJSON, loadText, loadTextNoComments,
  resolveTelegramAuth, requireEnv,
  createTelegramClient,
  callClaude, parseLetterOptions,
  launchBrowser, verifyLogin,
  postOriginalTweet,
  makePendingStore,
} = require('./lib');

// ─── PATHS ───
const CONFIG_PATH = process.env.CONFIG_PATH || './config.json';
const SESSION_PATH = process.env.SESSION_PATH || './x-session.json';
const PROMPT_PATH = process.env.POST_PROMPT_PATH || './prompts/post-prompt.txt';
const STATE_PATH = './data/post-state.json';
const LOG_PATH = './data/post-log.json';
const FEEDBACK_PATH = './data/post-feedback.json';
const PENDING_PATH = './data/post-pending.json';
const CURRENT_WORK_PATH = './prompts/current-work.txt';

// ─── CONFIG ───
const { token: TG_TOKEN, chatId: TG_CHAT } = resolveTelegramAuth('post');
const API_KEY = requireEnv('ANTHROPIC_API_KEY');

const POST_HOUR_PT = parseInt(process.env.POST_HOUR_PT || '8', 10);
const MAX_POSTS_PER_DAY = 1;
const PENDING_EXPIRY_MS = 2 * 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 60 * 1000;

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

// ─── CLIENTS ───
const tg = createTelegramClient({ token: TG_TOKEN, chatId: TG_CHAT });
const pendingStore = makePendingStore(PENDING_PATH);

// ─── STATE ───
const loadState = () => loadJSON(STATE_PATH, {
  paused: false,
  lastPostedDate: null,
  lastTriggeredDate: null,
  todayJitter: null,
});
const saveState = (s) => saveJSON(STATE_PATH, s);
const loadLogs = () => loadJSON(LOG_PATH, { posts: [] });
const saveLogs = (l) => saveJSON(LOG_PATH, l);

const getTodayKey = () => new Date().toISOString().split('T')[0];

// ─── POST FEEDBACK ───
const loadPostFeedback = () => loadJSON(FEEDBACK_PATH, { approved: [], skipped: 0, edited: 0 });
const savePostFeedback = (fb) => saveJSON(FEEDBACK_PATH, fb);

function recordApproval(option, text) {
  const fb = loadPostFeedback();
  fb.approved.push({ date: new Date().toISOString(), option, text: text.substring(0, 280) });
  savePostFeedback(fb);
}

function recordSkip() {
  const fb = loadPostFeedback();
  fb.skipped++;
  savePostFeedback(fb);
}

function recordEdit(text) {
  const fb = loadPostFeedback();
  fb.edited++;
  fb.approved.push({ date: new Date().toISOString(), option: 'EDIT', text: text.substring(0, 280) });
  savePostFeedback(fb);
}

function buildPostFeedback() {
  const fb = loadPostFeedback();
  const recent = fb.approved.slice(-10);
  if (recent.length === 0) return 'No post feedback yet.';
  let ctx = 'POSTS APPROVED:\n';
  recent.forEach(a => { ctx += `- [${a.option}] "${a.text}"\n`; });
  return ctx;
}

// ─── PACIFIC TIME ───
function getPTHourMinute() {
  const now = new Date();
  const year = now.getUTCFullYear();
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
      console.log(`Fetched ${feed.name}: ${(parsed.items || []).length} items`);
    } catch (e) {
      console.log(`Feed error (${feed.name}): ${e.message.substring(0, 80)}`);
    }
  }

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
  const context = stories.map(s => `- ${s.title} [${s.source}]`).join('\n');
  const feedbackCtx = buildPostFeedback();
  const currentWork = loadTextNoComments(CURRENT_WORK_PATH);
  const prompt = promptTemplate
    .replace('{RSS_CONTEXT}', context)
    .replace('{POST_FEEDBACK}', feedbackCtx)
    .replace('{CURRENT_WORK}', currentWork || 'No current work context available.');

  const text = await callClaude({ apiKey: API_KEY, prompt, maxTokens: 600 });
  if (!text) return null;
  const opts = parseLetterOptions(text, 'C');
  return opts.length > 0 ? opts : null;
}

// ─── SEND OPTIONS ───
let pageRef = null;

async function sendOptions(options, stories) {
  const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const headlines = stories.slice(0, 5).map(s => `• ${s.title.substring(0, 70)}`).join('\n');

  let msg = '📝 <b>Daily post options</b>\n\n';
  msg += '<b>From feeds today:</b>\n' + headlines + '\n\n';
  options.forEach((o, i) => { msg += `<b>${['A', 'B', 'C'][i]}:</b> ${o}\n\n`; });

  const optBtns = options.map((_, i) => ({
    text: '✅ ' + ['A', 'B', 'C'][i],
    callback_data: `pa_${id}_${i}`,
  }));
  const ctrlBtns = [
    { text: '✏️ Edit', callback_data: `pe_${id}` },
    { text: '⏭ Skip', callback_data: `ps_${id}` },
  ];
  await tg.send(msg, { inline_keyboard: [optBtns, ctrlBtns] });

  pendingStore.set(id, { options, stories, waitingEdit: false });
  const state = loadState();
  state.pendingPost = { id, createdAt: Date.now() };
  saveState(state);
}

function clearPending(id) {
  pendingStore.delete(id);
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
  // M9 fix: only mark lastPostedDate after the actual post succeeds.
  state.lastPostedDate = getTodayKey();
  state.pendingPost = null;
  saveState(state);
}

async function handlePost(id, text) {
  clearPending(id);
  await tg.send('⏳ Posting...');
  try {
    await postOriginalTweet(pageRef, text);
    recordPost(text);
    await tg.send(`✅ <b>Posted!</b>\n\n${text}`);
  } catch (e) {
    console.error('Post error:', e.message);
    await tg.send(`⚠️ Failed to post: ${e.message.substring(0, 100)}`);
  }
}

// ─── COMMANDS ───
async function handleCallback(update) {
  const data = update.callback_query.data;
  await tg.answerCallback(update.callback_query.id);

  const action = data.substring(0, 2);

  if (action === 'pa') {
    const lastUnderscore = data.lastIndexOf('_');
    const id = data.substring(3, lastUnderscore);
    const idx = parseInt(data.substring(lastUnderscore + 1));
    const pending = pendingStore.get(id);
    if (!pending) return;
    recordApproval(['A', 'B', 'C'][idx], pending.options[idx]);
    await handlePost(id, pending.options[idx]);
  } else if (action === 'pe') {
    const id = data.substring(3);
    if (!pendingStore.get(id)) return;
    pendingStore.update(id, p => ({ ...p, waitingEdit: true }));
    await tg.send('✏️ Type your tweet (max 280 chars):');
  } else if (action === 'ps') {
    const id = data.substring(3);
    clearPending(id);
    recordSkip();
    // Mark today as triggered (not posted) so we don't re-prompt.
    const state = loadState();
    state.lastTriggeredDate = getTodayKey();
    saveState(state);
    await tg.send('⏭ Skipped today\'s post.');
  }
}

async function handleEditText(txt) {
  const editEntry = pendingStore.findByPredicate(p => p.waitingEdit);
  if (!editEntry) return false;
  const [editId] = editEntry;
  if (txt.length > 280) {
    await tg.send(`⚠️ Too long (${txt.length} chars). Max 280. Try again:`);
    return true;
  }
  recordEdit(txt);
  await handlePost(editId, txt);
  return true;
}

async function handleCommand(txt) {
  const cmd = txt.toLowerCase();
  if (cmd === '/pstop') {
    const state = loadState();
    state.paused = true;
    saveState(state);
    await tg.send('⏸ <b>Post scheduler paused.</b> /pstart to resume.');
  } else if (cmd === '/pstart') {
    const state = loadState();
    state.paused = false;
    saveState(state);
    await tg.send('▶️ <b>Post scheduler resumed!</b>');
  } else if (cmd === '/ppost') {
    await tg.send('🔄 Fetching feeds and generating options...');
    await triggerGenerate();
  } else if (cmd === '/pstats') {
    await sendStats();
  } else if (cmd === '/phelp') {
    await tg.send(
      '📝 <b>Post Scheduler Commands</b>\n\n' +
      '/ppost — Generate options now\n' +
      '/pstop — Pause daily posting\n' +
      '/pstart — Resume\n' +
      '/pstats — Stats\n' +
      '/phelp — This message'
    );
  }
}

async function checkTGCommands() {
  const updates = await tg.pollUpdates({ timeout: 1 });
  for (const up of updates) {
    try {
      if (up.callback_query) {
        await handleCallback(up);
        continue;
      }
      if (up.message?.text) {
        const txt = up.message.text.trim();
        if (!txt.startsWith('/')) {
          if (await handleEditText(txt)) continue;
        } else {
          await handleCommand(txt);
        }
      }
    } catch (e) {
      console.error('TG handler error:', e.message);
    }
  }
}

async function sendStats() {
  const logs = loadLogs();
  const state = loadState();
  const today = getTodayKey();
  const todayPosts = logs.posts.filter(p => p.date.startsWith(today));
  const weekPosts = logs.posts.filter(p => Date.now() - new Date(p.date).getTime() < 7 * 24 * 60 * 60 * 1000);
  const { hour, minute } = getPTHourMinute();

  let msg = '📊 <b>Post Scheduler Stats</b>\n\n';
  msg += `State: ${state.paused ? '⏸ Paused' : '▶️ Running'}\n`;
  msg += `PT time now: ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}\n`;
  msg += `Posts today: ${todayPosts.length}/${MAX_POSTS_PER_DAY}\n`;
  msg += `This week: ${weekPosts.length}\n`;
  msg += `All-time: ${logs.posts.length}\n`;
  if (state.lastPostedDate) msg += `Last posted: ${state.lastPostedDate}\n`;
  if (logs.posts.length > 0) {
    const last = logs.posts[logs.posts.length - 1];
    msg += `\n<b>Last post:</b>\n${last.text.substring(0, 120)}`;
  }
  await tg.send(msg);
}

// ─── GENERATE ───
async function triggerGenerate() {
  const prompt = loadText(PROMPT_PATH);
  if (!prompt) { await tg.send(`⚠️ Missing prompt at ${PROMPT_PATH}`); return false; }

  const config = loadJSON(CONFIG_PATH, {});
  const feedList = (config.post_scheduler && config.post_scheduler.rss_feeds) || DEFAULT_RSS_FEEDS;

  const stories = await fetchFeeds(feedList);
  console.log(`Found ${stories.length} relevant stories`);
  if (stories.length === 0) {
    await tg.send('⚠️ No relevant AI/dev stories found in feeds today.');
    return false;
  }

  const options = await generatePostOptions(stories, prompt);
  if (!options || options.length === 0) {
    await tg.send('⚠️ Claude returned no post options. Check your prompt.');
    return false;
  }

  await sendOptions(options, stories);
  return true;
}

// ─── MAIN ───
async function main() {
  console.log('📝 Post Scheduler starting...');

  const { browser, page } = await launchBrowser({ sessionPath: SESSION_PATH });
  pageRef = page;

  console.log('Verifying login...');
  if (!(await verifyLogin(page))) {
    await tg.send('❌ Post scheduler: X session expired. Re-run setup-cookies.');
    await browser.close();
    process.exit(1);
  }
  console.log('Logged in!');

  pendingStore.gc(PENDING_EXPIRY_MS);

  const initState = loadState();
  if (initState.todayJitter === null || initState.lastTriggeredDate !== getTodayKey()) {
    initState.todayJitter = Math.floor(Math.random() * 60);
    saveState(initState);
  }

  const { hour, minute } = getPTHourMinute();
  await tg.send(
    '📝 <b>Post Scheduler online!</b>\n\n' +
    `• Daily post: ${String(POST_HOUR_PT).padStart(2, '0')}:${String(initState.todayJitter).padStart(2, '0')} PT\n` +
    `• PT now: ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}\n` +
    `• State: ${initState.paused ? 'PAUSED' : 'RUNNING'}\n\n` +
    '/ppost /pstop /pstart /pstats /phelp'
  );

  while (true) {
    try {
      await checkTGCommands();
      pendingStore.gc(PENDING_EXPIRY_MS);

      const state = loadState();
      if (!state.paused && pendingStore.entries().length === 0) {
        const { hour: ptH, minute: ptM } = getPTHourMinute();
        const jitter = state.todayJitter !== null ? state.todayJitter : 0;

        if (ptH === POST_HOUR_PT && ptM >= jitter) {
          // M9 fix: track "triggered today" separately from "posted today" so
          // a failed generate doesn't silently skip the day.
          if (state.lastTriggeredDate !== getTodayKey()) {
            console.log('Triggering daily post generation...');
            state.lastTriggeredDate = getTodayKey();
            state.todayJitter = Math.floor(Math.random() * 60);
            saveState(state);
            await triggerGenerate();
          }
        }
      }

      await page.waitForTimeout(CHECK_INTERVAL_MS);
    } catch (e) {
      console.error('Error:', e.message);
      await tg.send(`⚠️ Post scheduler error: ${e.message.substring(0, 100)}`);
      await page.waitForTimeout(30000);
    }
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
