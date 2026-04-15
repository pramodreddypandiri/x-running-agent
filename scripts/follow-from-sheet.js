// Follow X handles from AI_Memory_Startups_FINAL.xlsx using the saved Playwright session.
// Usage: node scripts/follow-from-sheet.js [--dry-run] [--file=path.xlsx]
require('dotenv').config();
const { chromium } = require('playwright');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

const SESSION_PATH = process.env.SESSION_PATH || './x-session.json';
const FOLLOWED_LOG = './data/followed.json';
const DEFAULT_SHEET = './AI_Memory_Startups_FINAL.xlsx';

// Rate-limit-friendly delays (X allows roughly hundreds of follows/day, but
// we stay well under that — randomized waits look more human).
const DELAY_MIN_MS = 15 * 1000;
const DELAY_MAX_MS = 40 * 1000;
const PROFILE_LOAD_WAIT_MS = 3500;

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const fileArg = args.find(a => a.startsWith('--file='));
const SHEET_PATH = fileArg ? fileArg.split('=')[1] : DEFAULT_SHEET;

function loadJSON(p, fb) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } }
function saveJSON(p, d) { fs.writeFileSync(p, JSON.stringify(d, null, 2)); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function randDelay() { return DELAY_MIN_MS + Math.random() * (DELAY_MAX_MS - DELAY_MIN_MS); }

function extractHandles(sheetPath) {
  const wb = XLSX.readFile(sheetPath);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet);

  const handles = [];
  const seen = new Set();
  rows.forEach(row => {
    const company = row['Company'];
    const xUrl = row['X / Twitter'];
    if (xUrl && typeof xUrl === 'string') {
      const m = xUrl.match(/x\.com\/([A-Za-z0-9_]+)/);
      if (m && !seen.has(m[1].toLowerCase())) {
        seen.add(m[1].toLowerCase());
        handles.push({ handle: m[1], type: 'company', company });
      }
    }
    const founder = row['Founder X Handle'];
    if (founder && typeof founder === 'string') {
      const m = founder.match(/@([A-Za-z0-9_]+)/);
      if (m && !seen.has(m[1].toLowerCase())) {
        seen.add(m[1].toLowerCase());
        handles.push({ handle: m[1], type: 'founder', company });
      }
    }
  });
  return handles;
}

async function followOne(page, handle) {
  const url = 'https://x.com/' + handle;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(PROFILE_LOAD_WAIT_MS);

  // Detect account state
  const pageText = (await page.content()).toLowerCase();
  if (pageText.includes("this account doesn't exist") || pageText.includes('account suspended')) {
    return { status: 'not_found' };
  }

  // If "Following" button exists, we're already following
  const alreadyFollowing = await page.$('button[data-testid$="-unfollow"]');
  if (alreadyFollowing) return { status: 'already_following' };

  // Primary follow button selector — X uses data-testid ending in "-follow"
  const followBtn = await page.$('button[data-testid$="-follow"]:not([data-testid$="-unfollow"])');
  if (!followBtn) {
    // Fallback: button with visible "Follow" text inside profile header
    const viaText = await page.$('div[data-testid="primaryColumn"] button:has-text("Follow")');
    if (!viaText) return { status: 'button_not_found' };
    if (DRY_RUN) return { status: 'dry_run' };
    await viaText.click();
    await page.waitForTimeout(1500);
    return { status: 'followed' };
  }

  if (DRY_RUN) return { status: 'dry_run' };
  await followBtn.click();
  await page.waitForTimeout(1500);

  // Verify the click worked — button should now be "Unfollow"
  const confirm = await page.$('button[data-testid$="-unfollow"]');
  return { status: confirm ? 'followed' : 'click_not_confirmed' };
}

async function main() {
  if (!fs.existsSync(SESSION_PATH)) {
    console.error('Session not found at ' + SESSION_PATH + '. Run: npm run setup-cookies');
    process.exit(1);
  }
  if (!fs.existsSync(SHEET_PATH)) {
    console.error('Sheet not found at ' + SHEET_PATH);
    process.exit(1);
  }

  const handles = extractHandles(SHEET_PATH);
  console.log('Loaded ' + handles.length + ' handles from ' + SHEET_PATH);
  if (DRY_RUN) console.log('*** DRY RUN — no actual follows will be performed ***');

  const log = loadJSON(FOLLOWED_LOG, { followed: [], failed: [], skipped: [] });
  const alreadyDone = new Set(log.followed.map(f => f.handle.toLowerCase()));
  const todo = handles.filter(h => !alreadyDone.has(h.handle.toLowerCase()));
  console.log(todo.length + ' new handles to process (' + alreadyDone.size + ' already in log)');

  if (!fs.existsSync('./data')) fs.mkdirSync('./data', { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ storageState: SESSION_PATH });
  const page = await ctx.newPage();

  let i = 0;
  for (const h of todo) {
    i++;
    const label = '[' + i + '/' + todo.length + '] @' + h.handle + ' (' + h.type + ' · ' + h.company + ')';
    try {
      const res = await followOne(page, h.handle);
      const stamp = new Date().toISOString();
      if (res.status === 'followed' || res.status === 'dry_run') {
        console.log('✅ ' + label + ' → ' + res.status);
        log.followed.push({ ...h, status: res.status, time: stamp });
      } else if (res.status === 'already_following') {
        console.log('↪️  ' + label + ' → already following');
        log.followed.push({ ...h, status: res.status, time: stamp });
      } else {
        console.log('⚠️  ' + label + ' → ' + res.status);
        log.failed.push({ ...h, status: res.status, time: stamp });
      }
      saveJSON(FOLLOWED_LOG, log);
    } catch (e) {
      console.log('❌ ' + label + ' → error: ' + e.message);
      log.failed.push({ ...h, status: 'error', error: e.message, time: new Date().toISOString() });
      saveJSON(FOLLOWED_LOG, log);
    }

    if (i < todo.length) {
      const d = randDelay();
      console.log('   waiting ' + Math.round(d / 1000) + 's...');
      await sleep(d);
    }
  }

  await browser.close();

  const ok = log.followed.filter(f => f.status === 'followed').length;
  const already = log.followed.filter(f => f.status === 'already_following').length;
  const dry = log.followed.filter(f => f.status === 'dry_run').length;
  console.log('\n━━━ Summary ━━━');
  console.log('Newly followed: ' + ok);
  console.log('Already following: ' + already);
  if (dry) console.log('Dry-run (not actually followed): ' + dry);
  console.log('Failed: ' + log.failed.length);
  console.log('Full log: ' + FOLLOWED_LOG);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
