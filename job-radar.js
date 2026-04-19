// Job Radar Bot — scans "Startups and founders" list for hiring signals,
// auto-follows, logs prospects, and builds credibility through smart engagement.
// Usage: node job-radar.js [--dry-run] [--scan-only]
require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ─── PATHS ───
const SESSION_PATH = process.env.SESSION_PATH || './x-session.json';
const PROMPT_PATH = './prompts/job-radar-prompt.txt';
const FEEDBACK_PATH = './data/feedback.json';
const PROSPECTS_JSON = './jobs/prospects.json';
const PROSPECTS_MD = './jobs/prospects.md';
const JR_STATE_PATH = './data/jr-state.json';
const JR_LOG_PATH = './data/jr-logs.json';
const JR_SEEN_PATH = './data/jr-seen.json';
const CONFIG_PATH = './config.json';

// ─── CONFIG ───
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;
const API_KEY = process.env.ANTHROPIC_API_KEY;

// ─── PRAMOD'S PROFILE URLS ───
const LINKEDIN_URL = process.env.LINKEDIN_URL || 'https://linkedin.com/in/pramodreddypandiri';
const GITHUB_URL = process.env.GITHUB_URL || 'https://github.com/pramodreddypandiri';
const PORTFOLIO_URL = process.env.PORTFOLIO_URL || '';

// ─── CLI FLAGS ───
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const SCAN_ONLY = args.includes('--scan-only');

// ─── TIMING & LIMITS ───
const SCAN_INTERVAL_MS = 6 * 60 * 60 * 1000;       // full profile scan every 6 hours
const CHECK_INTERVAL_MS = 90 * 1000;                // check tweets every 90s
const PROFILE_VISIT_DELAY_MIN = 8 * 1000;           // 8-20s between profile visits
const PROFILE_VISIT_DELAY_MAX = 20 * 1000;
const PRE_COMMENT_DELAY_MIN = 45;                   // seconds before posting (cautious)
const PRE_COMMENT_DELAY_MAX = 120;
const PROFILE_LOAD_WAIT_MS = 4000;

// ─── COMMENT RATE LIMITS (conservative — this bot is about quality, not volume) ───
const MAX_PER_HOUR = 5;
const MAX_PER_DAY = 15;
const MIN_GAP_MS = 8 * 60 * 1000;                   // 8 min between comments
const SAME_AUTHOR_COOLDOWN_MS = 12 * 60 * 60 * 1000; // 12 hours same author
const RANDOM_SKIP_RATE = 0.35;                       // skip 35% randomly — be selective
const MAX_TWEET_AGE_MS = 60 * 60 * 1000;             // 60 min

// ─── HIRING KEYWORDS ───
const HIRING_KEYWORDS = [
  "we're hiring", "we are hiring", "now hiring", "join us", "join our team",
  "open roles", "open positions", "hiring for", "looking for",
  "come build with us", "come work with us", "growing the team",
  "hiring engineers", "hiring developers", "apply now",
  "work with us", "team is growing", "looking to hire",
  "founding engineer", "first engineer", "engineer #",
  "careers page", "job opening", "job openings", "new role",
  "head of engineering", "hiring a", "hiring an",
];

const CAREERS_PATTERNS = [
  /(?:careers?|jobs?|positions?|openings?|hiring|work-with-us|join-us)[\w.-]*/i,
  /(?:lever\.co|greenhouse\.io|ashbyhq\.com|workable\.com|breezy\.hr|apply\.workable)/i,
  /(?:notion\.site.*careers|notion\.so.*careers)/i,
];

// ─── HELPERS ───
function loadJSON(p, fb) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } }
function saveJSON(p, d) { fs.writeFileSync(p, JSON.stringify(d, null, 2)); }
function loadText(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function randDelay(min, max) { return min + Math.random() * (max - min); }

function loadState() { return loadJSON(JR_STATE_PATH, { paused: false, lastScan: 0 }); }
function saveState(s) { saveJSON(JR_STATE_PATH, s); }

function loadLogs() { return loadJSON(JR_LOG_PATH, { comments: [], hourly: {}, daily: {} }); }
function saveLogs(l) { saveJSON(JR_LOG_PATH, l); }

function loadSeen() { try { return new Set(JSON.parse(fs.readFileSync(JR_SEEN_PATH, 'utf8'))); } catch { return new Set(); } }
function saveSeen(s) { fs.writeFileSync(JR_SEEN_PATH, JSON.stringify([...s])); }

function loadProspects() { return loadJSON(PROSPECTS_JSON, { prospects: [], lastUpdated: null }); }
function saveProspects(p) { p.lastUpdated = new Date().toISOString(); saveJSON(PROSPECTS_JSON, p); }

function ensureDirs() {
  if (!fs.existsSync('./jobs')) fs.mkdirSync('./jobs', { recursive: true });
  if (!fs.existsSync('./data')) fs.mkdirSync('./data', { recursive: true });
}

// ─── RATE LIMITING ───
function canComment(logs) {
  const now = Date.now();
  const hourKey = new Date().toISOString().substring(0, 13);
  const dayKey = new Date().toISOString().split('T')[0];
  const hourCount = logs.hourly[hourKey] || 0;
  const dayCount = logs.daily[dayKey] || 0;
  if (hourCount >= MAX_PER_HOUR) return { ok: false, reason: 'Hourly limit (' + MAX_PER_HOUR + ')' };
  if (dayCount >= MAX_PER_DAY) return { ok: false, reason: 'Daily limit (' + MAX_PER_DAY + ')' };
  const recent = logs.comments.filter(c => now - new Date(c.time).getTime() < MIN_GAP_MS);
  if (recent.length > 0) return { ok: false, reason: 'Too soon (' + Math.round(MIN_GAP_MS / 60000) + ' min gap)' };
  return { ok: true };
}

function canCommentOnAuthor(logs, author) {
  const now = Date.now();
  return !logs.comments.find(c =>
    c.author === author && (now - new Date(c.time).getTime()) < SAME_AUTHOR_COOLDOWN_MS
  );
}

function recordComment(logs, author, tweetUrl, comment) {
  const now = new Date();
  const hourKey = now.toISOString().substring(0, 13);
  const dayKey = now.toISOString().split('T')[0];
  logs.comments.push({ time: now.toISOString(), author, tweetUrl, comment: comment.substring(0, 100) });
  logs.hourly[hourKey] = (logs.hourly[hourKey] || 0) + 1;
  logs.daily[dayKey] = (logs.daily[dayKey] || 0) + 1;
  if (logs.comments.length > 200) logs.comments = logs.comments.slice(-200);
  saveLogs(logs);
}

// ─── TELEGRAM ───
async function sendTG(text, rm) {
  const b = { chat_id: TG_CHAT, text, parse_mode: 'HTML' };
  if (rm) b.reply_markup = JSON.stringify(rm);
  try {
    const r = await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b)
    });
    return await r.json();
  } catch (e) { console.error('TG send error:', e.message); return null; }
}

async function answerCB(id) {
  await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/answerCallbackQuery', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: id })
  });
}

let tgOff = 0;
let pageRef = null;

// ─── PROFILE SCRAPING ───
async function scrapeListMembers(page, listUrl) {
  const membersUrl = listUrl + '/members';
  console.log('Scanning list members: ' + membersUrl);
  await page.goto(membersUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);

  // Scroll to load all members
  let prevCount = 0;
  let stableRounds = 0;
  for (let i = 0; i < 20; i++) {
    await page.evaluate(() => window.scrollBy(0, 800));
    await page.waitForTimeout(1500);
    const count = await page.evaluate(() => document.querySelectorAll('[data-testid="UserCell"]').length);
    if (count === prevCount) {
      stableRounds++;
      if (stableRounds >= 3) break; // no more members loading
    } else {
      stableRounds = 0;
    }
    prevCount = count;
  }

  const members = await page.evaluate(() => {
    const cells = document.querySelectorAll('[data-testid="UserCell"]');
    const results = [];
    cells.forEach(cell => {
      try {
        const linkEl = cell.querySelector('a[role="link"][href^="/"]');
        if (!linkEl) return;
        const handle = linkEl.getAttribute('href').replace(/^\//, '');
        if (!handle || handle.includes('/')) return;

        const nameEl = cell.querySelector('a[role="link"] span');
        const name = nameEl ? nameEl.textContent.trim() : handle;

        results.push({ handle, name });
      } catch (e) {}
    });
    return results;
  });

  console.log('Found ' + members.length + ' list members');
  return members;
}

async function scrapeProfile(page, handle) {
  const url = 'https://x.com/' + handle;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(PROFILE_LOAD_WAIT_MS);

  const profile = await page.evaluate(() => {
    const result = { bio: '', website: '', location: '', isFollowing: false, links: [] };

    // Bio
    const bioEl = document.querySelector('[data-testid="UserDescription"]');
    if (bioEl) result.bio = bioEl.innerText.trim();

    // Website link
    const linkEl = document.querySelector('[data-testid="UserUrl"] a');
    if (linkEl) {
      result.website = linkEl.getAttribute('href') || linkEl.textContent.trim();
    }

    // Location
    const locEl = document.querySelector('[data-testid="UserLocation"]');
    if (locEl) result.location = locEl.textContent.trim();

    // Following status — check for unfollow button (means we're following)
    const unfollowBtn = document.querySelector('button[data-testid$="-unfollow"]');
    result.isFollowing = !!unfollowBtn;

    // Extract all links from bio
    const bioLinks = document.querySelectorAll('[data-testid="UserDescription"] a');
    bioLinks.forEach(a => {
      const href = a.getAttribute('href') || a.textContent;
      if (href) result.links.push(href);
    });

    // Professional title (if any)
    const headerEl = document.querySelector('[data-testid="UserProfessionalCategory"]');
    if (headerEl) result.category = headerEl.textContent.trim();

    return result;
  });

  // Check for account-doesn't-exist
  const pageText = (await page.content()).toLowerCase();
  if (pageText.includes("this account doesn't exist") || pageText.includes('account suspended')) {
    return null;
  }

  profile.handle = handle;
  return profile;
}

// ─── HIRING DETECTION ───
function detectHiring(profile) {
  if (!profile || !profile.bio) return { isHiring: false, signals: [], careersLink: null };

  const bioLower = profile.bio.toLowerCase();
  const signals = [];

  for (const kw of HIRING_KEYWORDS) {
    if (bioLower.includes(kw)) signals.push(kw);
  }

  // Check for careers link in bio links and website
  let careersLink = null;
  const allLinks = [...(profile.links || [])];
  if (profile.website) allLinks.push(profile.website);

  for (const link of allLinks) {
    for (const pattern of CAREERS_PATTERNS) {
      if (pattern.test(link)) {
        careersLink = link;
        break;
      }
    }
    if (careersLink) break;
  }

  // Also check bio text for career page mentions
  if (!careersLink) {
    const bioLinks = profile.bio.match(/https?:\/\/[^\s]+/g) || [];
    for (const link of bioLinks) {
      for (const pattern of CAREERS_PATTERNS) {
        if (pattern.test(link)) { careersLink = link; break; }
      }
      if (careersLink) break;
    }
  }

  return { isHiring: signals.length > 0, signals, careersLink };
}

// ─── AUTO-FOLLOW ───
async function followUser(page, handle) {
  // Navigate to profile if not already there
  const currentUrl = page.url();
  if (!currentUrl.includes('/' + handle)) {
    await page.goto('https://x.com/' + handle, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(PROFILE_LOAD_WAIT_MS);
  }

  // Already following?
  const alreadyFollowing = await page.$('button[data-testid$="-unfollow"]');
  if (alreadyFollowing) return { status: 'already_following' };

  if (DRY_RUN) return { status: 'dry_run' };

  // Find follow button
  const followBtn = await page.$('button[data-testid$="-follow"]:not([data-testid$="-unfollow"])');
  if (!followBtn) {
    const viaText = await page.$('div[data-testid="primaryColumn"] button:has-text("Follow")');
    if (!viaText) return { status: 'button_not_found' };
    await viaText.click();
    await page.waitForTimeout(2000);
    return { status: 'followed' };
  }

  await followBtn.click();
  await page.waitForTimeout(2000);

  // Verify
  const confirm = await page.$('button[data-testid$="-unfollow"]');
  return { status: confirm ? 'followed' : 'click_not_confirmed' };
}

// ─── PROSPECTS FILE ───
function generateProspectsMD(prospects) {
  let md = '# Job Radar — Hiring Prospects\n';
  md += '_Auto-generated by job-radar bot. Last updated: ' + new Date().toISOString().split('T')[0] + '_\n\n';

  const hiring = prospects.prospects.filter(p => p.isHiring);
  const watching = prospects.prospects.filter(p => !p.isHiring);

  if (hiring.length > 0) {
    md += '## Actively Hiring (' + hiring.length + ')\n\n';
    for (const p of hiring) {
      md += '### @' + p.handle + (p.name ? ' — ' + p.name : '') + '\n';
      md += '- **Bio**: ' + (p.bio || '—').substring(0, 200) + '\n';
      md += '- **Signals**: ' + (p.signals || []).join(', ') + '\n';
      if (p.careersLink) md += '- **Careers**: ' + p.careersLink + '\n';
      if (p.website) md += '- **Website**: ' + p.website + '\n';
      if (p.location) md += '- **Location**: ' + p.location + '\n';
      md += '- **Following**: ' + (p.isFollowing ? 'Yes' : 'No') + '\n';
      md += '- **First seen**: ' + (p.firstSeen || '—').split('T')[0] + '\n';
      md += '- **Last scanned**: ' + (p.lastScanned || '—').split('T')[0] + '\n';
      md += '\n';
    }
  }

  if (watching.length > 0) {
    md += '## Watching (' + watching.length + ')\n\n';
    for (const p of watching) {
      md += '- **@' + p.handle + '**' + (p.name ? ' (' + p.name + ')' : '');
      if (p.bio) md += ' — ' + p.bio.substring(0, 80);
      md += '\n';
    }
  }

  return md;
}

function updateProspect(handle, name, profile, hiringInfo) {
  const data = loadProspects();
  const existing = data.prospects.find(p => p.handle.toLowerCase() === handle.toLowerCase());
  const now = new Date().toISOString();

  if (existing) {
    existing.name = name || existing.name;
    existing.bio = profile.bio || existing.bio;
    existing.website = profile.website || existing.website;
    existing.location = profile.location || existing.location;
    existing.isFollowing = profile.isFollowing;
    existing.isHiring = hiringInfo.isHiring;
    existing.signals = hiringInfo.signals;
    existing.careersLink = hiringInfo.careersLink || existing.careersLink;
    existing.lastScanned = now;
    // Track changes
    if (hiringInfo.isHiring && !existing.wasHiring) {
      existing.becameHiring = now;
    }
    existing.wasHiring = hiringInfo.isHiring;
  } else {
    data.prospects.push({
      handle,
      name: name || handle,
      bio: profile.bio,
      website: profile.website,
      location: profile.location,
      isFollowing: profile.isFollowing,
      isHiring: hiringInfo.isHiring,
      signals: hiringInfo.signals,
      careersLink: hiringInfo.careersLink,
      firstSeen: now,
      lastScanned: now,
      wasHiring: hiringInfo.isHiring,
    });
  }

  saveProspects(data);
  // Regenerate markdown
  fs.writeFileSync(PROSPECTS_MD, generateProspectsMD(data));
  return existing ? 'updated' : 'new';
}

// ─── SCRAPE TWEETS FROM LIST ───
async function scrapeList(page, listUrl) {
  await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
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
        const ia = el.querySelectorAll('article');
        if (ia.length > 1) return;
        const qt = el.querySelector('[data-testid="quoteTweet"], [role="link"][tabindex="0"] article, div[data-testid="card.wrapper"]');
        if (qt) return;
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
      } catch (e) {}
    });
    return res;
  });
}

// ─── COMMENT GENERATION ───
async function generateEngagement(tweetText, tweetAuthor, authorBio, authorCompany, listStrategy) {
  const gp = loadText(PROMPT_PATH);
  if (!gp) return null;

  const fb = loadJSON(FEEDBACK_PATH, { approvals: [], rejections: [], edits: [] });
  let fbCtx = '';
  const ra = fb.approvals.slice(-5);
  if (ra.length > 0) {
    fbCtx += 'COMMENTS PRAMOD LIKED:\n';
    ra.forEach(a => { fbCtx += '- "' + a.commentText + '"\n'; });
  }
  const re = fb.edits.slice(-3);
  if (re.length > 0) {
    fbCtx += 'PRAMOD REWRITES:\n';
    re.forEach(e => { fbCtx += '- "' + e.editedComment + '"\n'; });
  }

  const currentWork = loadText('./prompts/current-work.txt').replace(/^#.*$/gm, '').trim();

  const prompt = gp
    .replace('{FEEDBACK_CONTEXT}', fbCtx || 'No feedback yet.')
    .replace('{AUTHOR}', tweetAuthor)
    .replace('{AUTHOR_BIO}', authorBio || 'Not available')
    .replace('{AUTHOR_COMPANY}', authorCompany || 'Unknown')
    .replace('{TWEET_TEXT}', tweetText)
    .replace('{LIST_STRATEGY}', listStrategy)
    .replace('{CURRENT_WORK}', currentWork || 'Building AI-powered tools')
    .replace('{LINKEDIN_URL}', LINKEDIN_URL)
    .replace('{GITHUB_URL}', GITHUB_URL)
    .replace('{PORTFOLIO_URL}', PORTFOLIO_URL || 'Not set');

  try {
    let d = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 500, messages: [{ role: 'user', content: prompt }] })
      });
      d = await r.json();
      if (d.content && d.content[0]) break;
      if (d.error && d.error.type === 'overloaded_error') {
        const wait = (attempt + 1) * 10;
        console.log('API overloaded, retrying in ' + wait + 's...');
        await sleep(wait * 1000);
      } else {
        console.error('Claude API error:', JSON.stringify(d));
        return null;
      }
    }

    if (d && d.content && d.content[0]) {
      const text = d.content[0].text.trim();
      if (text === 'SKIP' || text.startsWith('SKIP')) return null;

      // Parse options A-E
      const lines = text.split('\n').filter(l => l.trim());
      const opts = [];
      let cur = '';
      for (const line of lines) {
        if (line.match(/^[A-E]:/)) {
          if (cur) opts.push(cur.trim());
          cur = line.replace(/^[A-E]:\s*/, '').replace(/^["']|["']$/g, '');
        } else if (cur) { cur += ' ' + line.trim(); }
      }
      if (cur) opts.push(cur.trim());

      // Filter bad responses
      const valid = opts.filter(o =>
        o !== 'SKIP' && !o.startsWith('SKIP') &&
        !o.toLowerCase().includes('i need to see') &&
        !o.toLowerCase().includes('please provide') &&
        !o.toLowerCase().includes('voice prompt') &&
        !o.toLowerCase().includes("i'm looking") &&
        !o.toLowerCase().includes('hiring') &&
        !o.toLowerCase().includes('job') &&
        !o.toLowerCase().includes('check out my') &&
        o.length >= 15 && o.length <= 280
      );

      if (valid.length > 0) {
        // Weight toward B (technical) and D (question) for credibility
        const weights = [0.15, 0.3, 0.2, 0.25, 0.1];
        let rand = Math.random();
        let pick = 0;
        for (let i = 0; i < weights.length && i < valid.length; i++) {
          rand -= weights[i];
          if (rand <= 0) { pick = i; break; }
        }
        return valid[Math.min(pick, valid.length - 1)];
      }
    }
  } catch (e) { console.error('Claude error:', e.message); }
  return null;
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

  if (DRY_RUN) {
    console.log('[DRY RUN] Would post: ' + commentText);
    return true;
  }

  const btn = await page.waitForSelector('button[data-testid="tweetButtonInline"]', { timeout: 5000 });
  await btn.click();
  await page.waitForTimeout(2000 + Math.random() * 2000);
  return true;
}

// ─── TELEGRAM COMMANDS ───
const pendingActions = new Map();

async function checkTGCommands() {
  try {
    const r = await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/getUpdates?offset=' + tgOff + '&timeout=1');
    const u = await r.json();
    if (!u.ok || !u.result) return;

    for (const up of u.result) {
      tgOff = up.update_id + 1;

      // Callback buttons
      if (up.callback_query) {
        const d = up.callback_query.data;
        const parts = d.split('_');
        const action = parts[0];
        const id = parts.slice(1).join('_');
        await answerCB(up.callback_query.id);

        const pending = pendingActions.get(id);
        if (!pending) continue;

        if (action === 'jrok') {
          pendingActions.delete(id);
        } else if (action === 'jrfb') {
          pending.waitingFeedback = true;
          await sendTG('💬 Type feedback for this comment:');
        }
        continue;
      }

      if (up.message && up.message.text) {
        const txt = up.message.text.trim();

        // Handle pending feedback
        const fbEntry = [...pendingActions.entries()].find(([k, p]) => p.waitingFeedback);
        if (fbEntry && !txt.startsWith('/')) {
          const [fbId, fbData] = fbEntry;
          // Save to feedback.json for learning
          const fb = loadJSON(FEEDBACK_PATH, { approvals: [], rejections: [], edits: [] });
          fb.rejections.push({
            date: new Date().toISOString(),
            author: fbData.author,
            tweetUrl: fbData.tweetUrl,
            commentText: fbData.comment,
            reason: txt,
          });
          saveJSON(FEEDBACK_PATH, fb);
          await sendTG('📝 Feedback saved. Will improve.');
          pendingActions.delete(fbId);
          continue;
        }

        const cmd = txt.toLowerCase();

        if (cmd === '/jrstop') {
          const state = loadState();
          state.paused = true;
          saveState(state);
          await sendTG('⏸ <b>Job Radar paused.</b> /jrstart to resume.');
        }
        else if (cmd === '/jrstart') {
          const state = loadState();
          state.paused = false;
          saveState(state);
          await sendTG('▶️ <b>Job Radar resumed!</b>');
        }
        else if (cmd === '/jrstats') {
          const logs = loadLogs();
          const data = loadProspects();
          const state = loadState();
          const dayKey = new Date().toISOString().split('T')[0];
          const hourKey = new Date().toISOString().substring(0, 13);

          const hiring = data.prospects.filter(p => p.isHiring).length;
          const total = data.prospects.length;
          const following = data.prospects.filter(p => p.isFollowing).length;

          let msg = '🎯 <b>Job Radar Stats</b>\n\n';
          msg += 'State: ' + (state.paused ? '⏸ Paused' : '▶️ Running') + '\n';
          msg += 'Prospects: ' + total + ' tracked\n';
          msg += '🟢 Hiring: ' + hiring + '\n';
          msg += '👥 Following: ' + following + '\n';
          msg += 'Comments today: ' + (logs.daily[dayKey] || 0) + '/' + MAX_PER_DAY + '\n';
          msg += 'This hour: ' + (logs.hourly[hourKey] || 0) + '/' + MAX_PER_HOUR + '\n';
          if (state.lastScan) msg += 'Last scan: ' + new Date(state.lastScan).toISOString().split('T')[0] + '\n';
          await sendTG(msg);
        }
        else if (cmd === '/jrscan') {
          const state = loadState();
          state.lastScan = 0; // Force immediate scan
          saveState(state);
          await sendTG('🔍 <b>Forcing full profile scan on next cycle...</b>');
        }
        else if (cmd === '/jrprospects') {
          const data = loadProspects();
          const hiring = data.prospects.filter(p => p.isHiring);
          if (hiring.length === 0) {
            await sendTG('No hiring prospects found yet. Run /jrscan to scan.');
          } else {
            let msg = '🎯 <b>Hiring Prospects (' + hiring.length + ')</b>\n\n';
            for (const p of hiring.slice(0, 15)) {
              msg += '• <b>@' + p.handle + '</b>' + (p.name ? ' (' + p.name + ')' : '') + '\n';
              msg += '  ' + p.signals.slice(0, 2).join(', ') + '\n';
              if (p.careersLink) msg += '  🔗 ' + p.careersLink + '\n';
            }
            if (hiring.length > 15) msg += '\n... and ' + (hiring.length - 15) + ' more. See jobs/prospects.md';
            await sendTG(msg);
          }
        }
        else if (cmd === '/jrhelp') {
          await sendTG(
            '🎯 <b>Job Radar Commands</b>\n\n' +
            '/jrstart — Resume\n' +
            '/jrstop — Pause\n' +
            '/jrstats — Stats\n' +
            '/jrscan — Force profile scan\n' +
            '/jrprospects — Show hiring prospects\n' +
            '/jrhelp — This message'
          );
        }
      }
    }
  } catch (e) {}
}

// ─── FULL PROFILE SCAN ───
async function runProfileScan(page, listUrl) {
  console.log('\n━━━ Starting full profile scan ━━━');
  await sendTG('🔍 <b>Job Radar: Starting profile scan...</b>');

  const members = await scrapeListMembers(page, listUrl);
  if (members.length === 0) {
    console.log('No members found in list');
    await sendTG('⚠️ No members found in list. Check session.');
    return;
  }

  let newHiring = [];
  let newFollowed = [];
  let scanned = 0;

  for (const member of members) {
    scanned++;
    const label = '[' + scanned + '/' + members.length + '] @' + member.handle;

    try {
      console.log('Scanning ' + label);
      const profile = await scrapeProfile(page, member.handle);
      if (!profile) {
        console.log('  → account not found');
        continue;
      }

      const hiring = detectHiring(profile);
      const result = updateProspect(member.handle, member.name, profile, hiring);

      if (hiring.isHiring) {
        console.log('  🟢 HIRING: ' + hiring.signals.join(', '));
        if (result === 'new' || !profile.isFollowing) {
          newHiring.push({ handle: member.handle, name: member.name, signals: hiring.signals, careersLink: hiring.careersLink });
        }

        // Auto-follow if not following
        if (!profile.isFollowing) {
          const followResult = await followUser(page, member.handle);
          console.log('  → follow: ' + followResult.status);
          if (followResult.status === 'followed' || followResult.status === 'dry_run') {
            newFollowed.push(member.handle);
            // Update prospect record
            const data = loadProspects();
            const p = data.prospects.find(p => p.handle.toLowerCase() === member.handle.toLowerCase());
            if (p) { p.isFollowing = true; saveProspects(data); }
          }
        }
      } else {
        if (result === 'new') console.log('  → tracked (not hiring)');
      }
    } catch (e) {
      console.log('  ❌ error: ' + e.message.substring(0, 60));
    }

    // Human-speed delay between profiles
    if (scanned < members.length) {
      const delay = randDelay(PROFILE_VISIT_DELAY_MIN, PROFILE_VISIT_DELAY_MAX);
      console.log('  waiting ' + Math.round(delay / 1000) + 's...');
      await sleep(delay);
    }
  }

  // Summary
  const data = loadProspects();
  const totalHiring = data.prospects.filter(p => p.isHiring).length;

  let summary = '━━━ Scan Complete ━━━\n';
  summary += 'Scanned: ' + scanned + ' profiles\n';
  summary += 'Total hiring: ' + totalHiring + '\n';
  summary += 'New follows: ' + newFollowed.length + '\n';
  console.log('\n' + summary);

  let tgMsg = '🔍 <b>Job Radar Scan Complete</b>\n\n';
  tgMsg += '📊 Scanned: ' + scanned + ' profiles\n';
  tgMsg += '🟢 Total hiring: ' + totalHiring + '\n';
  tgMsg += '👥 New follows: ' + newFollowed.length + '\n';

  if (newHiring.length > 0) {
    tgMsg += '\n<b>New hiring signals:</b>\n';
    for (const h of newHiring.slice(0, 10)) {
      tgMsg += '• @' + h.handle + ' — ' + h.signals[0];
      if (h.careersLink) tgMsg += ' 🔗';
      tgMsg += '\n';
    }
  }

  await sendTG(tgMsg);

  // Update state
  const state = loadState();
  state.lastScan = Date.now();
  saveState(state);
}

// ─── MAIN ───
async function main() {
  console.log('🎯 Job Radar starting...');
  if (DRY_RUN) console.log('*** DRY RUN — no follows or comments will be posted ***');
  if (SCAN_ONLY) console.log('*** SCAN ONLY — will scan profiles and exit ***');
  if (!TG_TOKEN || !TG_CHAT || !API_KEY) { console.error('Missing env vars'); process.exit(1); }

  ensureDirs();

  const config = loadJSON(CONFIG_PATH, { lists: [] });
  const startupList = config.lists.find(l => l.name === 'Startups and founders');
  if (!startupList) { console.error('No "Startups and founders" list in config.json'); process.exit(1); }

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
    await sendTG('❌ X session expired. Run: npm run setup-cookies');
    process.exit(1);
  }
  console.log('Logged in!');

  const seen = loadSeen();
  const state = loadState();
  const logs = loadLogs();
  const dayKey = new Date().toISOString().split('T')[0];

  await sendTG(
    '🎯 <b>Job Radar online!</b>\n\n' +
    '• Monitoring: ' + startupList.name + '\n' +
    '• Mode: ' + (DRY_RUN ? 'DRY RUN' : (SCAN_ONLY ? 'SCAN ONLY' : 'LIVE')) + '\n' +
    '• Comment limits: ' + MAX_PER_HOUR + '/hr, ' + MAX_PER_DAY + '/day\n' +
    '• Today so far: ' + (logs.daily[dayKey] || 0) + ' comments\n' +
    '• State: ' + (state.paused ? 'PAUSED' : 'RUNNING') + '\n\n' +
    '/jrstop /jrstart /jrstats /jrscan /jrprospects /jrhelp'
  );

  // If scan-only mode, just run scan and exit
  if (SCAN_ONLY) {
    await runProfileScan(page, startupList.url);
    await browser.close();
    return;
  }

  // Build a map of known profiles for engagement context
  // (loaded from prospects.json, updated after scans)
  function getProfileContext(handle) {
    const data = loadProspects();
    const p = data.prospects.find(p => p.handle.toLowerCase() === handle.toLowerCase());
    return p ? { bio: p.bio || '', company: p.name || '', isHiring: p.isHiring } : null;
  }

  // Main loop
  while (true) {
    try {
      await checkTGCommands();
      const currentState = loadState();

      if (currentState.paused) {
        console.log('Paused.');
        await page.waitForTimeout(CHECK_INTERVAL_MS);
        continue;
      }

      // Check if it's time for a full profile scan
      const timeSinceScan = Date.now() - (currentState.lastScan || 0);
      if (timeSinceScan >= SCAN_INTERVAL_MS) {
        await runProfileScan(page, startupList.url);
      }

      // Scrape list for new tweets and engage
      const currentLogs = loadLogs();
      const rateCheck = canComment(currentLogs);

      if (rateCheck.ok) {
        const tweets = await scrapeList(page, startupList.url);
        console.log('Found ' + tweets.length + ' tweets in "' + startupList.name + '"');

        for (const tw of tweets) {
          if (seen.has(tw.tweetUrl)) continue;

          // Tweet age filter
          if (tw.time) {
            const age = Date.now() - new Date(tw.time).getTime();
            if (age > MAX_TWEET_AGE_MS) { seen.add(tw.tweetUrl); continue; }
          }

          // Skip own tweets
          if (tw.author.toLowerCase() === (process.env.X_USERNAME || '').toLowerCase()) {
            seen.add(tw.tweetUrl);
            continue;
          }

          // Rate checks
          const freshLogs = loadLogs();
          const check = canComment(freshLogs);
          if (!check.ok) { console.log('Rate limit: ' + check.reason); break; }

          if (!canCommentOnAuthor(freshLogs, tw.author)) {
            console.log('Skipping @' + tw.author + ' (commented recently)');
            seen.add(tw.tweetUrl);
            continue;
          }

          // Higher random skip — be selective
          if (Math.random() < RANDOM_SKIP_RATE) {
            console.log('Selective skip @' + tw.author);
            seen.add(tw.tweetUrl);
            continue;
          }

          // Get profile context for richer engagement
          const profileCtx = getProfileContext(tw.author);
          const authorBio = profileCtx ? profileCtx.bio : '';
          const authorCompany = profileCtx ? profileCtx.company : '';

          console.log('Engaging with @' + tw.author + (profileCtx && profileCtx.isHiring ? ' [HIRING]' : ''));

          const comment = await generateEngagement(
            tw.text, tw.author, authorBio, authorCompany, startupList.strategy
          );

          if (!comment) {
            console.log('Skipped — no confident comment');
            seen.add(tw.tweetUrl);
            continue;
          }

          // Human delay
          const delay = (PRE_COMMENT_DELAY_MIN + Math.random() * (PRE_COMMENT_DELAY_MAX - PRE_COMMENT_DELAY_MIN)) * 1000;
          console.log('Posting in ' + Math.round(delay / 1000) + 's...');
          await page.waitForTimeout(delay);

          try {
            await postComment(page, tw.tweetUrl, comment);
            recordComment(freshLogs, tw.author, tw.tweetUrl, comment);
            seen.add(tw.tweetUrl);
            saveSeen(seen);

            console.log('✅ Engaged with @' + tw.author);
            const commentId = Date.now().toString();
            pendingActions.set(commentId, {
              author: tw.author, tweetUrl: tw.tweetUrl, comment,
              waitingFeedback: false
            });

            await sendTG(
              '🎯 <b>Job Radar commented on @' + tw.author + '</b>' +
              (profileCtx && profileCtx.isHiring ? ' [HIRING]' : '') + '\n\n' +
              '💬 ' + comment + '\n\n' +
              '🔗 ' + tw.tweetUrl,
              { inline_keyboard: [
                [{ text: '✅ Good', callback_data: 'jrok_' + commentId },
                 { text: '💬 Feedback', callback_data: 'jrfb_' + commentId }]
              ]}
            );
          } catch (e) {
            console.log('Failed to post: ' + e.message);
            seen.add(tw.tweetUrl);
            saveSeen(seen);
          }

          // One comment per cycle
          break;
        }
      } else {
        console.log('Rate limited: ' + rateCheck.reason);
      }

      await page.waitForTimeout(CHECK_INTERVAL_MS);

    } catch (e) {
      console.error('Error:', e.message);
      await sendTG('⚠️ Job Radar error: ' + e.message.substring(0, 100));
      await page.waitForTimeout(30000);
    }
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
