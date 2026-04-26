const { chromium } = require('playwright');

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function launchBrowser({ sessionPath, headless = true, useSandbox = true } = {}) {
  const args = useSandbox ? [] : ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'];
  const browser = await chromium.launch({ headless, args });
  const ctx = await browser.newContext({
    storageState: sessionPath,
    viewport: { width: 1280, height: 720 },
    userAgent: DEFAULT_USER_AGENT,
  });
  const page = await ctx.newPage();
  return { browser, ctx, page };
}

async function verifyLogin(page) {
  await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);
  const url = page.url();
  if (url.includes('/login') || url.includes('/i/flow/login')) return false;
  return true;
}

module.exports = { launchBrowser, verifyLogin, DEFAULT_USER_AGENT };
