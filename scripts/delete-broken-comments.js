// Deletes all broken whale comments from today
require('dotenv').config();
const { chromium } = require('playwright');

const SESSION_PATH = process.env.SESSION_PATH || './x-session.json';
const USERNAME = process.env.X_USERNAME || 'PramodReddy1606';

const BROKEN_TWEETS = [
  'https://x.com/F1/status/2038315753145794601',
  'https://x.com/IAmSteveHarvey/status/2038317750792458740',
  'https://x.com/realthomasgu/status/2038322954879300020',
  'https://x.com/visacashapprb/status/2038322799484276750',
];

async function deleteComment(page, tweetUrl) {
  console.log('Opening: ' + tweetUrl);
  await page.goto(tweetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  const articles = await page.$$('article[data-testid="tweet"]');
  for (const article of articles) {
    const nameEl = await article.$('div[data-testid="User-Name"]');
    if (!nameEl) continue;
    const nameText = await nameEl.textContent();
    if (!nameText || !nameText.toLowerCase().includes(USERNAME.toLowerCase())) continue;

    // Found our comment — click the ... menu
    const moreBtn = await article.$('button[data-testid="caret"]');
    if (!moreBtn) { console.log('  No menu button found'); continue; }
    await moreBtn.click();
    await page.waitForTimeout(1000);

    // Click delete
    const menuItems = await page.$$('div[role="menuitem"]');
    for (const item of menuItems) {
      const text = await item.textContent();
      if (text && text.includes('Delete')) {
        await item.click();
        await page.waitForTimeout(1000);
        // Confirm delete
        const confirmBtn = await page.$('button[data-testid="confirmationSheetConfirm"]');
        if (confirmBtn) {
          await confirmBtn.click();
          await page.waitForTimeout(2000);
          console.log('  ✅ Deleted!');
        }
        return true;
      }
    }
    console.log('  No delete option found in menu');
  }
  console.log('  Comment not found (may already be deleted)');
  return false;
}

async function main() {
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext({
    storageState: SESSION_PATH,
    viewport: { width: 1280, height: 720 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await ctx.newPage();

  for (const url of BROKEN_TWEETS) {
    try {
      await deleteComment(page, url);
    } catch (e) {
      console.log('  Error: ' + e.message);
    }
    await page.waitForTimeout(2000);
  }

  console.log('\nDone! Check the replies on whale-watch.json too.');
  await browser.close();
}

main().catch(console.error);
