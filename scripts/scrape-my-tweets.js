require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const SESSION_PATH = process.env.SESSION_PATH || './x-session.json';
const OUTPUT_PATH = './data/my-tweets-corpus.json';

function parseCount(s) {
  if (!s) return 0;
  const t = String(s).trim().replace(/,/g, '');
  if (/^\d+$/.test(t)) return parseInt(t, 10);
  const m = t.match(/^([\d.]+)\s*([KMB])$/i);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const u = m[2].toUpperCase();
  return Math.round(n * (u === 'K' ? 1e3 : u === 'M' ? 1e6 : 1e9));
}

function sleep(min, max) {
  const ms = min + Math.random() * (max - min);
  return new Promise(r => setTimeout(r, ms));
}

async function scrapeMyTweets({
  page,
  handle,
  daysBack = 30,
  minImpressions = 100,
  maxScrolls = 100,
  scrollMinMs = 4000,
  scrollMaxMs = 8000,
  outputPath = OUTPUT_PATH,
  onProgress = null,
}) {
  await page.goto(`https://x.com/${handle}/with_replies`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(4000, 6000);

  const url = page.url();
  if (url.includes('/login') || url.includes('/i/flow/login')) {
    throw new Error('Session expired — refresh x-session.json');
  }

  const cutoff = Date.now() - daysBack * 24 * 60 * 60 * 1000;
  const seen = new Set();
  const all = [];
  let oldestSeen = Date.now();
  let stagnantScrolls = 0;
  let scrolls = 0;
  let stopReason = 'maxScrolls';

  for (; scrolls < maxScrolls; scrolls++) {
    const batch = await page.evaluate((HANDLE_LC) => {
      const els = document.querySelectorAll('article[data-testid="tweet"]');
      const out = [];
      els.forEach(el => {
        try {
          const sc = el.querySelector('[data-testid="socialContext"]');
          if (sc && /reposted/i.test(sc.textContent)) return;

          const ae = el.querySelector('div[data-testid="User-Name"] a');
          const author = ae ? ae.getAttribute('href').replace('/', '') : '';
          if (author.toLowerCase() !== HANDLE_LC) return;

          const te = el.querySelector('div[data-testid="tweetText"]');
          const text = te ? te.innerText : '';
          if (!text) return;

          let url = '';
          el.querySelectorAll('a[href*="/status/"]').forEach(l => {
            const h = l.getAttribute('href');
            if (h && h.match(/\/status\/\d+$/)) url = 'https://x.com' + h;
          });
          if (!url) return;

          const ti = el.querySelector('time');
          const time = ti ? ti.getAttribute('datetime') : null;

          let isReply = false;
          let replyingTo = null;
          const lines = el.innerText.split('\n');
          for (let i = 0; i < Math.min(lines.length, 8); i++) {
            const m = lines[i].match(/^Replying to\s+(@\w+)/);
            if (m) { isReply = true; replyingTo = m[1]; break; }
          }

          const getCount = (sel) => {
            const btn = el.querySelector(sel);
            if (!btn) return '0';
            const c = btn.querySelector('[data-testid="app-text-transition-container"]');
            if (c && c.innerText.trim()) return c.innerText.trim();
            const al = btn.getAttribute('aria-label') || '';
            const m = al.match(/^([\d.,KMB]+)/i);
            return m ? m[1] : '0';
          };

          const replies = getCount('button[data-testid="reply"]');
          const reposts = getCount('button[data-testid="retweet"], button[data-testid="unretweet"]');
          const likes = getCount('button[data-testid="like"], button[data-testid="unlike"]');

          let impressions = '0';
          const anLink = el.querySelector('a[href*="/analytics"]');
          if (anLink) {
            const c = anLink.querySelector('[data-testid="app-text-transition-container"]');
            if (c && c.innerText.trim()) impressions = c.innerText.trim();
            else {
              const al = anLink.getAttribute('aria-label') || '';
              const m = al.match(/([\d.,KMB]+)\s*(?:Views|views)/);
              if (m) impressions = m[1];
            }
          }

          out.push({ url, author, text, time, isReply, replyingTo, replies, reposts, likes, impressions });
        } catch (e) {}
      });
      return out;
    }, handle.toLowerCase());

    let newThisScroll = 0;
    for (const t of batch) {
      if (seen.has(t.url)) continue;
      seen.add(t.url);
      newThisScroll++;
      const ts = t.time ? Date.parse(t.time) : Date.now();
      if (ts < oldestSeen) oldestSeen = ts;
      if (ts < cutoff) continue;
      all.push({ ...t, ts });
    }

    if (onProgress) {
      try { await onProgress({ scrolls: scrolls + 1, maxScrolls, kept: all.length, newThisScroll, oldestSeen }); } catch (e) {}
    }

    if (oldestSeen < cutoff) { stopReason = 'cutoff'; break; }
    if (newThisScroll === 0) {
      stagnantScrolls++;
      if (stagnantScrolls >= 3) { stopReason = 'stagnant'; break; }
    } else {
      stagnantScrolls = 0;
    }

    await page.evaluate(() => window.scrollBy(0, 1500 + Math.random() * 600));
    await sleep(scrollMinMs, scrollMaxMs);
  }

  const enriched = all.map(t => ({
    ...t,
    impressionsN: parseCount(t.impressions),
    repliesN: parseCount(t.replies),
    repostsN: parseCount(t.reposts),
    likesN: parseCount(t.likes),
  }));

  const filtered = enriched.filter(t =>
    t.impressionsN >= minImpressions || t.repliesN >= 1 || t.repostsN >= 1
  );

  filtered.sort((a, b) => {
    const score = (t) => t.impressionsN + t.likesN * 50 + t.repliesN * 200 + t.repostsN * 100;
    return score(b) - score(a);
  });

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(filtered, null, 2));

  return { scraped: all.length, kept: filtered.length, scrolls, stopReason, tweets: filtered };
}

module.exports = { scrapeMyTweets, parseCount };

if (require.main === module) {
  (async () => {
    const handle = process.argv[2] || process.env.X_USERNAME;
    if (!handle) {
      console.error('Provide a handle: node scripts/scrape-my-tweets.js <handle> (or set X_USERNAME in .env)');
      process.exit(1);
    }
    console.log(`Scraping @${handle}/with_replies — last 30 days`);
    console.log(`Filter: impressions >= 100 OR replies >= 1 OR reposts >= 1\n`);

    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
    });
    const ctx = await browser.newContext({
      storageState: SESSION_PATH,
      viewport: { width: 1280, height: 1024 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    const page = await ctx.newPage();

    try {
      const result = await scrapeMyTweets({
        page,
        handle,
        onProgress: ({ scrolls, maxScrolls, kept, newThisScroll, oldestSeen }) => {
          const oldestStr = new Date(oldestSeen).toISOString().split('T')[0];
          process.stdout.write(`  scroll ${scrolls}/${maxScrolls}: +${newThisScroll} new, ${kept} kept, oldest=${oldestStr}\n`);
        },
      });
      console.log(`\nScraped ${result.scraped} tweets. ${result.kept} pass the bar. Stop reason: ${result.stopReason}.`);
      console.log(`Saved → ${OUTPUT_PATH}\n`);
      console.log('═══ TOP 15 ═══\n');
      result.tweets.slice(0, 15).forEach((t, i) => {
        const date = new Date(t.ts).toISOString().split('T')[0];
        const tag = t.isReply ? `↩  reply to ${t.replyingTo}` : '✦  original';
        console.log(`#${i + 1}  [${date}]  ${tag}`);
        console.log(`     impr=${t.impressionsN}  likes=${t.likesN}  replies=${t.repliesN}  rts=${t.repostsN}`);
        console.log(`     ${t.text.replace(/\n/g, ' ⏎ ').slice(0, 200)}`);
        console.log(`     ${t.url}\n`);
      });
    } finally {
      await browser.close();
    }
  })().catch(e => { console.error(e); process.exit(1); });
}
