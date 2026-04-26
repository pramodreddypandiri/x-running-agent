require('dotenv').config();
const fs = require('fs');
const {
  loadJSON, saveJSON, loadText, loadTextNoComments, loadSet, saveSet,
  resolveTelegramAuth, requireEnv, getIdentity,
  createTelegramClient,
  callClaude, parseLetterOptions, weightedPick,
  launchBrowser, verifyLogin,
  scrapeList, postComment, deleteOwnComment,
  makeRateLimiter, makePendingStore, buildFeedbackContext,
} = require('./lib');
const { scrapeMyTweets } = require('./scripts/scrape-my-tweets');
const { buildVoiceSamples } = require('./scripts/build-voice-samples');

// ─── PATHS ───
const SESSION_PATH = process.env.SESSION_PATH || './x-session.json';
const PROMPT_PATH = process.env.WHALE_PROMPT_PATH || './prompts/whale-prompt.txt';
const FEEDBACK_PATH = './data/feedback.json';
const WHALE_FB_PATH = './data/whale-feedback.json';
const WHALE_STATE_PATH = './data/whale-state.json';
const WHALE_LOG_PATH = './data/whale-logs.json';
const SEEN_PATH = './data/whale-seen.json';
const WATCH_PATH = './data/whale-watch.json';
const PENDING_PATH = './data/whale-pending.json';
const CONFIG_PATH = process.env.CONFIG_PATH || './config.json';
const CURRENT_WORK_PATH = './prompts/current-work.txt';
const VOICE_SAMPLES_PATH = './prompts/voice-samples.txt';
const CORPUS_PATH = './data/my-tweets-corpus.json';

// ─── CONFIG ───
const { token: TG_TOKEN, chatId: TG_CHAT } = resolveTelegramAuth('whale');
const API_KEY = requireEnv('ANTHROPIC_API_KEY');
const ME = getIdentity();

// ─── AUTO-REPLY CONFIG ───
const REPLY_WATCH_DURATION = 2 * 60 * 60 * 1000;
const MAX_REPLIES_PER_THREAD = 1;
const REPLY_DELAY_MIN = 20;
const REPLY_DELAY_MAX = 60;

// ─── SAFETY LIMITS ───
const MAX_PER_HOUR = 15;
const MAX_PER_DAY = 40;
const MIN_GAP_MS = 3 * 60 * 1000;
const BURST_LIMIT = 5;
const BURST_WINDOW_MS = 30 * 60 * 1000;
const BURST_COOLDOWN_MS = 15 * 60 * 1000;
const MAX_TWEET_AGE_MS = 10 * 60 * 1000;
const SAME_AUTHOR_COOLDOWN_MS = 4 * 60 * 60 * 1000;
const RANDOM_SKIP_RATE = 0.2;
const PRE_COMMENT_DELAY_MIN = 30;
const PRE_COMMENT_DELAY_MAX = 90;
const CHECK_INTERVAL_MS = 60 * 1000;
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
const WORK_REMINDER_INTERVAL_MS = 2 * 24 * 60 * 60 * 1000;

// Weighted selection across A–E options. A=one-liner, B=question, C=experience,
// D=wild card, E=nuance. Bias toward short formats (A, C).
const OPTION_WEIGHTS = [0.3, 0.15, 0.3, 0.15, 0.1];

// ─── CLIENTS ───
const tg = createTelegramClient({ token: TG_TOKEN, chatId: TG_CHAT });
const rateLimiter = makeRateLimiter({
  maxPerHour: MAX_PER_HOUR,
  maxPerDay: MAX_PER_DAY,
  minGapMs: MIN_GAP_MS,
  burstLimit: BURST_LIMIT,
  burstWindowMs: BURST_WINDOW_MS,
  burstCooldownMs: BURST_COOLDOWN_MS,
  sameAuthorCooldownMs: SAME_AUTHOR_COOLDOWN_MS,
});
const pendingStore = makePendingStore(PENDING_PATH);

// ─── STATE ACCESSORS ───
const loadState = () => loadJSON(WHALE_STATE_PATH, { paused: false });
const saveState = (s) => saveJSON(WHALE_STATE_PATH, s);
const loadLogs = () => loadJSON(WHALE_LOG_PATH, { comments: [], hourly: {}, daily: {} });
const saveLogs = (l) => saveJSON(WHALE_LOG_PATH, l);
const loadWhaleFeedback = () => loadJSON(WHALE_FB_PATH, { feedback: [] });
const saveWhaleFeedback = (f) => saveJSON(WHALE_FB_PATH, f);

function addWhaleFeedback({ author, tweetUrl, comment, feedbackText = '', deleted = false, kind, rewrite }) {
  const fb = loadWhaleFeedback();
  const entry = {
    date: new Date().toISOString(),
    author,
    tweetUrl,
    comment,
    feedback: feedbackText,
    deleted,
    kind: kind || (deleted ? 'deleted' : 'kept'),
  };
  if (rewrite) entry.rewrite = rewrite;
  fb.feedback.push(entry);
  saveWhaleFeedback(fb);
}

// ─── VOICE REFRESH ───
let pageRef = null;
let ctxRef = null;
let refreshInProgress = false;

async function runVoiceRefresh() {
  if (refreshInProgress) {
    await tg.send('⏳ A voice refresh is already running. Hang tight.');
    return;
  }
  if (!ctxRef) {
    await tg.send('❌ Browser context not ready yet.');
    return;
  }
  refreshInProgress = true;

  const prevCorpus = loadJSON(CORPUS_PATH, []);
  const prevUrls = new Set(prevCorpus.map(t => t.url));

  await tg.send(`🔄 <b>Voice refresh starting</b>\nScraping @${ME.username}/with_replies — this takes ~5 min.`);

  let page = null;
  try {
    page = await ctxRef.newPage();
    let lastReportedScroll = 0;
    const result = await scrapeMyTweets({
      page,
      handle: ME.username,
      onProgress: async ({ scrolls, kept, oldestSeen }) => {
        if (scrolls - lastReportedScroll >= 25) {
          lastReportedScroll = scrolls;
          const oldestStr = new Date(oldestSeen).toISOString().split('T')[0];
          await tg.send(`  scroll ${scrolls} → ${kept} kept · oldest=${oldestStr}`);
        }
      },
    });

    const newUrls = result.tweets.map(t => t.url);
    const added = newUrls.filter(u => !prevUrls.has(u)).length;
    const removed = [...prevUrls].filter(u => !newUrls.includes(u)).length;
    const build = buildVoiceSamples();

    let msg = '✅ <b>Voice refresh done</b>\n\n';
    msg += `📊 Corpus: ${result.kept} tweets (was ${prevCorpus.length})\n`;
    msg += `➕ New since last: ${added}\n`;
    if (removed > 0) msg += `➖ Aged out: ${removed}\n`;
    msg += `📝 Voice samples: ${build.picked} picked\n`;
    msg += `🛑 Stop reason: ${result.stopReason} (${result.scrolls} scrolls)\n`;

    if (added > 0) {
      const newTweets = result.tweets.filter(t => !prevUrls.has(t.url)).slice(0, 5);
      msg += '\n<b>New top entries:</b>\n';
      newTweets.forEach(t => {
        msg += `• ${t.text.replace(/\n/g, ' ').slice(0, 90)}\n`;
      });
    }
    await tg.send(msg);
  } catch (e) {
    await tg.send('❌ Refresh failed: ' + (e?.message || String(e)));
  } finally {
    if (page) { try { await page.close(); } catch {} }
    refreshInProgress = false;
  }
}

// ─── COMMAND HANDLERS ───
async function handleCallback(update) {
  const data = update.callback_query.data;
  const parts = data.split('_');
  const action = parts[0];
  const id = parts.slice(1).join('_');
  await tg.answerCallback(update.callback_query.id);

  const pending = pendingStore.get(id);
  if (!pending) return;

  if (action === 'wok') {
    addWhaleFeedback({
      author: pending.author,
      tweetUrl: pending.tweetUrl,
      comment: pending.comment,
      kind: 'approved',
    });
    pendingStore.delete(id);
  } else if (action === 'wfb') {
    pendingStore.update(id, p => ({ ...p, waitingFeedback: true, deleteAfter: false }));
    await tg.send(
      '💬 Type your feedback for this comment.\n' +
      '<i>Tip: start with</i> <code>&gt;&gt;</code> <i>to give the rewrite you would have posted instead.</i>'
    );
  } else if (action === 'wdel') {
    pendingStore.update(id, p => ({ ...p, waitingFeedback: true, deleteAfter: true }));
    await tg.send('🗑 Deleting comment... Type feedback (or send "." to skip):');
    if (pageRef) {
      const deleted = await deleteOwnComment(pageRef, pending.tweetUrl, ME.usernameLC);
      console.log(deleted
        ? `Deleted comment on @${pending.author}`
        : `Failed to delete comment on @${pending.author}`);
    }
  }
}

async function handleFeedbackText(txt) {
  const fbEntry = pendingStore.findByPredicate(p => p.waitingFeedback);
  if (!fbEntry) return false;

  const [fbId, fbData] = fbEntry;
  let kind, feedbackText = '', rewriteText = null, ack;

  if (txt.startsWith('>>')) {
    rewriteText = txt.replace(/^>>\s*/, '').trim();
    kind = 'rewrite';
    ack = '🔁 Rewrite saved as positive example. Learning.';
  } else if (txt === '.') {
    kind = fbData.deleteAfter ? 'deleted' : 'kept';
    ack = fbData.deleteAfter ? '🗑 Comment deleted.' : '👍 Got it.';
  } else {
    feedbackText = txt;
    kind = fbData.deleteAfter ? 'deleted' : 'kept';
    ack = '📝 Feedback saved' + (fbData.deleteAfter ? ' + comment deleted' : '') + '. Learning.';
  }

  addWhaleFeedback({
    author: fbData.author,
    tweetUrl: fbData.tweetUrl,
    comment: fbData.comment,
    feedbackText,
    deleted: fbData.deleteAfter,
    kind,
    rewrite: rewriteText,
  });
  await tg.send(ack);
  pendingStore.delete(fbId);
  return true;
}

async function handleCommand(txt) {
  const cmd = txt.toLowerCase();

  if (cmd === '/wstop') {
    const state = loadState();
    state.paused = true;
    saveState(state);
    await tg.send('⏸ <b>Whale bot paused.</b> Type /wstart to resume.');
  } else if (cmd === '/wstart') {
    const state = loadState();
    state.paused = false;
    saveState(state);
    await tg.send('▶️ <b>Whale bot resumed!</b>');
  } else if (cmd === '/wstats') {
    const logs = loadLogs();
    const dayKey = new Date().toISOString().split('T')[0];
    const hourKey = new Date().toISOString().substring(0, 13);
    const state = loadState();
    const dayCount = logs.daily[dayKey] || 0;
    const hourCount = logs.hourly[hourKey] || 0;
    const total = logs.comments.length;

    const authorCounts = {};
    logs.comments.slice(-50).forEach(c => { authorCounts[c.author] = (authorCounts[c.author] || 0) + 1; });
    const topAuthors = Object.entries(authorCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);

    let msg = '🐋 <b>Whale Bot Stats</b>\n\n';
    msg += `State: ${state.paused ? '⏸ Paused' : '▶️ Running'}\n`;
    msg += `Today: ${dayCount}/${MAX_PER_DAY} comments\n`;
    msg += `This hour: ${hourCount}/${MAX_PER_HOUR}\n`;
    msg += `All-time: ${total}\n\n`;
    if (topAuthors.length > 0) {
      msg += '<b>Most commented on:</b>\n';
      topAuthors.forEach(([a, c]) => { msg += `@${a}: ${c}\n`; });
    }
    await tg.send(msg);
  } else if (cmd === '/whelp') {
    await tg.send(
      '🐋 <b>Whale Bot Commands</b>\n\n' +
      '/wstart — Resume\n/wstop — Pause\n/wstats — Stats\n' +
      '/wfeedback — Feedback stats\n' +
      '/wrefresh — Re-scrape your X replies & rebuild voice samples\n' +
      '/work — View current work context\n' +
      '/work &lt;text&gt; — Add to current work\n' +
      '/work set &lt;text&gt; — Replace current work\n' +
      '/whelp — This message\n\n' +
      '<b>Feedback buttons:</b>\n' +
      '✅ Good — logged as positive example\n' +
      '💬 Feedback — type a critique, OR start with <code>&gt;&gt;</code> to give the rewrite you would have posted\n' +
      '🗑 Delete — removes comment + asks for reason'
    );
  } else if (cmd === '/wrefresh') {
    runVoiceRefresh().catch(e => console.error('wrefresh error:', e));
  } else if (cmd === '/work') {
    const currentWork = loadTextNoComments(CURRENT_WORK_PATH);
    await tg.send(
      '📋 <b>Current work context:</b>\n\n' + (currentWork || '(empty)') +
      '\n\n<i>To update, send:</i>\n/work set your new focus here'
    );
  } else if (cmd.startsWith('/work set ')) {
    const newWork = txt.substring('/work set '.length).trim();
    const header =
      '# CURRENT WORK & FOCUS\n' +
      '# Update this every few days to keep posts and comments authentic.\n' +
      '# The bots inject this into prompts as {CURRENT_WORK}.\n' +
      '# You can also update via Telegram: /work <your current focus>\n\n';
    fs.writeFileSync(CURRENT_WORK_PATH, header + newWork + '\n');
    await tg.send(`✅ <b>Current work updated!</b>\n\n${newWork}`);
  } else if (cmd.startsWith('/work ')) {
    const addition = txt.substring('/work '.length).trim();
    fs.appendFileSync(CURRENT_WORK_PATH, '\n- ' + addition + '\n');
    await tg.send(`✅ <b>Added to current work:</b>\n- ${addition}`);
  } else if (cmd === '/wfeedback') {
    const wfb = loadWhaleFeedback();
    const all = wfb.feedback.map(f => ({ ...f, kind: f.kind || (f.deleted ? 'deleted' : 'kept') }));
    const approved = all.filter(f => f.kind === 'approved').length;
    const rewrites = all.filter(f => f.kind === 'rewrite').length;
    const deleted = all.filter(f => f.kind === 'deleted').length;
    const keptNote = all.filter(f => f.kind === 'kept' && f.feedback).length;
    let msg = '📝 <b>Whale Feedback</b>\n\n';
    msg += `Total: ${all.length}\n✅ Approved: ${approved}\n🔁 Rewrites: ${rewrites}\n🗑 Deleted: ${deleted}\n💬 Kept w/ notes: ${keptNote}\n`;
    if (all.length > 0) {
      msg += '\n<b>Recent:</b>\n';
      all.slice(-5).forEach(f => {
        const icon = f.kind === 'approved' ? '✅' : f.kind === 'rewrite' ? '🔁' : f.kind === 'deleted' ? '🗑' : '💬';
        const detail = f.kind === 'rewrite' ? (f.rewrite || '').substring(0, 60) : (f.feedback || '-').substring(0, 60);
        msg += `${icon} @${f.author}: ${detail}\n`;
      });
    }
    await tg.send(msg);
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
          if (await handleFeedbackText(txt)) continue;
        } else {
          await handleCommand(txt);
        }
      }
    } catch (e) {
      console.error('TG handler error:', e.message);
    }
  }
}

// ─── CLAUDE COMMENT GENERATION ───
async function generateComment(tweetText, tweetAuthor, gp, listStrategy) {
  const fbCtx = buildFeedbackContext({
    feedbackPath: FEEDBACK_PATH,
    whaleFeedbackPath: WHALE_FB_PATH,
  });
  const currentWork = loadTextNoComments(CURRENT_WORK_PATH);
  const voiceSamples = loadTextNoComments(VOICE_SAMPLES_PATH);

  const prompt = gp
    .replace('{FEEDBACK_CONTEXT}', fbCtx)
    .replace('{VIRAL_PATTERNS}', 'Focus on being early and sharp.')
    .replace('{LIST_STRATEGY}', listStrategy)
    .replace('{AUTHOR}', tweetAuthor)
    .replace('{TWEET_TEXT}', tweetText)
    .replace('{CURRENT_WORK}', currentWork || 'No current work context available.')
    .replace('{VOICE_SAMPLES}', voiceSamples || 'No voice samples available yet.');

  const text = await callClaude({ apiKey: API_KEY, prompt, maxTokens: 400 });
  if (!text) return null;
  if (text.trim() === 'SKIP' || text.trim().startsWith('SKIP')) {
    console.log('Claude said SKIP — skipping this tweet');
    return null;
  }

  const opts = parseLetterOptions(text, 'E');
  const valid = opts.filter(o =>
    o !== 'SKIP' &&
    !o.startsWith('SKIP') &&
    !o.toLowerCase().includes('i need to see') &&
    !o.toLowerCase().includes('please provide') &&
    !o.toLowerCase().includes('voice prompt')
  );

  if (valid.length === 0) {
    console.log('All options were SKIP or invalid');
    return null;
  }
  return weightedPick(valid, OPTION_WEIGHTS);
}

async function generateReply(ourComment, theirReply, theirUsername, originalAuthor) {
  const prompt = `You are ${ME.displayName} (${ME.handle}). You commented on @${originalAuthor}'s tweet. Now @${theirUsername} replied to your comment. Continue the conversation naturally.

YOUR ORIGINAL COMMENT: "${ourComment}"

THEIR REPLY: "${theirReply}"

RULES:
- Keep it short, 1-2 lines
- Be conversational and natural
- Don't repeat what you already said
- If they asked a question, answer it genuinely
- If they agreed, add something new to the conversation
- If they disagreed, be respectful and curious
- Sound like a normal person texting
- NEVER promote your business or products
- Vary your formatting (sometimes capitalize, sometimes don't, sometimes use periods, sometimes don't)

Write exactly 1 reply. Just the text, nothing else.`;

  const text = await callClaude({ apiKey: API_KEY, prompt, maxTokens: 150 });
  if (!text) return null;
  return text.trim().replace(/^["']|["']$/g, '');
}

// ─── REPLY WATCHLIST ───
const loadWatchlist = () => loadJSON(WATCH_PATH, []);
const saveWatchlist = (w) => saveJSON(WATCH_PATH, w);

function addToWatchlist(tweetUrl, author, ourComment) {
  const wl = loadWatchlist();
  wl.push({ tweetUrl, author, ourComment: ourComment.substring(0, 150), postedAt: Date.now(), repliedTo: [] });
  saveWatchlist(wl);
}

function cleanWatchlist() {
  const wl = loadWatchlist();
  const cleaned = wl.filter(w => Date.now() - w.postedAt < REPLY_WATCH_DURATION);
  if (cleaned.length !== wl.length) saveWatchlist(cleaned);
  return cleaned;
}

async function checkForReplies(page) {
  const wl = cleanWatchlist();
  if (wl.length === 0) return;

  console.log(`Checking ${wl.length} watched comments for replies...`);

  for (const watch of wl) {
    if (watch.repliedTo.length >= MAX_REPLIES_PER_THREAD) continue;

    try {
      await page.goto(watch.tweetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2500);

      const replies = await page.evaluate((me) => {
        const articles = document.querySelectorAll('article[data-testid="tweet"]');
        let foundOurs = false;
        const repliesToUs = [];

        for (const article of articles) {
          const nameEl = article.querySelector('div[data-testid="User-Name"]');
          if (!nameEl) continue;
          const nameText = nameEl.textContent || '';

          if (nameText.toLowerCase().includes(me)) {
            foundOurs = true;
            continue;
          }

          if (foundOurs) {
            const textEl = article.querySelector('div[data-testid="tweetText"]');
            const replyText = textEl ? textEl.innerText : '';
            const authorEl = article.querySelector('div[data-testid="User-Name"] a');
            const replyAuthor = authorEl ? authorEl.getAttribute('href').replace('/', '') : '';
            let replyUrl = '';
            article.querySelectorAll('a[href*="/status/"]').forEach(l => {
              const h = l.getAttribute('href');
              if (h && h.match(/\/status\/\d+$/)) replyUrl = 'https://x.com' + h;
            });
            if (replyText && replyAuthor && replyAuthor.toLowerCase() !== me) {
              repliesToUs.push({ author: replyAuthor, text: replyText.substring(0, 300), url: replyUrl });
            }
            break;
          }
        }
        return repliesToUs;
      }, ME.usernameLC);

      if (replies.length === 0) continue;

      for (const reply of replies) {
        if (watch.repliedTo.includes(reply.author)) continue;
        console.log(`Reply from @${reply.author} on @${watch.author} thread`);

        const replyComment = await generateReply(watch.ourComment, reply.text, reply.author, watch.author);
        if (!replyComment) continue;

        const delay = (REPLY_DELAY_MIN + Math.random() * (REPLY_DELAY_MAX - REPLY_DELAY_MIN)) * 1000;
        console.log(`Replying in ${Math.round(delay / 1000)}s...`);
        await page.waitForTimeout(delay);

        try {
          await postComment(page, reply.url || watch.tweetUrl, replyComment);
          watch.repliedTo.push(reply.author);
          saveWatchlist(wl);
          console.log(`✅ Replied to @${reply.author}`);
          await tg.send(
            `🔄 <b>Auto-replied to @${reply.author}</b>\n` +
            `(thread with @${watch.author})\n\n` +
            `💬 They said: "${reply.text.substring(0, 100)}"\n\n` +
            `↩️ Our reply: ${replyComment}\n\n` +
            `🔗 ${watch.tweetUrl}`
          );
        } catch (e) {
          console.log(`Failed to reply: ${e.message.substring(0, 80)}`);
        }
      }

      await page.waitForTimeout(1000);
    } catch (e) {
      console.log(`Watch check error: ${e.message.substring(0, 80)}`);
    }
  }
}

// ─── MAIN LOOP HELPERS ───
async function processTweet(page, tw, list, gp) {
  const freshLogs = loadLogs();
  const check = rateLimiter.canComment(freshLogs);
  if (!check.ok) {
    console.log(`Rate limit: ${check.reason}`);
    return { rateLimited: true };
  }

  if (!rateLimiter.canCommentOnAuthor(freshLogs, tw.author)) {
    console.log(`Skipping @${tw.author} (commented recently)`);
    return { skipped: true };
  }

  if (Math.random() < RANDOM_SKIP_RATE) {
    console.log(`Random skip @${tw.author}`);
    return { skipped: true };
  }

  console.log(`New tweet from @${tw.author} [${list.name}]`);

  const comment = await generateComment(tw.text, tw.author, gp, list.strategy);
  if (!comment) {
    console.log('Failed to generate comment');
    return { skipped: false, generated: false };
  }

  const delay = (PRE_COMMENT_DELAY_MIN + Math.random() * (PRE_COMMENT_DELAY_MAX - PRE_COMMENT_DELAY_MIN)) * 1000;
  console.log(`Waiting ${Math.round(delay / 1000)}s before posting...`);
  await page.waitForTimeout(delay);

  try {
    await postComment(page, tw.tweetUrl, comment);
    rateLimiter.recordComment(freshLogs, tw.author, tw.tweetUrl, comment);
    saveLogs(freshLogs);

    console.log(`✅ Posted on @${tw.author} [${list.name}]`);
    addToWatchlist(tw.tweetUrl, tw.author, comment);

    const commentId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    pendingStore.set(commentId, {
      author: tw.author,
      tweetUrl: tw.tweetUrl,
      comment,
      listName: list.name,
      waitingFeedback: false,
      deleteAfter: false,
    });

    await tg.send(
      `🐋 <b>Auto-commented on @${tw.author}</b> · <i>${list.name}</i>\n\n` +
      `💬 ${comment}\n\n` +
      `🔗 ${tw.tweetUrl}`,
      {
        inline_keyboard: [[
          { text: '✅ Good', callback_data: `wok_${commentId}` },
          { text: '💬 Feedback', callback_data: `wfb_${commentId}` },
          { text: '🗑 Delete', callback_data: `wdel_${commentId}` },
        ]],
      }
    );
    return { posted: true };
  } catch (e) {
    console.log(`Failed to post: ${e.message}`);
    await tg.send(`⚠️ Failed to comment on @${tw.author}: ${e.message.substring(0, 80)}`);
    return { posted: false, error: e.message };
  }
}

// ─── MAIN ───
async function main() {
  console.log('🐋 Whale Auto-Commenter starting...');

  const gp = loadText(PROMPT_PATH);
  if (!gp) {
    console.error(`No prompt file at ${PROMPT_PATH}`);
    process.exit(1);
  }

  const seen = loadSet(SEEN_PATH);
  const state = loadState();

  const { browser, ctx, page } = await launchBrowser({ sessionPath: SESSION_PATH });
  pageRef = page;
  ctxRef = ctx;

  console.log('Verifying login...');
  if (!(await verifyLogin(page))) {
    await tg.send('❌ X session expired.');
    await browser.close();
    process.exit(1);
  }
  console.log('Logged in!');

  pendingStore.gc(PENDING_TTL_MS);

  const logs = loadLogs();
  const dayKey = new Date().toISOString().split('T')[0];
  const dayCount = logs.daily[dayKey] || 0;

  const config = loadJSON(CONFIG_PATH, { lists: [] });
  const lists = config.lists || [];

  await tg.send(
    '🐋 <b>Whale Auto-Commenter online!</b>\n\n' +
    `• Identity: @${ME.username}\n` +
    `• Monitoring: ${lists.length} lists (${lists.map(l => l.name).join(', ')})\n` +
    `• Limits: ${MAX_PER_HOUR}/hr, ${MAX_PER_DAY}/day\n` +
    `• Today so far: ${dayCount} comments\n` +
    `• State: ${state.paused ? 'PAUSED' : 'RUNNING'}\n\n` +
    '/wstop /wstart /wstats /whelp'
  );

  while (true) {
    try {
      await checkTGCommands();
      const currentState = loadState();

      if (!currentState.paused) {
        const currentLogs = loadLogs();
        const rateCheck = rateLimiter.canComment(currentLogs);

        if (rateCheck.ok) {
          const freshConfig = loadJSON(CONFIG_PATH, { lists: [] });
          for (const list of freshConfig.lists || []) {
            const tweets = await scrapeList(page, list.url);
            console.log(`Found ${tweets.length} in "${list.name}"`);

            let postedThisList = false;
            for (const tw of tweets) {
              if (seen.has(tw.tweetUrl)) continue;

              if (tw.time) {
                const age = Date.now() - new Date(tw.time).getTime();
                if (age > MAX_TWEET_AGE_MS) { seen.add(tw.tweetUrl); continue; }
              }

              if (tw.author.toLowerCase() === ME.usernameLC) {
                seen.add(tw.tweetUrl);
                continue;
              }

              const result = await processTweet(page, tw, list, gp);
              if (result.rateLimited) break;

              seen.add(tw.tweetUrl);
              saveSet(SEEN_PATH, seen);

              if (result.posted) {
                postedThisList = true;
                break;
              }
            }
            if (postedThisList) break;
          }
        } else {
          console.log(`Rate limited: ${rateCheck.reason}`);
        }

        try {
          await checkForReplies(page);
        } catch (e) {
          console.log(`Reply check error: ${e.message.substring(0, 50)}`);
        }
      } else {
        console.log('Paused.');
      }

      const wState = loadState();
      const lastReminder = wState.lastWorkReminder || 0;
      if (Date.now() - lastReminder > WORK_REMINDER_INTERVAL_MS) {
        const currentWork = loadTextNoComments(CURRENT_WORK_PATH);
        await tg.send(
          '🔄 <b>Time to update your current work context!</b>\n\n' +
          `<b>Current:</b>\n${currentWork || '(empty)'}\n\n` +
          'Still accurate? If not, send:\n' +
          '/work set &lt;your updated focus&gt;\n' +
          'Or add with: /work &lt;new thing&gt;'
        );
        wState.lastWorkReminder = Date.now();
        saveState(wState);
      }

      pendingStore.gc(PENDING_TTL_MS);

      await page.waitForTimeout(CHECK_INTERVAL_MS);
    } catch (e) {
      console.error('Error:', e.message);
      await tg.send(`⚠️ Whale bot error: ${e.message.substring(0, 100)}`);
      await page.waitForTimeout(30000);
    }
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
