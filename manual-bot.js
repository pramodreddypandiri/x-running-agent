require('dotenv').config();
const {
  loadJSON, saveJSON, loadText, loadTextNoComments, loadSet, saveSet,
  resolveTelegramAuth, requireEnv, getIdentity,
  createTelegramClient,
  callClaude, parseLetterOptions,
  launchBrowser, verifyLogin,
  scrapeList, postComment, randomLike,
  makePendingStore,
} = require('./lib');

// ─── PATHS ───
const CONFIG_PATH = process.env.CONFIG_PATH || './config.json';
const SESSION_PATH = process.env.SESSION_PATH || './x-session.json';
const LOG_PATH = './data/manual-logs.json';
const PROMPT_PATH = process.env.MANUAL_PROMPT_PATH || './prompts/manual-prompt.txt';
const FEEDBACK_PATH = './data/feedback.json';
const VIRAL_PATH = './data/viral-patterns.txt';
const SEEN_PATH = './data/manual-seen.json';
const STATE_PATH = './data/manual-state.json';
const PENDING_PATH = './data/manual-pending.json';
const CURRENT_WORK_PATH = './prompts/current-work.txt';

// ─── CONFIG ───
const { token: TG_TOKEN, chatId: TG_CHAT } = resolveTelegramAuth('manual');
const API_KEY = requireEnv('ANTHROPIC_API_KEY');
const ME = getIdentity();

const CHECK_MS = 5 * 60 * 1000;
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

// ─── CLIENTS ───
const tg = createTelegramClient({ token: TG_TOKEN, chatId: TG_CHAT });
const pendingApprovals = makePendingStore(PENDING_PATH);
const pendingRej = makePendingStore('./data/manual-rejection-pending.json');

// ─── STATE ───
const loadState = () => loadJSON(STATE_PATH, { paused: false, maxTweetAgeMin: 30 });
const saveState = (s) => saveJSON(STATE_PATH, s);

// ─── FEEDBACK ───
const loadFeedback = () => loadJSON(FEEDBACK_PATH, { approvals: [], rejections: [], edits: [] });
const saveFeedback = (fb) => saveJSON(FEEDBACK_PATH, fb);

function addApproval(ta, tt, oi, ol, ct, ao, ln) {
  const fb = loadFeedback();
  fb.approvals.push({
    date: new Date().toISOString(),
    tweetAuthor: ta,
    tweetText: tt.substring(0, 200),
    chosenOption: ol,
    commentText: ct,
    rejectedOptions: ao.filter((_, i) => i !== oi).map(c => c.substring(0, 200)),
    listName: ln,
  });
  saveFeedback(fb);
}

function addRejection(ta, tt, reason, ac, ln) {
  const fb = loadFeedback();
  fb.rejections.push({
    date: new Date().toISOString(),
    tweetAuthor: ta,
    tweetText: tt.substring(0, 200),
    reason,
    rejectedComments: ac.map(c => c.substring(0, 200)),
    listName: ln,
  });
  saveFeedback(fb);
}

function addEdit(ta, tt, oc, ec, ln) {
  const fb = loadFeedback();
  fb.edits.push({
    date: new Date().toISOString(),
    tweetAuthor: ta,
    tweetText: tt.substring(0, 200),
    originalComments: oc.map(c => c.substring(0, 200)),
    editedComment: ec,
    listName: ln,
  });
  saveFeedback(fb);
}

function buildFeedbackContext() {
  const fb = loadFeedback();
  let ctx = '';
  const ra = fb.approvals.slice(-15);
  if (ra.length > 0) {
    ctx += 'COMMENTS APPROVED:\n';
    ra.forEach(a => { ctx += `- @${a.tweetAuthor} -> chose ${a.chosenOption}: "${a.commentText}"\n`; });
    ctx += '\n';
  }
  const rr = fb.rejections.slice(-10);
  if (rr.length > 0) {
    ctx += 'COMMENTS REJECTED:\n';
    rr.forEach(r => { ctx += `- Reason: ${r.reason}. Example: "${(r.rejectedComments[0] || '').substring(0, 80)}"\n`; });
    ctx += '\n';
  }
  const re = fb.edits.slice(-5);
  if (re.length > 0) {
    ctx += 'EDITS:\n';
    re.forEach(e => { ctx += `- "${e.editedComment}"\n`; });
    ctx += '\n';
  }
  if (fb.approvals.length >= 10) {
    const oc = {};
    fb.approvals.slice(-30).forEach(a => { oc[a.chosenOption] = (oc[a.chosenOption] || 0) + 1; });
    const s = Object.entries(oc).sort((a, b) => b[1] - a[1]);
    if (s[0]) ctx += `PATTERN: Picks ${s[0][0]} most (${s[0][1]}x). Weight but vary.\n`;
  }
  return ctx || 'No feedback yet.';
}

// ─── LOGGING ───
const loadLogs = () => loadJSON(LOG_PATH, { comments: [], dailyStats: {} });
const saveLogs = (l) => saveJSON(LOG_PATH, l);

function logComment(e) {
  const l = loadLogs();
  l.comments.push({ ...e, timestamp: new Date().toISOString() });
  const t = new Date().toISOString().split('T')[0];
  if (!l.dailyStats[t]) {
    l.dailyStats[t] = { commentsPosted: 0, commentsApproved: 0, commentsRejected: 0, tweetsFound: 0 };
  }
  if (e.status === 'posted') l.dailyStats[t].commentsPosted++;
  if (e.status === 'approved') l.dailyStats[t].commentsApproved++;
  if (e.status === 'rejected') l.dailyStats[t].commentsRejected++;
  if (e.status === 'found') l.dailyStats[t].tweetsFound++;
  saveLogs(l);
}

// ─── CLAUDE ───
async function generateComments(tweetText, tweetAuthor, strategy, gp) {
  const fc = buildFeedbackContext();
  const vp = loadText(VIRAL_PATH) || 'No viral data yet.';
  const currentWork = loadTextNoComments(CURRENT_WORK_PATH);
  const prompt = gp
    .replace('{FEEDBACK_CONTEXT}', fc)
    .replace('{VIRAL_PATTERNS}', vp)
    .replace('{LIST_STRATEGY}', strategy)
    .replace('{AUTHOR}', tweetAuthor)
    .replace('{TWEET_TEXT}', tweetText)
    .replace('{CURRENT_WORK}', currentWork || 'No current work context available.');

  const text = await callClaude({ apiKey: API_KEY, prompt, maxTokens: 800 });
  if (!text) return null;
  const opts = parseLetterOptions(text, 'E');
  return opts.length > 0 ? opts : [text.trim()];
}

// ─── APPROVAL QUEUE ───
const postQ = [];
let posting = false;

async function requestApproval(tweet, comments, listName) {
  const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const labels = ['A', 'B', 'C', 'D', 'E'];
  const types = ['One-liner', 'Question', 'Experience', 'Wild card', 'Nuance'];

  let msg = `🐦 <b>@${tweet.author}</b> · <i>${listName}</i>\n\n<b>Tweet:</b>\n${tweet.text.substring(0, 400)}\n\n`;
  comments.forEach((c, i) => {
    if (i < 5) msg += `<b>${labels[i]}</b> <i>(${types[i]})</i>\n${c}\n\n`;
  });
  msg += `🔗 ${tweet.tweetUrl}`;

  const r1 = comments.slice(0, 5).map((_, i) => ({
    text: '✅ ' + labels[i],
    callback_data: `ap_${id}_${i}`,
  }));
  const r2 = [
    { text: '❌ Skip', callback_data: `sk_${id}` },
    { text: '✏️ Edit', callback_data: `ed_${id}` },
  ];
  await tg.send(msg, { inline_keyboard: [r1, r2] });

  pendingApprovals.set(id, { tweet, comments, listName, status: 'pending' });
  logComment({
    tweetAuthor: tweet.author,
    tweetUrl: tweet.tweetUrl,
    listName,
    status: 'found',
    approvalId: id,
  });
}

async function processPostQ(page) {
  if (posting || postQ.length === 0) return;
  posting = true;
  while (postQ.length > 0) {
    const item = postQ.shift();
    try {
      await postComment(page, item.tweet.tweetUrl, item.comment);
      await tg.send(`✅ Posted on @${item.tweet.author}'s tweet!`);
      logComment({
        tweetAuthor: item.tweet.author,
        tweetUrl: item.tweet.tweetUrl,
        comment: item.comment,
        listName: item.listName,
        status: 'posted',
      });
    } catch (e) {
      await tg.send(`⚠️ Failed: ${e.message}`);
    }
    if (postQ.length > 0) {
      const d = (120 + Math.random() * 180) * 1000;
      console.log(`Next in ${Math.round(d / 1000)}s`);
      await new Promise(r => setTimeout(r, d));
    }
  }
  posting = false;
}

// ─── COMMANDS ───
async function handleCommand(text) {
  const state = loadState();
  const parts = text.trim().split(' ');
  const cmd = parts[0].toLowerCase();

  if (cmd === '/help') {
    await tg.send(
      '🤖 <b>X Agent Commands</b>\n\n' +
      '/status — Current status\n' +
      '/pause — Stop checking for tweets\n' +
      '/resume — Start checking again\n' +
      '/report — Today\'s stats\n' +
      `/set_window [min] — Change tweet age limit (current: ${state.maxTweetAgeMin} min)\n` +
      '/lists — Show active lists\n' +
      '/queue — Show posting queue\n' +
      '/feedback — Show learning stats\n' +
      '/help — This message'
    );
    return true;
  }

  if (cmd === '/status') {
    const logs = loadLogs();
    const today = new Date().toISOString().split('T')[0];
    const s = logs.dailyStats[today] || { commentsPosted: 0, tweetsFound: 0, commentsRejected: 0 };
    const fb = loadFeedback();
    await tg.send(
      '📊 <b>Status</b>\n\n' +
      `State: ${state.paused ? '⏸ Paused' : '▶️ Running'}\n` +
      `Tweet window: ${state.maxTweetAgeMin} min\n` +
      `Posting queue: ${postQ.length} comments waiting\n\n` +
      '<b>Today:</b>\n' +
      `Tweets found: ${s.tweetsFound}\n` +
      `Comments posted: ${s.commentsPosted}\n` +
      `Skipped: ${s.commentsRejected}\n\n` +
      '<b>All-time learning:</b>\n' +
      `Approved: ${fb.approvals.length}\n` +
      `Rejected: ${fb.rejections.length}\n` +
      `Edits: ${fb.edits.length}`
    );
    return true;
  }

  if (cmd === '/pause') {
    state.paused = true;
    saveState(state);
    await tg.send('⏸ <b>Paused.</b> I\'ll stop checking for new tweets. Pending approvals still work. Type /resume to continue.');
    return true;
  }

  if (cmd === '/resume') {
    state.paused = false;
    saveState(state);
    await tg.send('▶️ <b>Resumed!</b> Checking for tweets again.');
    return true;
  }

  if (cmd === '/report') {
    await sendDailyReport();
    return true;
  }

  if (cmd === '/set_window') {
    const mins = parseInt(parts[1]);
    if (!mins || mins < 1 || mins > 1440) {
      await tg.send(`Usage: /set_window [minutes]\nExample: /set_window 60\nCurrent: ${state.maxTweetAgeMin} min\nRange: 1-1440`);
      return true;
    }
    state.maxTweetAgeMin = mins;
    saveState(state);
    await tg.send(`✅ Tweet window set to <b>${mins} minutes</b>. Will only comment on tweets younger than ${mins} min.`);
    return true;
  }

  if (cmd === '/lists') {
    const config = loadJSON(CONFIG_PATH, { lists: [] });
    if (config.lists.length === 0) {
      await tg.send('No lists configured.');
      return true;
    }
    let msg = `📝 <b>Active Lists (${config.lists.length})</b>\n\n`;
    config.lists.forEach((l, i) => {
      msg += `<b>${i + 1}. ${l.name}</b>\n${l.url}\n<i>${l.strategy.substring(0, 100)}...</i>\n\n`;
    });
    await tg.send(msg);
    return true;
  }

  if (cmd === '/queue') {
    if (postQ.length === 0) {
      await tg.send('Posting queue is empty.');
    } else {
      let msg = `📤 <b>Posting Queue (${postQ.length})</b>\n\n`;
      postQ.forEach((item, i) => {
        msg += `${i + 1}. @${item.tweet.author}: "${item.comment.substring(0, 80)}..."\n`;
      });
      await tg.send(msg);
    }
    return true;
  }

  if (cmd === '/feedback') {
    const fb = loadFeedback();
    let msg = '🧠 <b>Learning Data</b>\n\n';
    msg += `Total approved: ${fb.approvals.length}\n`;
    msg += `Total rejected: ${fb.rejections.length}\n`;
    msg += `Total edits: ${fb.edits.length}\n\n`;
    if (fb.approvals.length >= 5) {
      const oc = {};
      fb.approvals.slice(-30).forEach(a => { oc[a.chosenOption] = (oc[a.chosenOption] || 0) + 1; });
      const types = { A: 'One-liner', B: 'Question', C: 'Experience', D: 'Wild card', E: 'Nuance' };
      const sorted = Object.entries(oc).sort((a, b) => b[1] - a[1]);
      msg += '<b>Your top picks (last 30):</b>\n';
      sorted.forEach(([o, c]) => { msg += `${o} (${types[o] || o}): ${c} times\n`; });
    }
    if (fb.rejections.length >= 3) {
      const rc = {};
      fb.rejections.slice(-20).forEach(r => { rc[r.reason] = (rc[r.reason] || 0) + 1; });
      msg += '\n<b>Top skip reasons:</b>\n';
      Object.entries(rc).sort((a, b) => b[1] - a[1]).forEach(([r, c]) => { msg += `${r}: ${c}\n`; });
    }
    await tg.send(msg);
    return true;
  }

  return false;
}

// ─── CALLBACKS / TEXT ───
async function handleCallback(update) {
  const d = update.callback_query.data;
  const p = d.split('_');
  const act = p[0];
  const aid = p[1];
  const oi = p[2] !== undefined ? parseInt(p[2]) : -1;
  console.log('Callback:', act, aid, oi, '| Pending:', pendingApprovals.entries().length);
  await tg.answerCallback(update.callback_query.id);

  if (act === 'rr') {
    const pr = pendingRej.get(aid);
    if (pr) {
      const reasons = ['Too generic', 'Too self-promotional', 'Wrong tone', 'Not relevant', 'Too long', 'Sounds like AI'];
      addRejection(pr.tweet.author, pr.tweet.text, reasons[oi] || 'Unknown', pr.comments, pr.listName);
      await tg.send(`📝 "${reasons[oi] || 'Unknown'}" — noted. Learning.`);
      pendingRej.delete(aid);
    }
    return;
  }

  const pend = pendingApprovals.get(aid);
  if (!pend) return;

  if (act === 'ap' && oi >= 0) {
    const labels = ['A', 'B', 'C', 'D', 'E'];
    const chosen = pend.comments[oi];
    postQ.push({ tweet: pend.tweet, comment: chosen, listName: pend.listName });
    addApproval(pend.tweet.author, pend.tweet.text, oi, labels[oi], chosen, pend.comments, pend.listName);
    await tg.send(`✅ ${labels[oi]} queued! (${postQ.length} in queue)`);
    logComment({
      tweetAuthor: pend.tweet.author,
      tweetUrl: pend.tweet.tweetUrl,
      comment: chosen,
      listName: pend.listName,
      status: 'approved',
      approvalId: aid,
    });
    pendingApprovals.delete(aid);
  } else if (act === 'sk') {
    const rk = {
      inline_keyboard: [[
        { text: '😐 Generic', callback_data: `rr_${aid}_0` },
        { text: '🎯 Self-promo', callback_data: `rr_${aid}_1` },
        { text: '🗣 Wrong tone', callback_data: `rr_${aid}_2` },
      ], [
        { text: '🤷 Not relevant', callback_data: `rr_${aid}_3` },
        { text: '📏 Too long', callback_data: `rr_${aid}_4` },
        { text: '🤖 Sounds AI', callback_data: `rr_${aid}_5` },
      ]],
    };
    await tg.send('Why skip?', rk);
    pendingRej.set(aid, { tweet: pend.tweet, comments: pend.comments, listName: pend.listName });
    logComment({
      tweetAuthor: pend.tweet.author,
      tweetUrl: pend.tweet.tweetUrl,
      listName: pend.listName,
      status: 'rejected',
      approvalId: aid,
    });
    pendingApprovals.delete(aid);
  } else if (act === 'ed') {
    pendingApprovals.update(aid, p => ({ ...p, status: 'editing' }));
    await tg.send('✏️ Type your comment:');
  }
}

async function handleEditText(txt) {
  const editEntry = pendingApprovals.findByPredicate(p => p.status === 'editing');
  if (!editEntry) return false;
  const [eid, ed] = editEntry;
  addEdit(ed.tweet.author, ed.tweet.text, ed.comments, txt, ed.listName);
  postQ.push({ tweet: ed.tweet, comment: txt, listName: ed.listName });
  await tg.send(`✅ Your comment queued! (${postQ.length})`);
  pendingApprovals.delete(eid);
  return true;
}

async function checkApprovals() {
  const updates = await tg.pollUpdates({ timeout: 30 });
  for (const up of updates) {
    try {
      if (up.callback_query) {
        await handleCallback(up);
        continue;
      }
      if (up.message?.text) {
        const txt = up.message.text;
        if (txt.startsWith('/')) {
          await handleCommand(txt);
          continue;
        }
        await handleEditText(txt);
      }
    } catch (e) {
      console.error('TG handler error:', e.message);
    }
  }
}

// ─── DAILY REPORT ───
async function sendDailyReport() {
  const l = loadLogs();
  const fb = loadFeedback();
  const today = new Date().toISOString().split('T')[0];
  const s = l.dailyStats[today] || { commentsPosted: 0, tweetsFound: 0, commentsRejected: 0 };
  let rpt = `📊 <b>Daily Report — ${today}</b>\n\n`;
  rpt += `🐦 Tweets: ${s.tweetsFound}\n✅ Posted: ${s.commentsPosted}\n❌ Skipped: ${s.commentsRejected}\n`;
  const ta = fb.approvals.filter(a => a.date.startsWith(today));
  if (ta.length > 0) {
    const oc = {};
    ta.forEach(a => { oc[a.chosenOption] = (oc[a.chosenOption] || 0) + 1; });
    const types = { A: 'One-liner', B: 'Question', C: 'Experience', D: 'Wild card', E: 'Nuance' };
    rpt += '\n📈 <b>Picks:</b>\n';
    Object.entries(oc).sort((a, b) => b[1] - a[1]).forEach(([o, c]) => {
      rpt += `${o} (${types[o] || o}): ${c}\n`;
    });
  }
  const tr = fb.rejections.filter(r => r.date.startsWith(today));
  if (tr.length > 0) {
    const rc = {};
    tr.forEach(r => { rc[r.reason] = (rc[r.reason] || 0) + 1; });
    rpt += '\n🚫 <b>Skips:</b>\n';
    Object.entries(rc).forEach(([r, c]) => { rpt += `${r}: ${c}\n`; });
  }
  rpt += `\n📚 All-time: ${fb.approvals.length} approved, ${fb.rejections.length} rejected, ${fb.edits.length} edits`;
  await tg.send(rpt);
}

// ─── MAIN ───
async function main() {
  console.log('X Comment Agent v4 starting...');

  const config = loadJSON(CONFIG_PATH, null);
  if (!config) { console.error('No config'); process.exit(1); }
  const gp = loadText(PROMPT_PATH);
  if (!gp) { console.error('No prompt'); process.exit(1); }

  const seen = loadSet(SEEN_PATH);
  const fb = loadFeedback();
  const state = loadState();

  const { browser, page } = await launchBrowser({ sessionPath: SESSION_PATH });

  console.log('Verifying X login...');
  if (!(await verifyLogin(page))) {
    await tg.send('X session expired. Re-export cookies.');
    await browser.close();
    process.exit(1);
  }
  console.log('Logged in!');

  pendingApprovals.gc(PENDING_TTL_MS);
  pendingRej.gc(PENDING_TTL_MS);

  await tg.send(
    '🤖 <b>X Agent v4 online!</b>\n\n' +
    `• Identity: @${ME.username}\n` +
    '• 5 options (A-E)\n' +
    `• Learning (${fb.approvals.length} approved, ${fb.rejections.length} rejected)\n` +
    `• ${config.lists.length} list(s)\n` +
    `• Tweet window: ${state.maxTweetAgeMin} min\n` +
    `• State: ${state.paused ? 'Paused' : 'Running'}\n` +
    '• Random likes + batched posting\n\n' +
    'Type /help to see all commands.'
  );

  // Schedule daily report at 11 PM
  const sr = () => {
    const n = new Date();
    const r = new Date();
    r.setHours(23, 0, 0, 0);
    if (r <= n) r.setDate(r.getDate() + 1);
    setTimeout(async () => { await sendDailyReport(); sr(); }, r - n);
  };
  sr();

  while (true) {
    try {
      const currentState = loadState();

      if (!currentState.paused) {
        const maxAge = currentState.maxTweetAgeMin * 60 * 1000;

        for (const list of config.lists) {
          const tweets = await scrapeList(page, list.url);
          console.log(`Found ${tweets.length} in "${list.name}"`);

          for (const tw of tweets) {
            if (seen.has(tw.tweetUrl)) continue;
            if (tw.time) {
              const age = Date.now() - new Date(tw.time).getTime();
              if (age > maxAge) { seen.add(tw.tweetUrl); continue; }
            }
            if (tw.author.toLowerCase() === ME.usernameLC) {
              seen.add(tw.tweetUrl);
              continue;
            }

            console.log(`New: @${tw.author}`);
            await randomLike(page, tw.tweetUrl, 0.4);
            const comments = await generateComments(tw.text, tw.author, list.strategy, gp);
            if (comments && comments.length > 0) {
              await requestApproval(tw, comments, list.name);
              seen.add(tw.tweetUrl);
              saveSet(SEEN_PATH, seen);
            } else {
              console.log(`No comments generated for @${tw.author} — will retry next cycle`);
            }
            await page.waitForTimeout(2000 + Math.random() * 3000);
          }
        }
      } else {
        console.log('Paused. Skipping list check.');
      }

      await processPostQ(page);

      // Frequent approval checks
      for (let i = 0; i < 5; i++) {
        await new Promise(r => setTimeout(r, CHECK_MS / 5));
        await checkApprovals();
        await processPostQ(page);
      }

      pendingApprovals.gc(PENDING_TTL_MS);
      pendingRej.gc(PENDING_TTL_MS);
    } catch (e) {
      console.error('Error:', e.message);
      await tg.send(`Error: ${e.message}`);
      await page.waitForTimeout(30000);
    }
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
