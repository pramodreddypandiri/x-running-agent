require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs');

// ─── PATHS ───
const SESSION_PATH = process.env.SESSION_PATH || "./x-session.json";
const PROMPT_PATH = process.env.WHALE_PROMPT_PATH || "./prompts/whale-prompt.txt";
const FEEDBACK_PATH = "./data/feedback.json";
const WHALE_STATE_PATH = "./data/whale-state.json";
const WHALE_LOG_PATH = "./data/whale-logs.json";
const SEEN_PATH = "./data/whale-seen.json";
const WATCH_PATH = "./data/whale-watch.json";

// ─── CONFIG ───
const LIST_URL = process.env.WHALE_LIST_URL || 'https://x.com/i/lists/YOUR_LIST_ID';
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;
const API_KEY = process.env.ANTHROPIC_API_KEY;

// ─── AUTO-REPLY CONFIG ───
const REPLY_CHECK_INTERVAL = 5 * 60 * 1000; // check for replies every 5 min
const REPLY_WATCH_DURATION = 2 * 60 * 60 * 1000; // stop watching after 2 hours
const MAX_REPLIES_PER_THREAD = 1; // only reply once per thread
const REPLY_DELAY_MIN = 20; // seconds before replying
const REPLY_DELAY_MAX = 60;

// ─── SAFETY LIMITS ───
const MAX_PER_HOUR = 15;
const MAX_PER_DAY = 40;
const MIN_GAP_MS = 3 * 60 * 1000; // 3 min between comments
const BURST_LIMIT = 5; // max 5 in 30 min
const BURST_WINDOW_MS = 30 * 60 * 1000;
const BURST_COOLDOWN_MS = 15 * 60 * 1000;
const MAX_TWEET_AGE_MS = 10 * 60 * 1000; // 10 min
const SAME_AUTHOR_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 hours
const RANDOM_SKIP_RATE = 0.2; // skip 20% randomly
const PRE_COMMENT_DELAY_MIN = 30; // seconds
const PRE_COMMENT_DELAY_MAX = 90;
const CHECK_INTERVAL_MS = 60 * 1000; // check list every 60s

// ─── HELPERS ───
function loadJSON(p, fb) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } }
function saveJSON(p, d) { fs.writeFileSync(p, JSON.stringify(d, null, 2)); }
function loadText(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } }

function loadState() { return loadJSON(WHALE_STATE_PATH, { paused: false }); }
function saveState(s) { saveJSON(WHALE_STATE_PATH, s); }

function loadLogs() { return loadJSON(WHALE_LOG_PATH, { comments: [], hourly: {}, daily: {} }); }
function saveLogs(l) { saveJSON(WHALE_LOG_PATH, l); }

function loadSeen() { try { return new Set(JSON.parse(fs.readFileSync(SEEN_PATH, 'utf8'))); } catch { return new Set(); } }
function saveSeen(s) { fs.writeFileSync(SEEN_PATH, JSON.stringify([...s])); }

function loadFeedback() { return loadJSON(FEEDBACK_PATH, { approvals: [], rejections: [], edits: [] }); }

// ─── WHALE FEEDBACK ───
const WHALE_FB_PATH = './data/whale-feedback.json';
function loadWhaleFeedback() { return loadJSON(WHALE_FB_PATH, { feedback: [] }); }
function saveWhaleFeedback(f) { saveJSON(WHALE_FB_PATH, f); }
function addWhaleFeedback(author, tweetUrl, comment, feedbackText, deleted) {
  const fb = loadWhaleFeedback();
  fb.feedback.push({ date: new Date().toISOString(), author, tweetUrl, comment, feedback: feedbackText, deleted });
  saveWhaleFeedback(fb);
}

// Pending feedback/delete actions
const pendingActions = new Map();

// ─── RATE LIMITING ───
function canComment(logs) {
  const now = Date.now();
  const hourKey = new Date().toISOString().substring(0, 13); // "2026-03-09T14"
  const dayKey = new Date().toISOString().split('T')[0]; // "2026-03-09"
  
  const hourCount = logs.hourly[hourKey] || 0;
  const dayCount = logs.daily[dayKey] || 0;
  
  if (hourCount >= MAX_PER_HOUR) return { ok: false, reason: 'Hourly limit (' + MAX_PER_HOUR + ')' };
  if (dayCount >= MAX_PER_DAY) return { ok: false, reason: 'Daily limit (' + MAX_PER_DAY + ')' };
  
  // Check minimum gap
  const recent = logs.comments.filter(c => now - new Date(c.time).getTime() < MIN_GAP_MS);
  if (recent.length > 0) return { ok: false, reason: 'Too soon (3 min gap)' };
  
  // Check burst
  const burst = logs.comments.filter(c => now - new Date(c.time).getTime() < BURST_WINDOW_MS);
  if (burst.length >= BURST_LIMIT) {
    const oldestBurst = new Date(burst[0].time).getTime();
    const cooldownEnd = oldestBurst + BURST_WINDOW_MS + BURST_COOLDOWN_MS;
    if (now < cooldownEnd) return { ok: false, reason: 'Burst cooldown (' + Math.round((cooldownEnd - now) / 60000) + ' min left)' };
  }
  
  return { ok: true };
}

function canCommentOnAuthor(logs, author) {
  const now = Date.now();
  const recent = logs.comments.find(c => 
    c.author === author && (now - new Date(c.time).getTime()) < SAME_AUTHOR_COOLDOWN_MS
  );
  return !recent;
}

function recordComment(logs, author, tweetUrl, comment) {
  const now = new Date();
  const hourKey = now.toISOString().substring(0, 13);
  const dayKey = now.toISOString().split('T')[0];
  
  logs.comments.push({ time: now.toISOString(), author, tweetUrl, comment: comment.substring(0, 100) });
  logs.hourly[hourKey] = (logs.hourly[hourKey] || 0) + 1;
  logs.daily[dayKey] = (logs.daily[dayKey] || 0) + 1;
  
  // Keep only last 200 comments in memory
  if (logs.comments.length > 200) logs.comments = logs.comments.slice(-200);
  
  saveLogs(logs);
}

// ─── TELEGRAM ───
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

let tgOff = 0;
let pageRef = null; // will be set in main()

async function deleteComment(page, tweetUrl) {
  try {
    await page.goto(tweetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
    // Find our reply (from @PramodReddy1606)
    const articles = await page.$$('article[data-testid="tweet"]');
    for (const article of articles) {
      const nameEl = await article.$('div[data-testid="User-Name"]');
      if (!nameEl) continue;
      const nameText = await nameEl.textContent();
      if (nameText && nameText.includes((process.env.X_USERNAME || 'your_username'))) {
        // Click the three dots on our reply
        const moreBtn = await article.$('[data-testid="caret"]');
        if (moreBtn) {
          await moreBtn.click();
          await page.waitForTimeout(1000);
          // Click Delete
          const menuItems = await page.$$('[role="menuitem"]');
          for (const item of menuItems) {
            const t = await item.textContent();
            if (t && t.includes('Delete')) { await item.click(); break; }
          }
          await page.waitForTimeout(1000);
          // Confirm delete
          const confirmBtn = await page.$('[data-testid="confirmationSheetConfirm"]');
          if (confirmBtn) await confirmBtn.click();
          await page.waitForTimeout(1000);
          return true;
        }
      }
    }
    return false;
  } catch(e) { console.error('Delete error:', e.message); return false; }
}

async function checkTGCommands() {
  try {
    const r = await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/getUpdates?offset=' + tgOff + '&timeout=1');
    const u = await r.json();
    if (!u.ok || !u.result) return;
    
    for (const up of u.result) {
      tgOff = up.update_id + 1;

      // Handle callback buttons (delete, feedback)
      if (up.callback_query) {
        const d = up.callback_query.data;
        const parts = d.split('_');
        const action = parts[0]; // wok, wfb, wdel
        const id = parts.slice(1).join('_');
        await answerCB(up.callback_query.id);

        const pending = pendingActions.get(id);
        if (!pending) continue;

        if (action === 'wok') {
          // Satisfied, no action needed
          pendingActions.delete(id);
        }
        else if (action === 'wfb') {
          // Wants to give feedback (keep comment)
          pending.waitingFeedback = true;
          pending.deleteAfter = false;
          await sendTG('💬 Type your feedback for this comment:');
        }
        else if (action === 'wdel') {
          // Delete + ask for feedback
          pending.waitingFeedback = true;
          pending.deleteAfter = true;
          await sendTG('🗑 Deleting comment... Type feedback (or send "." to skip):');
          // Delete the comment now
          if (pageRef) {
            const deleted = await deleteComment(pageRef, pending.tweetUrl);
            if (deleted) console.log('Deleted comment on @' + pending.author);
            else console.log('Failed to delete comment on @' + pending.author);
          }
        }
        continue;
      }

      // Handle text messages
      if (up.message && up.message.text) {
        const txt = up.message.text.trim();

        // Check if someone is giving feedback
        const fbEntry = [...pendingActions.entries()].find(([k, p]) => p.waitingFeedback);
        if (fbEntry && !txt.startsWith('/')) {
          const [fbId, fbData] = fbEntry;
          const feedbackText = txt === '.' ? '' : txt;
          addWhaleFeedback(fbData.author, fbData.tweetUrl, fbData.comment, feedbackText, fbData.deleteAfter);
          if (feedbackText) {
            await sendTG('📝 Feedback saved' + (fbData.deleteAfter ? ' + comment deleted' : '') + '. Learning.');
          } else {
            await sendTG('🗑 Comment deleted.');
          }
          pendingActions.delete(fbId);
          continue;
        }

        // Handle commands
        const cmd = txt.toLowerCase();
      
        if (cmd === '/wstop') {
        const state = loadState();
        state.paused = true;
        saveState(state);
        await sendTG('⏸ <b>Whale bot paused.</b> Type /wstart to resume.');
      }
      else if (txt === '/wstart') {
        const state = loadState();
        state.paused = false;
        saveState(state);
        await sendTG('▶️ <b>Whale bot resumed!</b>');
      }
      else if (txt === '/wstats') {
        const logs = loadLogs();
        const dayKey = new Date().toISOString().split('T')[0];
        const hourKey = new Date().toISOString().substring(0, 13);
        const state = loadState();
        const dayCount = logs.daily[dayKey] || 0;
        const hourCount = logs.hourly[hourKey] || 0;
        const total = logs.comments.length;
        
        // Top authors
        const authorCounts = {};
        logs.comments.slice(-50).forEach(c => { authorCounts[c.author] = (authorCounts[c.author] || 0) + 1; });
        const topAuthors = Object.entries(authorCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);
        
        let msg = '🐋 <b>Whale Bot Stats</b>\n\n';
        msg += 'State: ' + (state.paused ? '⏸ Paused' : '▶️ Running') + '\n';
        msg += 'Today: ' + dayCount + '/' + MAX_PER_DAY + ' comments\n';
        msg += 'This hour: ' + hourCount + '/' + MAX_PER_HOUR + '\n';
        msg += 'All-time: ' + total + '\n\n';
        if (topAuthors.length > 0) {
          msg += '<b>Most commented on:</b>\n';
          topAuthors.forEach(([a, c]) => { msg += '@' + a + ': ' + c + '\n'; });
        }
        await sendTG(msg);
      }
      else if (cmd === '/whelp') {
        await sendTG('🐋 <b>Whale Bot Commands</b>\n\n/wstart — Resume\n/wstop — Pause\n/wstats — Stats\n/wfeedback — Feedback stats\n/work — View current work context\n/work &lt;text&gt; — Add to current work\n/work set &lt;text&gt; — Replace current work\n/whelp — This message');
      }
      else if (cmd === '/work') {
        const currentWork = loadText('./prompts/current-work.txt').replace(/^#.*$/gm, '').trim();
        await sendTG('📋 <b>Current work context:</b>\n\n' + (currentWork || '(empty)') + '\n\n<i>To update, send:</i>\n/work set your new focus here');
      }
      else if (cmd.startsWith('/work set ') || cmd.startsWith('/work ')) {
        const newWork = txt.substring(txt.indexOf(' ', 6) !== -1 ? txt.indexOf(' ', 6) + 1 : 6).trim();
        if (txt.toLowerCase().startsWith('/work set ')) {
          // Full replace
          const header = '# PRAMOD\'S CURRENT WORK & FOCUS\n# Update this every few days to keep posts and comments authentic.\n# The bots inject this into prompts as {CURRENT_WORK}.\n# You can also update via Telegram: /work <your current focus>\n\n';
          fs.writeFileSync('./prompts/current-work.txt', header + newWork + '\n');
          await sendTG('✅ <b>Current work updated!</b>\n\n' + newWork);
        } else {
          // Append
          fs.appendFileSync('./prompts/current-work.txt', '\n- ' + txt.substring(6).trim() + '\n');
          await sendTG('✅ <b>Added to current work:</b>\n- ' + txt.substring(6).trim());
        }
      }
      else if (cmd === '/wfeedback') {
        const wfb = loadWhaleFeedback();
        let msg = '📝 <b>Whale Feedback</b>\n\nTotal: ' + wfb.feedback.length + '\nDeleted: ' + wfb.feedback.filter(f => f.deleted).length + '\nKept with notes: ' + wfb.feedback.filter(f => !f.deleted && f.feedback).length + '\n';
        if (wfb.feedback.length > 0) { msg += '\n<b>Recent:</b>\n'; wfb.feedback.slice(-5).forEach(f => { msg += '• @' + f.author + (f.deleted ? ' 🗑' : '') + ': ' + (f.feedback || '-').substring(0, 60) + '\n'; }); }
        await sendTG(msg);
      }
      }
    }
  } catch(e) {}
}

// ─── CLAUDE COMMENT GENERATION ───
async function generateComment(tweetText, tweetAuthor, gp) {
  const fb = loadFeedback();
  const wfb = loadWhaleFeedback();
  let fbCtx = '';
  const ra = fb.approvals.slice(-10);
  if (ra.length > 0) {
    fbCtx += 'COMMENTS PRAMOD LIKED:\n';
    ra.forEach(a => { fbCtx += '- "' + a.commentText + '"\n'; });
  }
  const re = fb.edits.slice(-5);
  if (re.length > 0) {
    fbCtx += 'PRAMOD REWRITES:\n';
    re.forEach(e => { fbCtx += '- "' + e.editedComment + '"\n'; });
  }
  // Add whale-specific feedback
  const wfbRecent = wfb.feedback.filter(f => f.feedback).slice(-10);
  if (wfbRecent.length > 0) {
    fbCtx += '\nWHALE COMMENT FEEDBACK FROM PRAMOD:\n';
    wfbRecent.forEach(f => {
      fbCtx += '- ' + (f.deleted ? 'DELETED' : 'KEPT') + ' comment on @' + f.author + ': "' + f.comment.substring(0, 60) + '" → Feedback: "' + f.feedback + '"\n';
    });
  }
  
  const strategy = 'Comment as a peer entrepreneur on a whale account. Your goal is VISIBILITY. Write the comment that gets the most likes and replies. Be sharp, genuine, add unexpected value or a contrarian take. Short sentences. No fluff. Sound like you\'re texting a friend who happens to be brilliant. The best comments on whale tweets are either: (1) adding a data point nobody mentioned, (2) a genuinely funny one-liner, (3) a real experience that adds nuance, or (4) a smart question that makes people think.';
  
  const currentWork = loadText('./prompts/current-work.txt').replace(/^#.*$/gm, '').trim();
  const prompt = gp
    .replace('{FEEDBACK_CONTEXT}', fbCtx || 'No feedback yet.')
    .replace('{VIRAL_PATTERNS}', 'Focus on being early and sharp.')
    .replace('{LIST_STRATEGY}', strategy)
    .replace('{AUTHOR}', tweetAuthor)
    .replace('{TWEET_TEXT}', tweetText)
    .replace('{CURRENT_WORK}', currentWork || 'No current work context available.');

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 400, messages: [{ role: 'user', content: prompt }] })
    });
    const d = await r.json();
    if (d.content && d.content[0]) {
      const text = d.content[0].text.trim();
      const lines = text.split('\n').filter(l => l.trim());
      // Pick one randomly from options A-E
      const opts = [];
      let cur = '';
      for (const line of lines) {
        if (line.match(/^[A-E]:/)) {
          if (cur) opts.push(cur.trim());
          cur = line.replace(/^[A-E]:\s*/, '').replace(/^["']|["']$/g, '');
        } else if (cur) { cur += ' ' + line.trim(); }
      }
      if (cur) opts.push(cur.trim());
      
      if (opts.length > 0) {
        // Pick randomly but weight toward A (one-liner) and C (experience) for speed
        const weights = [0.3, 0.15, 0.3, 0.15, 0.1];
        let rand = Math.random();
        let pick = 0;
        for (let i = 0; i < weights.length && i < opts.length; i++) {
          rand -= weights[i];
          if (rand <= 0) { pick = i; break; }
        }
        return opts[Math.min(pick, opts.length - 1)];
      }
      return text.split('\n')[0].replace(/^[A-E]:\s*/, '').replace(/^["']|["']$/g, '');
    }
  } catch(e) { console.error('Claude error:', e.message); }
  return null;
}

// ─── SCRAPE LIST ───
async function scrapeList(page) {
  await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);
  await page.evaluate(() => window.scrollBy(0, 500));
  await page.waitForTimeout(2000);
  
  return await page.evaluate(() => {
    const els = document.querySelectorAll('article[data-testid="tweet"]');
    const res = [];
    els.forEach(el => {
      try {
        const sc = el.querySelector('[data-testid="socialContext"]');
        if (sc && sc.textContent.includes('reposted')) return;
        // Skip quote tweets - they contain embedded tweets
        const ia = el.querySelectorAll('article');
        if (ia.length > 1) return;
        // Skip if contains a quoted tweet card
        const qt = el.querySelector('[data-testid="quoteTweet"], [role="link"][tabindex="0"] article, div[data-testid="card.wrapper"]');
        if (qt) return;
        // Skip if the tweet has a "Quote" label or embedded tweet block
        const allDivs = el.querySelectorAll('div[role="link"]');
        for (const d of allDivs) {
          if (d.querySelector('time') && d !== el.closest('div[role="link"]')) return;
        }
        const ae = el.querySelector('div[data-testid="User-Name"] a');
        const author = ae ? ae.getAttribute('href').replace('/', '') : 'unknown';
        const te = el.querySelector('div[data-testid="tweetText"]');
        const text = te ? te.innerText : '';
        const ti = el.querySelector('time');
        const time = ti ? ti.getAttribute('datetime') : null;
        let url = '';
        el.querySelectorAll('a[href*="/status/"]').forEach(l => {
          const h = l.getAttribute('href');
          if (h && h.match(/\/status\/\d+$/)) url = 'https://x.com' + h;
        });
        if (text && url) res.push({ author, text, time, tweetUrl: url });
      } catch(e) {}
    });
    return res;
  });
}

// ─── POST COMMENT ───
async function postComment(page, tweetUrl, commentText) {
  await page.goto(tweetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2000 + Math.random() * 2000);
  const rb = await page.waitForSelector('div[data-testid="tweetTextarea_0"]', { timeout: 10000 });
  await rb.click();
  await page.waitForTimeout(300 + Math.random() * 500);
  await page.keyboard.type(commentText, { delay: 30 + Math.random() * 50 });
  await page.waitForTimeout(800 + Math.random() * 1000);
  const btn = await page.waitForSelector('button[data-testid="tweetButtonInline"]', { timeout: 5000 });
  await btn.click();
  await page.waitForTimeout(2000 + Math.random() * 2000);
  return true;
}

// ─── REPLY WATCHLIST ───
function loadWatchlist() { return loadJSON(WATCH_PATH, []); }
function saveWatchlist(w) { saveJSON(WATCH_PATH, w); }

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
  
  console.log('Checking ' + wl.length + ' watched comments for replies...');
  
  for (const watch of wl) {
    if (watch.repliedTo.length >= MAX_REPLIES_PER_THREAD) continue;
    
    try {
      await page.goto(watch.tweetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2500);
      
      // Find our comment in the replies
      const replies = await page.evaluate((ourUsername) => {
        const articles = document.querySelectorAll('article[data-testid="tweet"]');
        let foundOurs = false;
        const repliesToUs = [];
        
        for (const article of articles) {
          const nameEl = article.querySelector('div[data-testid="User-Name"]');
          if (!nameEl) continue;
          const nameText = nameEl.textContent || '';
          
          if (nameText.includes(ourUsername)) {
            foundOurs = true;
            continue;
          }
          
          // If we found our comment, the next replies might be to us
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
            
            if (replyText && replyAuthor && replyAuthor !== ourUsername) {
              repliesToUs.push({ author: replyAuthor, text: replyText.substring(0, 300), url: replyUrl });
            }
            // Only check the immediate next reply
            break;
          }
        }
        return repliesToUs;
      }, (process.env.X_USERNAME || 'your_username'));
      
      if (replies.length === 0) continue;
      
      for (const reply of replies) {
        // Skip if we already replied to this person in this thread
        if (watch.repliedTo.includes(reply.author)) continue;
        
        console.log('Reply from @' + reply.author + ' on @' + watch.author + ' thread');
        
        // Generate a reply
        const replyComment = await generateReply(watch.ourComment, reply.text, reply.author, watch.author);
        if (!replyComment) continue;
        
        // Delay before replying
        const delay = (REPLY_DELAY_MIN + Math.random() * (REPLY_DELAY_MAX - REPLY_DELAY_MIN)) * 1000;
        console.log('Replying in ' + Math.round(delay / 1000) + 's...');
        await page.waitForTimeout(delay);
        
        // Post the reply
        try {
          if (reply.url) {
            await postComment(page, reply.url, replyComment);
          } else {
            await postComment(page, watch.tweetUrl, replyComment);
          }
          
          // Mark as replied
          watch.repliedTo.push(reply.author);
          saveWatchlist(wl);
          
          console.log('✅ Replied to @' + reply.author);
          await sendTG(
            '🔄 <b>Auto-replied to @' + reply.author + '</b>\n' +
            '(thread with @' + watch.author + ')\n\n' +
            '💬 They said: "' + reply.text.substring(0, 100) + '"\n\n' +
            '↩️ Our reply: ' + replyComment + '\n\n' +
            '🔗 ' + watch.tweetUrl
          );
        } catch(e) {
          console.log('Failed to reply: ' + e.message.substring(0, 80));
        }
      }
      
      await page.waitForTimeout(1000);
    } catch(e) {
      console.log('Watch check error: ' + e.message.substring(0, 80));
    }
  }
}

async function generateReply(ourComment, theirReply, theirUsername, originalAuthor) {
  const prompt = `You are Pramod (@PramodReddy1606). You commented on @${originalAuthor}'s tweet. Now @${theirUsername} replied to your comment. Continue the conversation naturally.

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
- NEVER mention Nalikes, your business, or any numbers
- Vary your formatting (sometimes capitalize, sometimes don't, sometimes use periods, sometimes don't)

Write exactly 1 reply. Just the text, nothing else.`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 150, messages: [{ role: 'user', content: prompt }] })
    });
    const d = await r.json();
    if (d.content && d.content[0]) return d.content[0].text.trim().replace(/^["']|["']$/g, '');
  } catch(e) { console.error('Reply gen error:', e.message); }
  return null;
}

// ─── MAIN ───
async function main() {
  console.log('🐋 Whale Auto-Commenter starting...');
  if (!TG_TOKEN || !TG_CHAT || !API_KEY) { console.error('Missing env'); process.exit(1); }

  const gp = loadText(PROMPT_PATH);
  if (!gp) { console.error('No prompt file'); process.exit(1); }

  const seen = loadSeen();
  const state = loadState();

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'] });
  const ctx = await browser.newContext({ storageState: SESSION_PATH, viewport: { width: 1280, height: 720 }, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' });
  const page = await ctx.newPage();

  console.log('Verifying login...');
  await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);
  if ((await page.url()).includes('/login')) { await sendTG('❌ X session expired.'); process.exit(1); }
  console.log('Logged in!');
  pageRef = page;

  const logs = loadLogs();
  const dayKey = new Date().toISOString().split('T')[0];
  const dayCount = logs.daily[dayKey] || 0;

  await sendTG(
    '🐋 <b>Whale Auto-Commenter online!</b>\n\n' +
    '• Monitoring: ' + LIST_URL.split('/').pop() + '\n' +
    '• Limits: ' + MAX_PER_HOUR + '/hr, ' + MAX_PER_DAY + '/day\n' +
    '• Today so far: ' + dayCount + ' comments\n' +
    '• State: ' + (state.paused ? 'PAUSED' : 'RUNNING') + '\n\n' +
    '/wstop /wstart /wstats /whelp'
  );

  // Main loop
  while (true) {
    try {
      await checkTGCommands();
      const currentState = loadState();

      if (!currentState.paused) {
        const currentLogs = loadLogs();
        const rateCheck = canComment(currentLogs);
        
        if (rateCheck.ok) {
          const tweets = await scrapeList(page);
          console.log('Found ' + tweets.length + ' tweets');

          for (const tw of tweets) {
            if (seen.has(tw.tweetUrl)) continue;
            
            // Only original tweets, not too old
            if (tw.time) {
              const age = Date.now() - new Date(tw.time).getTime();
              if (age > MAX_TWEET_AGE_MS) { seen.add(tw.tweetUrl); continue; }
            }
            
            // Skip own tweets
            if (tw.author.toLowerCase() === (process.env.X_USERNAME || 'your_username')) { seen.add(tw.tweetUrl); continue; }
            
            // Check rate limits again
            const freshLogs = loadLogs();
            const check = canComment(freshLogs);
            if (!check.ok) { console.log('Rate limit: ' + check.reason); break; }
            
            // Check same author cooldown
            if (!canCommentOnAuthor(freshLogs, tw.author)) {
              console.log('Skipping @' + tw.author + ' (commented recently)');
              seen.add(tw.tweetUrl);
              continue;
            }
            
            // Random skip 20%
            if (Math.random() < RANDOM_SKIP_RATE) {
              console.log('Random skip @' + tw.author);
              seen.add(tw.tweetUrl);
              continue;
            }
            
            console.log('New tweet from @' + tw.author);
            
            // Generate comment
            const comment = await generateComment(tw.text, tw.author, gp);
            if (!comment) { console.log('Failed to generate comment'); seen.add(tw.tweetUrl); continue; }
            
            // Human-like delay before posting
            const delay = (PRE_COMMENT_DELAY_MIN + Math.random() * (PRE_COMMENT_DELAY_MAX - PRE_COMMENT_DELAY_MIN)) * 1000;
            console.log('Waiting ' + Math.round(delay / 1000) + 's before posting...');
            await page.waitForTimeout(delay);
            
            // Post comment
            try {
              await postComment(page, tw.tweetUrl, comment);
              recordComment(freshLogs, tw.author, tw.tweetUrl, comment);
              seen.add(tw.tweetUrl);
              saveSeen(seen);
              
              console.log('✅ Posted on @' + tw.author);
              addToWatchlist(tw.tweetUrl, tw.author, comment);
              const commentId = Date.now().toString();
              pendingActions.set(commentId, { author: tw.author, tweetUrl: tw.tweetUrl, comment, waitingFeedback: false, deleteAfter: false });
              await sendTG(
                '🐋 <b>Auto-commented on @' + tw.author + '</b>\n\n' +
                '💬 ' + comment + '\n\n' +
                '🔗 ' + tw.tweetUrl,
                { inline_keyboard: [
                  [{ text: '✅ Good', callback_data: 'wok_' + commentId }, { text: '💬 Feedback', callback_data: 'wfb_' + commentId }, { text: '🗑 Delete', callback_data: 'wdel_' + commentId }]
                ]}
              );
            } catch(e) {
              console.log('Failed to post: ' + e.message);
              await sendTG('⚠️ Failed to comment on @' + tw.author + ': ' + e.message.substring(0, 80));
              seen.add(tw.tweetUrl);
              saveSeen(seen);
            }
            
            // Only one comment per check cycle
            break;
          }
        } else {
          console.log('Rate limited: ' + rateCheck.reason);
        }
      } else {
        console.log('Paused.');
      }

      // Check for replies to our comments every cycle
      if (!currentState.paused) {
        try { await checkForReplies(page); } catch(e) { console.log('Reply check error: ' + e.message.substring(0, 50)); }
      }

      // 2-day reminder to update current work context
      const WORK_REMINDER_INTERVAL = 2 * 24 * 60 * 60 * 1000; // 2 days
      const wState = loadState();
      const lastReminder = wState.lastWorkReminder || 0;
      if (Date.now() - lastReminder > WORK_REMINDER_INTERVAL) {
        const currentWork = loadText('./prompts/current-work.txt').replace(/^#.*$/gm, '').trim();
        await sendTG(
          '🔄 <b>Time to update your current work context!</b>\n\n' +
          '<b>Current:</b>\n' + (currentWork || '(empty)') + '\n\n' +
          'Still accurate? If not, send:\n' +
          '/work set &lt;your updated focus&gt;\n' +
          'Or add with: /work &lt;new thing&gt;'
        );
        wState.lastWorkReminder = Date.now();
        saveState(wState);
      }

      // Wait before next check
      await page.waitForTimeout(CHECK_INTERVAL_MS);
      
    } catch(e) {
      console.error('Error:', e.message);
      await sendTG('⚠️ Whale bot error: ' + e.message.substring(0, 100));
      await page.waitForTimeout(30000);
    }
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
