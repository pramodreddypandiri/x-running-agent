require('dotenv').config();
const fs = require('fs');
const {
  loadJSON, saveJSON,
  resolveTelegramAuth, getIdentity,
  createTelegramClient,
  launchBrowser, verifyLogin,
  scrapeList, scrapeHomeTimeline, postComment,
} = require('./lib');

// ─── PATHS ───
const SESSION_PATH = process.env.SESSION_PATH || './x-session.json';
const LOG_PATH = './data/comment-logs.json';
const STATE_PATH = './data/comment-state.json';
const CONFIG_PATH = process.env.CONFIG_PATH || './config.json';

// ─── CONFIG ───
const { token: TG_TOKEN, chatId: TG_CHAT } = resolveTelegramAuth('comment');
const ME = getIdentity();

// ─── SAFETY LIMITS ───
const MAX_PER_BATCH = 15;
const DELAY_BETWEEN_MS_MIN = 15000;
const DELAY_BETWEEN_MS_MAX = 45000;
const MAX_PER_DAY = 60;

// ─── CLIENTS ───
const tg = createTelegramClient({ token: TG_TOKEN, chatId: TG_CHAT });

// ─── HELPERS ───
const loadLogs = () => loadJSON(LOG_PATH, { batches: [], daily: {} });
const saveLogs = (l) => saveJSON(LOG_PATH, l);
const loadState = () => loadJSON(STATE_PATH, { paused: false });

function getDayCount() {
  const logs = loadLogs();
  const dayKey = new Date().toISOString().split('T')[0];
  return logs.daily[dayKey] || 0;
}

function recordBatch(count, commentText) {
  const logs = loadLogs();
  const dayKey = new Date().toISOString().split('T')[0];
  logs.daily[dayKey] = (logs.daily[dayKey] || 0) + count;
  logs.batches.push({
    time: new Date().toISOString(),
    count,
    comment: commentText.substring(0, 100),
  });
  if (logs.batches.length > 100) logs.batches = logs.batches.slice(-100);
  saveLogs(logs);
}

async function editTG(msgId, text) {
  if (!msgId) return;
  try {
    await tg.editMessage(msgId, text);
  } catch (e) {
    console.error('editTG error:', e.message);
  }
}

// ─── EXECUTE MASS COMMENT ───
let cancelRequested = false;

async function executeMassComment(page, commentText, source, statusMsgId) {
  cancelRequested = false;

  const dayCount = getDayCount();
  if (dayCount >= MAX_PER_DAY) {
    await editTG(statusMsgId, `❌ Daily limit reached (${MAX_PER_DAY}). Try tomorrow.`);
    return;
  }

  const remaining = Math.min(MAX_PER_BATCH, MAX_PER_DAY - dayCount);

  let tweets;
  if (source && source.startsWith('https://')) {
    await editTG(statusMsgId, '🔍 Scraping list...');
    tweets = await scrapeList(page, source);
  } else {
    await editTG(statusMsgId, '🔍 Scraping home timeline...');
    tweets = await scrapeHomeTimeline(page, ME.usernameLC);
  }

  if (tweets.length === 0) {
    await editTG(statusMsgId, '❌ No tweets found to comment on.');
    return;
  }

  const target = tweets.slice(0, remaining);
  await editTG(statusMsgId,
    `🚀 Starting mass comment on <b>${target.length}</b> tweets\n\n` +
    `💬 "${commentText.substring(0, 100)}"\n\n` +
    `Progress: 0/${target.length}`
  );

  let posted = 0;
  let failed = 0;
  const results = [];

  for (const tw of target) {
    if (cancelRequested) {
      console.log('Batch cancelled mid-flight');
      await editTG(statusMsgId, `⏹ Cancelled at ${posted}/${target.length}`);
      break;
    }

    try {
      const delay = DELAY_BETWEEN_MS_MIN + Math.random() * (DELAY_BETWEEN_MS_MAX - DELAY_BETWEEN_MS_MIN);
      if (posted > 0) {
        await page.waitForTimeout(delay);
      }

      await postComment(page, tw.tweetUrl, commentText);
      posted++;
      results.push({ author: tw.author, url: tw.tweetUrl, ok: true });

      await editTG(statusMsgId,
        `🚀 Mass commenting...\n\n` +
        `💬 "${commentText.substring(0, 80)}"\n\n` +
        `Progress: ${posted}/${target.length} ✅\n` +
        (failed > 0 ? `Failed: ${failed} ❌\n` : '') +
        `Latest: @${tw.author}`
      );

      console.log(`✅ [${posted}/${target.length}] Commented on @${tw.author}`);
    } catch (e) {
      failed++;
      results.push({ author: tw.author, url: tw.tweetUrl, ok: false, error: e.message });
      console.log(`❌ Failed on @${tw.author}: ${e.message.substring(0, 80)}`);
    }
  }

  recordBatch(posted, commentText);

  let report = '✅ <b>Mass comment complete!</b>\n\n';
  report += `💬 "${commentText.substring(0, 100)}"\n\n`;
  report += `📊 Posted: ${posted} | Failed: ${failed}\n`;
  report += `📅 Daily total: ${getDayCount()}/${MAX_PER_DAY}\n\n`;
  if (results.length > 0) {
    report += '<b>Commented on:</b>\n';
    results.forEach(r => {
      report += `${r.ok ? '✅' : '❌'} @${r.author}\n`;
    });
  }
  await editTG(statusMsgId, report);
}

// ─── MAIN ───
let pageRef = null;
let busy = false;

async function main() {
  console.log('💬 Comment Bot starting...');

  if (!fs.existsSync('./data')) fs.mkdirSync('./data');

  const { browser, page } = await launchBrowser({ sessionPath: SESSION_PATH });
  pageRef = page;

  console.log('Verifying login...');
  if (!(await verifyLogin(page))) {
    await tg.send('❌ X session expired. Run setup-cookies.');
    await browser.close();
    process.exit(1);
  }
  console.log('Logged in!');

  await tg.send(
    '💬 <b>Comment Bot online!</b>\n\n' +
    `• Identity: @${ME.username}\n` +
    '<b>Commands:</b>\n' +
    '/comment &lt;text&gt; — Mass comment on timeline\n' +
    '/commentlist &lt;url&gt; &lt;text&gt; — Comment on a specific list\n' +
    '/commentstop — Cancel current batch\n' +
    '/commentstats — View stats\n' +
    '/commenthelp — Show this message\n\n' +
    `⚠️ Limits: ${MAX_PER_BATCH}/batch, ${MAX_PER_DAY}/day\n` +
    `Delay: ${Math.round(DELAY_BETWEEN_MS_MIN / 1000)}-${Math.round(DELAY_BETWEEN_MS_MAX / 1000)}s between comments`
  );

  let config = {};
  try { config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch {}

  while (true) {
    try {
      const updates = await tg.pollUpdates({ timeout: 5 });
      for (const up of updates) {
        try {
          if (up.callback_query) {
            const d = up.callback_query.data;
            await tg.answerCallback(up.callback_query.id);
            if (d === 'comment_stop') {
              cancelRequested = true;
              await tg.send('⏹ Batch cancellation requested.');
            }
            continue;
          }

          if (!up.message?.text) continue;
          const txt = up.message.text.trim();
          const cmd = txt.toLowerCase();

          if (cmd.startsWith('/comment ') && !cmd.startsWith('/commentlist') && !cmd.startsWith('/commentstop') && !cmd.startsWith('/commentstats') && !cmd.startsWith('/commenthelp')) {
            const commentText = txt.substring('/comment '.length).trim();
            if (!commentText) {
              await tg.send('❌ Usage: /comment &lt;your comment text&gt;');
              continue;
            }
            if (busy) {
              await tg.send('⏳ Already running a batch. Wait or /commentstop.');
              continue;
            }
            busy = true;
            const statusMsg = await tg.send(`⏳ Starting mass comment...\n\n💬 "${commentText.substring(0, 100)}"`);
            const statusMsgId = statusMsg?.result?.message_id;
            try {
              await executeMassComment(page, commentText, null, statusMsgId);
            } catch (e) {
              console.error('Batch error:', e.message);
              await tg.send(`❌ Batch failed: ${e.message.substring(0, 100)}`);
            }
            busy = false;
          } else if (cmd.startsWith('/commentlist ')) {
            const parts = txt.substring('/commentlist '.length).trim();
            const spaceIdx = parts.indexOf(' ');
            if (spaceIdx === -1) {
              let msg = '❌ Usage: /commentlist &lt;list_url&gt; &lt;comment text&gt;\n\n';
              if (config.lists?.length > 0) {
                msg += '<b>Available lists:</b>\n';
                config.lists.forEach(l => { msg += `• ${l.name}: ${l.url}\n`; });
              }
              await tg.send(msg);
              continue;
            }

            const listUrl = parts.substring(0, spaceIdx).trim();
            const commentText = parts.substring(spaceIdx + 1).trim();

            let resolvedUrl = listUrl;
            if (!listUrl.startsWith('https://') && config.lists) {
              const match = config.lists.find(l => l.name.toLowerCase() === listUrl.toLowerCase());
              if (match) resolvedUrl = match.url;
              else {
                await tg.send(`❌ Unknown list "${listUrl}". Use a URL or list name from config.`);
                continue;
              }
            }

            if (busy) {
              await tg.send('⏳ Already running a batch. Wait or /commentstop.');
              continue;
            }
            busy = true;
            const statusMsg = await tg.send(`⏳ Starting list comment...\n\n📋 ${resolvedUrl}\n💬 "${commentText.substring(0, 80)}"`);
            const statusMsgId = statusMsg?.result?.message_id;
            try {
              await executeMassComment(page, commentText, resolvedUrl, statusMsgId);
            } catch (e) {
              console.error('Batch error:', e.message);
              await tg.send(`❌ Batch failed: ${e.message.substring(0, 100)}`);
            }
            busy = false;
          } else if (cmd === '/commentstop') {
            if (busy) {
              cancelRequested = true;
              await tg.send('⏹ Stopping after current comment finishes...');
            } else {
              await tg.send('ℹ️ No batch is running.');
            }
          } else if (cmd === '/commentstats') {
            const logs = loadLogs();
            const dayKey = new Date().toISOString().split('T')[0];
            const dayCount = logs.daily[dayKey] || 0;
            let msg = '📊 <b>Comment Bot Stats</b>\n\n';
            msg += `Today: ${dayCount}/${MAX_PER_DAY}\n`;
            msg += `Total batches: ${logs.batches.length}\n\n`;
            if (logs.batches.length > 0) {
              msg += '<b>Recent batches:</b>\n';
              logs.batches.slice(-5).forEach(b => {
                msg += `• ${b.time.substring(0, 16)} — ${b.count} comments: "${b.comment.substring(0, 40)}"\n`;
              });
            }
            await tg.send(msg);
          } else if (cmd === '/commenthelp') {
            await tg.send(
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
        } catch (e) {
          console.error('TG handler error:', e.message);
        }
      }
    } catch (e) {
      console.error('Poll error:', e.message);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
