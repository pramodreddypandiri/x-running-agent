require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs');

// ─── PATHS ───
const SESSION_PATH = process.env.SESSION_PATH || "./x-session.json";
const LOG_PATH = "./data/comment-logs.json";
const STATE_PATH = "./data/comment-state.json";

// ─── CONFIG ───
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;
const X_USERNAME = (process.env.X_USERNAME || 'your_username').toLowerCase();

// ─── SAFETY LIMITS ───
const MAX_PER_BATCH = 15;           // max comments per /comment command
const DELAY_BETWEEN_MS_MIN = 15000; // 15s min between comments
const DELAY_BETWEEN_MS_MAX = 45000; // 45s max between comments
const MAX_PER_DAY = 60;             // total daily limit across all batches
const SKIP_OWN_TWEETS = true;

// ─── HELPERS ───
function loadJSON(p, fb) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } }
function saveJSON(p, d) { fs.writeFileSync(p, JSON.stringify(d, null, 2)); }

function loadLogs() { return loadJSON(LOG_PATH, { batches: [], daily: {} }); }
function saveLogs(l) { saveJSON(LOG_PATH, l); }

function loadState() { return loadJSON(STATE_PATH, { paused: false }); }
function saveState(s) { saveJSON(STATE_PATH, s); }

function getDayCount() {
  const logs = loadLogs();
  const dayKey = new Date().toISOString().split('T')[0];
  return logs.daily[dayKey] || 0;
}

function recordBatch(count, commentText) {
  const logs = loadLogs();
  const dayKey = new Date().toISOString().split('T')[0];
  logs.daily[dayKey] = (logs.daily[dayKey] || 0) + count;
  logs.batches.push({ time: new Date().toISOString(), count, comment: commentText.substring(0, 100) });
  if (logs.batches.length > 100) logs.batches = logs.batches.slice(-100);
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

async function editTG(msgId, text) {
  await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/editMessageText', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TG_CHAT, message_id: msgId, text, parse_mode: 'HTML' })
  });
}

async function answerCB(id) {
  await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/answerCallbackQuery', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ callback_query_id: id })
  });
}

// ─── SCRAPE HOME TIMELINE ───
async function scrapeTimeline(page) {
  await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);

  // Scroll a bit to load more tweets
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.scrollBy(0, 800));
    await page.waitForTimeout(1500);
  }

  return await page.evaluate((myUsername) => {
    const els = document.querySelectorAll('article[data-testid="tweet"]');
    const res = [];
    const seenAuthors = new Set();

    els.forEach(el => {
      try {
        // Skip retweets
        const sc = el.querySelector('[data-testid="socialContext"]');
        if (sc && sc.textContent.includes('reposted')) return;

        // Skip quote tweets
        const qt = el.querySelector('[data-testid="quoteTweet"]');
        if (qt) return;

        const ae = el.querySelector('div[data-testid="User-Name"] a');
        const author = ae ? ae.getAttribute('href').replace('/', '') : 'unknown';

        // Skip own tweets
        if (author.toLowerCase() === myUsername) return;

        // One tweet per author (their latest)
        if (seenAuthors.has(author.toLowerCase())) return;
        seenAuthors.add(author.toLowerCase());

        const te = el.querySelector('div[data-testid="tweetText"]');
        const text = te ? te.innerText : '';
        const ti = el.querySelector('time');
        const time = ti ? ti.getAttribute('datetime') : null;

        let url = '';
        el.querySelectorAll('a[href*="/status/"]').forEach(l => {
          const h = l.getAttribute('href');
          if (h && h.match(/\/status\/\d+$/)) url = 'https://x.com' + h;
        });

        if (text && url) res.push({ author, text: text.substring(0, 200), time, tweetUrl: url });
      } catch (e) {}
    });
    return res;
  }, X_USERNAME);
}

// ─── SCRAPE SPECIFIC LIST ───
async function scrapeList(page, listUrl) {
  await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);

  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.scrollBy(0, 800));
    await page.waitForTimeout(1500);
  }

  return await page.evaluate((myUsername) => {
    const els = document.querySelectorAll('article[data-testid="tweet"]');
    const res = [];
    const seenAuthors = new Set();

    els.forEach(el => {
      try {
        const sc = el.querySelector('[data-testid="socialContext"]');
        if (sc && sc.textContent.includes('reposted')) return;
        const qt = el.querySelector('[data-testid="quoteTweet"]');
        if (qt) return;

        const ae = el.querySelector('div[data-testid="User-Name"] a');
        const author = ae ? ae.getAttribute('href').replace('/', '') : 'unknown';
        if (author.toLowerCase() === myUsername) return;
        if (seenAuthors.has(author.toLowerCase())) return;
        seenAuthors.add(author.toLowerCase());

        const te = el.querySelector('div[data-testid="tweetText"]');
        const text = te ? te.innerText : '';
        const ti = el.querySelector('time');
        const time = ti ? ti.getAttribute('datetime') : null;

        let url = '';
        el.querySelectorAll('a[href*="/status/"]').forEach(l => {
          const h = l.getAttribute('href');
          if (h && h.match(/\/status\/\d+$/)) url = 'https://x.com' + h;
        });

        if (text && url) res.push({ author, text: text.substring(0, 200), time, tweetUrl: url });
      } catch (e) {}
    });
    return res;
  }, X_USERNAME);
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

// ─── EXECUTE MASS COMMENT ───
async function executeMassComment(page, commentText, source, statusMsgId) {
  const dayCount = getDayCount();
  if (dayCount >= MAX_PER_DAY) {
    await editTG(statusMsgId, '❌ Daily limit reached (' + MAX_PER_DAY + '). Try tomorrow.');
    return;
  }

  const remaining = Math.min(MAX_PER_BATCH, MAX_PER_DAY - dayCount);

  // Scrape tweets
  let tweets;
  if (source && source.startsWith('https://')) {
    await editTG(statusMsgId, '🔍 Scraping list...');
    tweets = await scrapeList(page, source);
  } else {
    await editTG(statusMsgId, '🔍 Scraping home timeline...');
    tweets = await scrapeTimeline(page);
  }

  if (tweets.length === 0) {
    await editTG(statusMsgId, '❌ No tweets found to comment on.');
    return;
  }

  const target = tweets.slice(0, remaining);
  await editTG(statusMsgId,
    '🚀 Starting mass comment on <b>' + target.length + '</b> tweets\n\n' +
    '💬 "' + commentText.substring(0, 100) + '"\n\n' +
    'Progress: 0/' + target.length
  );

  let posted = 0;
  let failed = 0;
  const results = [];

  for (const tw of target) {
    try {
      // Random delay between comments
      const delay = DELAY_BETWEEN_MS_MIN + Math.random() * (DELAY_BETWEEN_MS_MAX - DELAY_BETWEEN_MS_MIN);
      if (posted > 0) {
        await page.waitForTimeout(delay);
      }

      await postComment(page, tw.tweetUrl, commentText);
      posted++;
      results.push({ author: tw.author, url: tw.tweetUrl, ok: true });

      // Update progress
      await editTG(statusMsgId,
        '🚀 Mass commenting...\n\n' +
        '💬 "' + commentText.substring(0, 80) + '"\n\n' +
        'Progress: ' + posted + '/' + target.length + ' ✅\n' +
        (failed > 0 ? 'Failed: ' + failed + ' ❌\n' : '') +
        'Latest: @' + tw.author
      );

      console.log('✅ [' + posted + '/' + target.length + '] Commented on @' + tw.author);
    } catch (e) {
      failed++;
      results.push({ author: tw.author, url: tw.tweetUrl, ok: false, error: e.message });
      console.log('❌ Failed on @' + tw.author + ': ' + e.message.substring(0, 80));
    }
  }

  // Record and send final report
  recordBatch(posted, commentText);

  let report = '✅ <b>Mass comment complete!</b>\n\n';
  report += '💬 "' + commentText.substring(0, 100) + '"\n\n';
  report += '📊 Posted: ' + posted + ' | Failed: ' + failed + '\n';
  report += '📅 Daily total: ' + (getDayCount()) + '/' + MAX_PER_DAY + '\n\n';
  if (results.length > 0) {
    report += '<b>Commented on:</b>\n';
    results.forEach(r => {
      report += (r.ok ? '✅' : '❌') + ' @' + r.author + '\n';
    });
  }
  await editTG(statusMsgId, report);
}

// ─── MAIN ───
let tgOff = 0;
let pageRef = null;
let busy = false; // prevent overlapping commands

async function main() {
  console.log('💬 Comment Bot starting...');
  if (!TG_TOKEN || !TG_CHAT) { console.error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID'); process.exit(1); }

  // Ensure data dir
  if (!fs.existsSync('./data')) fs.mkdirSync('./data');

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu']
  });
  const ctx = await browser.newContext({
    storageState: SESSION_PATH,
    viewport: { width: 1280, height: 720 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await ctx.newPage();
  pageRef = page;

  // Verify login
  console.log('Verifying login...');
  await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);
  if ((await page.url()).includes('/login')) {
    await sendTG('❌ X session expired. Run setup-cookies.');
    process.exit(1);
  }
  console.log('Logged in!');

  await sendTG(
    '💬 <b>Comment Bot online!</b>\n\n' +
    '<b>Commands:</b>\n' +
    '/comment &lt;text&gt; — Mass comment on timeline\n' +
    '/commentlist &lt;url&gt; &lt;text&gt; — Comment on a specific list\n' +
    '/commentstop — Cancel current batch\n' +
    '/commentstats — View stats\n' +
    '/commenthelp — Show this message\n\n' +
    '⚠️ Limits: ' + MAX_PER_BATCH + '/batch, ' + MAX_PER_DAY + '/day\n' +
    'Delay: ' + Math.round(DELAY_BETWEEN_MS_MIN / 1000) + '-' + Math.round(DELAY_BETWEEN_MS_MAX / 1000) + 's between comments'
  );

  // Load config for list shortcuts
  let config = {};
  try { config = JSON.parse(fs.readFileSync('./config.json', 'utf8')); } catch {}

  // Poll loop
  while (true) {
    try {
      const r = await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/getUpdates?offset=' + tgOff + '&timeout=5');
      const u = await r.json();
      if (!u.ok || !u.result) { await new Promise(r => setTimeout(r, 2000)); continue; }

      for (const up of u.result) {
        tgOff = up.update_id + 1;

        // Handle callback buttons
        if (up.callback_query) {
          const d = up.callback_query.data;
          await answerCB(up.callback_query.id);

          if (d === 'comment_stop') {
            busy = false;
            await sendTG('⏹ Batch cancelled.');
          }
          continue;
        }

        if (!up.message || !up.message.text) continue;
        const txt = up.message.text.trim();
        const cmd = txt.toLowerCase();

        // /comment <text> — mass comment on home timeline
        if (cmd.startsWith('/comment ') && !cmd.startsWith('/commentlist') && !cmd.startsWith('/commentstop') && !cmd.startsWith('/commentstats') && !cmd.startsWith('/commenthelp')) {
          const commentText = txt.substring('/comment '.length).trim();
          if (!commentText) {
            await sendTG('❌ Usage: /comment &lt;your comment text&gt;');
            continue;
          }
          if (busy) {
            await sendTG('⏳ Already running a batch. Wait or /commentstop.');
            continue;
          }
          busy = true;

          const statusMsg = await sendTG('⏳ Starting mass comment...\n\n💬 "' + commentText.substring(0, 100) + '"');
          const statusMsgId = statusMsg.result && statusMsg.result.message_id;

          try {
            await executeMassComment(page, commentText, null, statusMsgId);
          } catch (e) {
            console.error('Batch error:', e.message);
            await sendTG('❌ Batch failed: ' + e.message.substring(0, 100));
          }
          busy = false;
        }

        // /commentlist <url> <text> — comment on a specific list
        else if (cmd.startsWith('/commentlist ')) {
          const parts = txt.substring('/commentlist '.length).trim();
          const spaceIdx = parts.indexOf(' ');
          if (spaceIdx === -1) {
            // Check if it's a list name shortcut
            let msg = '❌ Usage: /commentlist &lt;list_url&gt; &lt;comment text&gt;\n\n';
            if (config.lists && config.lists.length > 0) {
              msg += '<b>Available lists:</b>\n';
              config.lists.forEach(l => { msg += '• ' + l.name + ': ' + l.url + '\n'; });
            }
            await sendTG(msg);
            continue;
          }

          const listUrl = parts.substring(0, spaceIdx).trim();
          const commentText = parts.substring(spaceIdx + 1).trim();

          // Allow list name shortcuts from config
          let resolvedUrl = listUrl;
          if (!listUrl.startsWith('https://') && config.lists) {
            const match = config.lists.find(l => l.name.toLowerCase() === listUrl.toLowerCase());
            if (match) resolvedUrl = match.url;
            else {
              await sendTG('❌ Unknown list "' + listUrl + '". Use a URL or list name from config.');
              continue;
            }
          }

          if (busy) {
            await sendTG('⏳ Already running a batch. Wait or /commentstop.');
            continue;
          }
          busy = true;

          const statusMsg = await sendTG('⏳ Starting list comment...\n\n📋 ' + resolvedUrl + '\n💬 "' + commentText.substring(0, 80) + '"');
          const statusMsgId = statusMsg.result && statusMsg.result.message_id;

          try {
            await executeMassComment(page, commentText, resolvedUrl, statusMsgId);
          } catch (e) {
            console.error('Batch error:', e.message);
            await sendTG('❌ Batch failed: ' + e.message.substring(0, 100));
          }
          busy = false;
        }

        // /commentstop
        else if (cmd === '/commentstop') {
          if (busy) {
            busy = false;
            await sendTG('⏹ Stopping after current comment finishes...');
          } else {
            await sendTG('ℹ️ No batch is running.');
          }
        }

        // /commentstats
        else if (cmd === '/commentstats') {
          const logs = loadLogs();
          const dayKey = new Date().toISOString().split('T')[0];
          const dayCount = logs.daily[dayKey] || 0;
          let msg = '📊 <b>Comment Bot Stats</b>\n\n';
          msg += 'Today: ' + dayCount + '/' + MAX_PER_DAY + '\n';
          msg += 'Total batches: ' + logs.batches.length + '\n\n';
          if (logs.batches.length > 0) {
            msg += '<b>Recent batches:</b>\n';
            logs.batches.slice(-5).forEach(b => {
              msg += '• ' + b.time.substring(0, 16) + ' — ' + b.count + ' comments: "' + b.comment.substring(0, 40) + '"\n';
            });
          }
          await sendTG(msg);
        }

        // /commenthelp
        else if (cmd === '/commenthelp') {
          await sendTG(
            '💬 <b>Comment Bot Commands</b>\n\n' +
            '/comment &lt;text&gt; — Mass comment on home timeline\n' +
            '/commentlist &lt;url|name&gt; &lt;text&gt; — Comment on a specific list\n' +
            '/commentstop — Cancel running batch\n' +
            '/commentstats — View stats\n' +
            '/commenthelp — This message\n\n' +
            '<b>Examples:</b>\n' +
            '<code>/comment Great thread! 🔥</code>\n' +
            '<code>/commentlist Whales Interesting take!</code>\n' +
            '<code>/commentlist https://x.com/i/lists/123 Nice!</code>'
          );
        }
      }
    } catch (e) {
      console.error('Poll error:', e.message);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
