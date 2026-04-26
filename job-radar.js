// Job Radar Bot — scans any config.json list flagged with "jobRadar": true
// for hiring signals, auto-follows, logs prospects, and engages.
// Usage: node job-radar.js [--dry-run] [--scan-only]
require('dotenv').config();
const fs = require('fs');
const {
  loadJSON, saveJSON, loadText, loadTextNoComments, loadSet, saveSet,
  resolveTelegramAuth, requireEnv, getIdentity,
  createTelegramClient,
  callClaude, parseLetterOptions, weightedPick,
  launchBrowser, verifyLogin,
  scrapeList, postComment,
  makeRateLimiter, makePendingStore,
} = require('./lib');

// ─── PATHS ───
const SESSION_PATH = process.env.SESSION_PATH || './x-session.json';
const PROMPT_PATH = process.env.JOB_RADAR_PROMPT_PATH || './prompts/job-radar-prompt.txt';
const FEEDBACK_PATH = './data/feedback.json';
const PROSPECTS_JSON = './jobs/prospects.json';
const PROSPECTS_MD = './jobs/prospects.md';
const JR_STATE_PATH = './data/jr-state.json';
const JR_LOG_PATH = './data/jr-logs.json';
const JR_SEEN_PATH = './data/jr-seen.json';
const JR_PENDING_PATH = './data/jr-pending.json';
const CONFIG_PATH = process.env.CONFIG_PATH || './config.json';
const CURRENT_WORK_PATH = './prompts/current-work.txt';

// ─── CONFIG ───
const { token: TG_TOKEN, chatId: TG_CHAT } = resolveTelegramAuth('jr');
const API_KEY = requireEnv('ANTHROPIC_API_KEY');
const ME = getIdentity();

// ─── PROFILE URLS ───
const LINKEDIN_URL = process.env.LINKEDIN_URL || '';
const GITHUB_URL = process.env.GITHUB_URL || '';
const PORTFOLIO_URL = process.env.PORTFOLIO_URL || '';

// ─── CLI FLAGS ───
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const SCAN_ONLY = args.includes('--scan-only');

// ─── TIMING & LIMITS ───
const SCAN_INTERVAL_MS = 6 * 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 90 * 1000;
const PROFILE_VISIT_DELAY_MIN = 8 * 1000;
const PROFILE_VISIT_DELAY_MAX = 20 * 1000;
const PRE_COMMENT_DELAY_MIN = 45;
const PRE_COMMENT_DELAY_MAX = 120;
const PROFILE_LOAD_WAIT_MS = 4000;
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

const MAX_PER_HOUR = 5;
const MAX_PER_DAY = 15;
const MIN_GAP_MS = 8 * 60 * 1000;
const SAME_AUTHOR_COOLDOWN_MS = 12 * 60 * 60 * 1000;
const RANDOM_SKIP_RATE = 0.35;
const MAX_TWEET_AGE_MS = 60 * 60 * 1000;

// Bias toward technical (B) and curious questions (D) for credibility.
const OPTION_WEIGHTS = [0.15, 0.3, 0.2, 0.25, 0.1];

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

const SOLICITATION_PATTERNS = [
  /\bhiring\b.*(know someone|know anyone|drop your|share your|comment your|reply with)/i,
  /(drop|share|comment|reply with).*(your work|your portfolio|your github|your projects|what you('re| are) building|cool things)/i,
  /(looking for|need|want).*(engineer|developer|founding|builder).*(reply|comment|dm|drop)/i,
  /who('s| is) building.*(comment|reply|below|share)/i,
  /show me what you('re| are) building/i,
];

const CAREERS_PATTERNS = [
  /(?:careers?|jobs?|positions?|openings?|hiring|work-with-us|join-us)[\w.-]*/i,
  /(?:lever\.co|greenhouse\.io|ashbyhq\.com|workable\.com|breezy\.hr|apply\.workable)/i,
  /(?:notion\.site.*careers|notion\.so.*careers)/i,
];

function isSolicitationTweet(text) {
  if (!text) return false;
  return SOLICITATION_PATTERNS.some(p => p.test(text));
}

// ─── CLIENTS ───
const tg = createTelegramClient({ token: TG_TOKEN, chatId: TG_CHAT });
const rateLimiter = makeRateLimiter({
  maxPerHour: MAX_PER_HOUR,
  maxPerDay: MAX_PER_DAY,
  minGapMs: MIN_GAP_MS,
  sameAuthorCooldownMs: SAME_AUTHOR_COOLDOWN_MS,
});
const pendingStore = makePendingStore(JR_PENDING_PATH);

// ─── STATE ACCESSORS ───
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const randDelay = (min, max) => min + Math.random() * (max - min);
const loadState = () => loadJSON(JR_STATE_PATH, { paused: false, lastScan: 0 });
const saveState = (s) => saveJSON(JR_STATE_PATH, s);
const loadLogs = () => loadJSON(JR_LOG_PATH, { comments: [], hourly: {}, daily: {} });
const saveLogs = (l) => saveJSON(JR_LOG_PATH, l);
const loadProspects = () => loadJSON(PROSPECTS_JSON, { prospects: [], lastUpdated: null });
function saveProspects(p) {
  p.lastUpdated = new Date().toISOString();
  saveJSON(PROSPECTS_JSON, p);
}

function ensureDirs() {
  if (!fs.existsSync('./jobs')) fs.mkdirSync('./jobs', { recursive: true });
  if (!fs.existsSync('./data')) fs.mkdirSync('./data', { recursive: true });
}

// ─── PROFILE SCRAPING ───
async function scrapeListMembers(page, listUrl) {
  const membersUrl = listUrl + '/members';
  console.log('Scanning list members: ' + membersUrl);
  await page.goto(membersUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);

  let prevCount = 0;
  let stableRounds = 0;
  for (let i = 0; i < 20; i++) {
    await page.evaluate(() => window.scrollBy(0, 800));
    await page.waitForTimeout(1500);
    const count = await page.evaluate(() => document.querySelectorAll('[data-testid="UserCell"]').length);
    if (count === prevCount) {
      stableRounds++;
      if (stableRounds >= 3) break;
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
    const bioEl = document.querySelector('[data-testid="UserDescription"]');
    if (bioEl) result.bio = bioEl.innerText.trim();
    const linkEl = document.querySelector('[data-testid="UserUrl"] a');
    if (linkEl) result.website = linkEl.getAttribute('href') || linkEl.textContent.trim();
    const locEl = document.querySelector('[data-testid="UserLocation"]');
    if (locEl) result.location = locEl.textContent.trim();
    const unfollowBtn = document.querySelector('button[data-testid$="-unfollow"]');
    result.isFollowing = !!unfollowBtn;
    const bioLinks = document.querySelectorAll('[data-testid="UserDescription"] a');
    bioLinks.forEach(a => {
      const href = a.getAttribute('href') || a.textContent;
      if (href) result.links.push(href);
    });
    const headerEl = document.querySelector('[data-testid="UserProfessionalCategory"]');
    if (headerEl) result.category = headerEl.textContent.trim();
    return result;
  });

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

  let careersLink = null;
  const allLinks = [...(profile.links || [])];
  if (profile.website) allLinks.push(profile.website);

  for (const link of allLinks) {
    for (const pattern of CAREERS_PATTERNS) {
      if (pattern.test(link)) { careersLink = link; break; }
    }
    if (careersLink) break;
  }

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
  const currentUrl = page.url();
  if (!currentUrl.includes('/' + handle)) {
    await page.goto('https://x.com/' + handle, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(PROFILE_LOAD_WAIT_MS);
  }

  const alreadyFollowing = await page.$('button[data-testid$="-unfollow"]');
  if (alreadyFollowing) return { status: 'already_following' };

  if (DRY_RUN) return { status: 'dry_run' };

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
  const confirm = await page.$('button[data-testid$="-unfollow"]');
  return { status: confirm ? 'followed' : 'click_not_confirmed' };
}

// ─── PROSPECTS FILE ───
function generateProspectsMD(prospects) {
  let md = '# Job Radar — Hiring Prospects\n';
  md += `_Auto-generated by job-radar bot. Last updated: ${new Date().toISOString().split('T')[0]}_\n\n`;

  const hiring = prospects.prospects.filter(p => p.isHiring);
  const watching = prospects.prospects.filter(p => !p.isHiring);

  if (hiring.length > 0) {
    md += `## Actively Hiring (${hiring.length})\n\n`;
    for (const p of hiring) {
      md += `### @${p.handle}${p.name ? ' — ' + p.name : ''}\n`;
      md += `- **Bio**: ${(p.bio || '—').substring(0, 200)}\n`;
      md += `- **Signals**: ${(p.signals || []).join(', ')}\n`;
      if (p.careersLink) md += `- **Careers**: ${p.careersLink}\n`;
      if (p.website) md += `- **Website**: ${p.website}\n`;
      if (p.location) md += `- **Location**: ${p.location}\n`;
      md += `- **Following**: ${p.isFollowing ? 'Yes' : 'No'}\n`;
      md += `- **First seen**: ${(p.firstSeen || '—').split('T')[0]}\n`;
      md += `- **Last scanned**: ${(p.lastScanned || '—').split('T')[0]}\n\n`;
    }
  }

  if (watching.length > 0) {
    md += `## Watching (${watching.length})\n\n`;
    for (const p of watching) {
      md += `- **@${p.handle}**${p.name ? ' (' + p.name + ')' : ''}`;
      if (p.bio) md += ` — ${p.bio.substring(0, 80)}`;
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
  fs.writeFileSync(PROSPECTS_MD, generateProspectsMD(data));
  return existing ? 'updated' : 'new';
}

// ─── COMMENT GENERATION ───
async function generateEngagement(tweetText, tweetAuthor, authorBio, authorCompany, listStrategy) {
  const gp = loadText(PROMPT_PATH);
  if (!gp) return null;

  const fb = loadJSON(FEEDBACK_PATH, { approvals: [], rejections: [], edits: [] });
  let fbCtx = '';
  const ra = fb.approvals.slice(-5);
  if (ra.length > 0) {
    fbCtx += 'COMMENTS APPROVED:\n';
    ra.forEach(a => { fbCtx += `- "${a.commentText}"\n`; });
  }
  const re = fb.edits.slice(-3);
  if (re.length > 0) {
    fbCtx += 'REWRITES:\n';
    re.forEach(e => { fbCtx += `- "${e.editedComment}"\n`; });
  }

  const currentWork = loadTextNoComments(CURRENT_WORK_PATH);

  const prompt = gp
    .replace('{FEEDBACK_CONTEXT}', fbCtx || 'No feedback yet.')
    .replace('{AUTHOR}', tweetAuthor)
    .replace('{AUTHOR_BIO}', authorBio || 'Not available')
    .replace('{AUTHOR_COMPANY}', authorCompany || 'Unknown')
    .replace('{TWEET_TEXT}', tweetText)
    .replace('{LIST_STRATEGY}', listStrategy)
    .replace('{CURRENT_WORK}', currentWork || 'Building things')
    .replace('{LINKEDIN_URL}', LINKEDIN_URL || 'Not set')
    .replace('{GITHUB_URL}', GITHUB_URL || 'Not set')
    .replace('{PORTFOLIO_URL}', PORTFOLIO_URL || 'Not set');

  const text = await callClaude({ apiKey: API_KEY, prompt, maxTokens: 500 });
  if (!text) return null;
  if (text.trim() === 'SKIP' || text.trim().startsWith('SKIP')) return null;

  const opts = parseLetterOptions(text, 'E');
  // M8 fix: do NOT filter out 'hiring' or 'job' — this is the job-radar bot,
  // those words are often legitimate in context. Only filter obviously broken
  // outputs and self-promotional spam.
  const valid = opts.filter(o =>
    o !== 'SKIP' &&
    !o.startsWith('SKIP') &&
    !o.toLowerCase().includes('i need to see') &&
    !o.toLowerCase().includes('please provide') &&
    !o.toLowerCase().includes('voice prompt') &&
    !o.toLowerCase().includes("i'm looking") &&
    !o.toLowerCase().includes('check out my') &&
    o.length >= 15 && o.length <= 280
  );

  if (valid.length === 0) return null;
  return weightedPick(valid, OPTION_WEIGHTS);
}

// ─── POST COMMENT ───
async function postCommentJR(page, tweetUrl, commentText) {
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

// ─── COMMANDS ───
async function handleCallback(update) {
  const d = update.callback_query.data;
  const parts = d.split('_');
  const action = parts[0];
  const id = parts.slice(1).join('_');
  await tg.answerCallback(update.callback_query.id);

  const pending = pendingStore.get(id);
  if (!pending) return;

  if (action === 'jrok') {
    pendingStore.delete(id);
  } else if (action === 'jrfb') {
    pendingStore.update(id, p => ({ ...p, waitingFeedback: true }));
    await tg.send('💬 Type feedback for this comment:');
  }
}

async function handleFeedbackText(txt) {
  const fbEntry = pendingStore.findByPredicate(p => p.waitingFeedback);
  if (!fbEntry) return false;
  const [fbId, fbData] = fbEntry;
  const fb = loadJSON(FEEDBACK_PATH, { approvals: [], rejections: [], edits: [] });
  fb.rejections.push({
    date: new Date().toISOString(),
    author: fbData.author,
    tweetUrl: fbData.tweetUrl,
    commentText: fbData.comment,
    reason: txt,
  });
  saveJSON(FEEDBACK_PATH, fb);
  await tg.send('📝 Feedback saved. Will improve.');
  pendingStore.delete(fbId);
  return true;
}

async function handleCommand(txt) {
  const cmd = txt.toLowerCase();

  if (cmd === '/jrstop') {
    const state = loadState();
    state.paused = true;
    saveState(state);
    await tg.send('⏸ <b>Job Radar paused.</b> /jrstart to resume.');
  } else if (cmd === '/jrstart') {
    const state = loadState();
    state.paused = false;
    saveState(state);
    await tg.send('▶️ <b>Job Radar resumed!</b>');
  } else if (cmd === '/jrstats') {
    const logs = loadLogs();
    const data = loadProspects();
    const state = loadState();
    const dayKey = new Date().toISOString().split('T')[0];
    const hourKey = new Date().toISOString().substring(0, 13);
    const hiring = data.prospects.filter(p => p.isHiring).length;
    const total = data.prospects.length;
    const following = data.prospects.filter(p => p.isFollowing).length;

    let msg = '🎯 <b>Job Radar Stats</b>\n\n';
    msg += `State: ${state.paused ? '⏸ Paused' : '▶️ Running'}\n`;
    msg += `Prospects: ${total} tracked\n`;
    msg += `🟢 Hiring: ${hiring}\n`;
    msg += `👥 Following: ${following}\n`;
    msg += `Comments today: ${logs.daily[dayKey] || 0}/${MAX_PER_DAY}\n`;
    msg += `This hour: ${logs.hourly[hourKey] || 0}/${MAX_PER_HOUR}\n`;
    if (state.lastScan) msg += `Last scan: ${new Date(state.lastScan).toISOString().split('T')[0]}\n`;
    await tg.send(msg);
  } else if (cmd === '/jrscan') {
    const state = loadState();
    state.lastScan = 0;
    saveState(state);
    await tg.send('🔍 <b>Forcing full profile scan on next cycle...</b>');
  } else if (cmd === '/jrprospects') {
    const data = loadProspects();
    const hiring = data.prospects.filter(p => p.isHiring);
    if (hiring.length === 0) {
      await tg.send('No hiring prospects found yet. Run /jrscan to scan.');
    } else {
      let msg = `🎯 <b>Hiring Prospects (${hiring.length})</b>\n\n`;
      for (const p of hiring.slice(0, 15)) {
        msg += `• <b>@${p.handle}</b>${p.name ? ' (' + p.name + ')' : ''}\n`;
        msg += `  ${p.signals.slice(0, 2).join(', ')}\n`;
        if (p.careersLink) msg += `  🔗 ${p.careersLink}\n`;
      }
      if (hiring.length > 15) msg += `\n... and ${hiring.length - 15} more. See jobs/prospects.md`;
      await tg.send(msg);
    }
  } else if (cmd === '/jrhelp') {
    await tg.send(
      '🎯 <b>Job Radar Commands</b>\n\n' +
      '/jrstart — Resume\n/jrstop — Pause\n/jrstats — Stats\n' +
      '/jrscan — Force profile scan\n/jrprospects — Show hiring prospects\n' +
      '/jrhelp — This message'
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

// ─── FULL PROFILE SCAN ───
async function runProfileScan(page, listUrl, listName) {
  const label = listName ? ' (' + listName + ')' : '';
  console.log('\n━━━ Starting full profile scan' + label + ' ━━━');
  await tg.send(`🔍 <b>Job Radar: Scanning${label}...</b>`);

  const members = await scrapeListMembers(page, listUrl);
  if (members.length === 0) {
    console.log('No members found in list');
    await tg.send('⚠️ No members found in list. Check session.');
    return;
  }

  const newHiring = [];
  const newFollowed = [];
  let scanned = 0;

  for (const member of members) {
    scanned++;
    const lab = `[${scanned}/${members.length}] @${member.handle}`;

    try {
      console.log('Scanning ' + lab);
      const profile = await scrapeProfile(page, member.handle);
      if (!profile) { console.log('  → account not found'); continue; }

      const hiring = detectHiring(profile);
      const result = updateProspect(member.handle, member.name, profile, hiring);

      if (hiring.isHiring) {
        console.log('  🟢 HIRING: ' + hiring.signals.join(', '));
        if (result === 'new' || !profile.isFollowing) {
          newHiring.push({
            handle: member.handle,
            name: member.name,
            signals: hiring.signals,
            careersLink: hiring.careersLink,
          });
        }
        if (!profile.isFollowing) {
          const followResult = await followUser(page, member.handle);
          console.log('  → follow: ' + followResult.status);
          if (followResult.status === 'followed' || followResult.status === 'dry_run') {
            newFollowed.push(member.handle);
            const data = loadProspects();
            const p = data.prospects.find(p => p.handle.toLowerCase() === member.handle.toLowerCase());
            if (p) { p.isFollowing = true; saveProspects(data); }
          }
        }
      } else if (result === 'new') {
        console.log('  → tracked (not hiring)');
      }
    } catch (e) {
      console.log('  ❌ error: ' + e.message.substring(0, 60));
    }

    if (scanned < members.length) {
      const delay = randDelay(PROFILE_VISIT_DELAY_MIN, PROFILE_VISIT_DELAY_MAX);
      console.log('  waiting ' + Math.round(delay / 1000) + 's...');
      await sleep(delay);
    }
  }

  const data = loadProspects();
  const totalHiring = data.prospects.filter(p => p.isHiring).length;

  let summary = '━━━ Scan Complete ━━━\n';
  summary += 'Scanned: ' + scanned + ' profiles\n';
  summary += 'Total hiring: ' + totalHiring + '\n';
  summary += 'New follows: ' + newFollowed.length + '\n';
  console.log('\n' + summary);

  let tgMsg = '🔍 <b>Job Radar Scan Complete</b>\n\n';
  tgMsg += `📊 Scanned: ${scanned} profiles\n`;
  tgMsg += `🟢 Total hiring: ${totalHiring}\n`;
  tgMsg += `👥 New follows: ${newFollowed.length}\n`;

  if (newHiring.length > 0) {
    tgMsg += '\n<b>New hiring signals:</b>\n';
    for (const h of newHiring.slice(0, 10)) {
      tgMsg += `• @${h.handle} — ${h.signals[0]}`;
      if (h.careersLink) tgMsg += ' 🔗';
      tgMsg += '\n';
    }
  }

  await tg.send(tgMsg);

  const state = loadState();
  state.lastScan = Date.now();
  saveState(state);
}

// ─── MAIN ───
async function main() {
  console.log('🎯 Job Radar starting...');
  if (DRY_RUN) console.log('*** DRY RUN — no follows or comments will be posted ***');
  if (SCAN_ONLY) console.log('*** SCAN ONLY — will scan profiles and exit ***');

  ensureDirs();

  const config = loadJSON(CONFIG_PATH, { lists: [] });
  const targetLists = config.lists.filter(l => l.jobRadar === true);
  if (targetLists.length === 0) {
    console.error('No lists flagged with "jobRadar": true in config.json');
    process.exit(1);
  }

  const { browser, page } = await launchBrowser({ sessionPath: SESSION_PATH });

  console.log('Verifying login...');
  if (!(await verifyLogin(page))) {
    await tg.send('❌ X session expired. Run: npm run setup-cookies');
    await browser.close();
    process.exit(1);
  }
  console.log('Logged in!');

  pendingStore.gc(PENDING_TTL_MS);

  const seen = loadSet(JR_SEEN_PATH);
  const state = loadState();
  const logs = loadLogs();
  const dayKey = new Date().toISOString().split('T')[0];

  await tg.send(
    '🎯 <b>Job Radar online!</b>\n\n' +
    `• Identity: @${ME.username}\n` +
    `• Monitoring: ${targetLists.map(l => l.name).join(', ')}\n` +
    `• Mode: ${DRY_RUN ? 'DRY RUN' : (SCAN_ONLY ? 'SCAN ONLY' : 'LIVE')}\n` +
    `• Comment limits: ${MAX_PER_HOUR}/hr, ${MAX_PER_DAY}/day\n` +
    `• Today so far: ${logs.daily[dayKey] || 0} comments\n` +
    `• State: ${state.paused ? 'PAUSED' : 'RUNNING'}\n\n` +
    '/jrstop /jrstart /jrstats /jrscan /jrprospects /jrhelp'
  );

  if (SCAN_ONLY) {
    for (const list of targetLists) {
      await runProfileScan(page, list.url, list.name);
    }
    await browser.close();
    return;
  }

  function getProfileContext(handle) {
    const data = loadProspects();
    const p = data.prospects.find(p => p.handle.toLowerCase() === handle.toLowerCase());
    return p ? { bio: p.bio || '', company: p.name || '', isHiring: p.isHiring } : null;
  }

  while (true) {
    try {
      await checkTGCommands();
      const currentState = loadState();

      if (currentState.paused) {
        console.log('Paused.');
        await page.waitForTimeout(CHECK_INTERVAL_MS);
        continue;
      }

      const timeSinceScan = Date.now() - (currentState.lastScan || 0);
      if (timeSinceScan >= SCAN_INTERVAL_MS) {
        for (const list of targetLists) {
          await runProfileScan(page, list.url, list.name);
        }
      }

      const currentLogs = loadLogs();
      const rateCheck = rateLimiter.canComment(currentLogs);
      let postedThisCycle = false;

      if (rateCheck.ok) {
        for (const currentList of targetLists) {
          if (postedThisCycle) break;

          const tweets = await scrapeList(page, currentList.url);
          console.log(`Found ${tweets.length} tweets in "${currentList.name}"`);

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

            const freshLogs = loadLogs();
            const check = rateLimiter.canComment(freshLogs);
            if (!check.ok) { console.log('Rate limit: ' + check.reason); break; }

            const isSolicitation = isSolicitationTweet(tw.text);

            if (!isSolicitation && !rateLimiter.canCommentOnAuthor(freshLogs, tw.author)) {
              console.log(`Skipping @${tw.author} (commented recently)`);
              seen.add(tw.tweetUrl);
              continue;
            }

            if (!isSolicitation && Math.random() < RANDOM_SKIP_RATE) {
              console.log(`Selective skip @${tw.author}`);
              seen.add(tw.tweetUrl);
              continue;
            }

            const profileCtx = getProfileContext(tw.author);
            const authorBio = profileCtx ? profileCtx.bio : '';
            const authorCompany = profileCtx ? profileCtx.company : '';

            const flags = [];
            if (profileCtx?.isHiring) flags.push('HIRING');
            if (isSolicitation) flags.push('SOLICITATION');
            console.log(`Engaging with @${tw.author}${flags.length ? ' [' + flags.join(', ') + ']' : ''}`);

            const comment = await generateEngagement(
              tw.text, tw.author, authorBio, authorCompany, currentList.strategy
            );

            if (!comment) {
              console.log('Skipped — no confident comment');
              seen.add(tw.tweetUrl);
              continue;
            }

            const delay = (PRE_COMMENT_DELAY_MIN + Math.random() * (PRE_COMMENT_DELAY_MAX - PRE_COMMENT_DELAY_MIN)) * 1000;
            console.log(`Posting in ${Math.round(delay / 1000)}s...`);
            await page.waitForTimeout(delay);

            try {
              await postCommentJR(page, tw.tweetUrl, comment);
              rateLimiter.recordComment(freshLogs, tw.author, tw.tweetUrl, comment);
              saveLogs(freshLogs);
              seen.add(tw.tweetUrl);
              saveSet(JR_SEEN_PATH, seen);

              console.log(`✅ Engaged with @${tw.author} [${currentList.name}]`);
              const commentId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
              pendingStore.set(commentId, {
                author: tw.author,
                tweetUrl: tw.tweetUrl,
                comment,
                waitingFeedback: false,
              });

              const tgFlags = [];
              if (profileCtx?.isHiring) tgFlags.push('HIRING');
              if (isSolicitation) tgFlags.push('🎤 PITCH REPLY');
              await tg.send(
                `🎯 <b>Job Radar commented on @${tw.author}</b> · <i>${currentList.name}</i>` +
                (tgFlags.length ? ' [' + tgFlags.join(', ') + ']' : '') + '\n\n' +
                `💬 ${comment}\n\n` +
                `🔗 ${tw.tweetUrl}`,
                {
                  inline_keyboard: [[
                    { text: '✅ Good', callback_data: `jrok_${commentId}` },
                    { text: '💬 Feedback', callback_data: `jrfb_${commentId}` },
                  ]],
                }
              );
              postedThisCycle = true;
            } catch (e) {
              console.log('Failed to post: ' + e.message);
              seen.add(tw.tweetUrl);
              saveSet(JR_SEEN_PATH, seen);
            }

            break;
          }
        }
      } else {
        console.log('Rate limited: ' + rateCheck.reason);
      }

      pendingStore.gc(PENDING_TTL_MS);
      await page.waitForTimeout(CHECK_INTERVAL_MS);
    } catch (e) {
      console.error('Error:', e.message);
      await tg.send(`⚠️ Job Radar error: ${e.message.substring(0, 100)}`);
      await page.waitForTimeout(30000);
    }
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
