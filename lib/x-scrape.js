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
      } catch (e) {}
    });
    return res;
  });
}

async function scrapeHomeTimeline(page, myUsernameLC) {
  await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.scrollBy(0, 800));
    await page.waitForTimeout(1500);
  }

  return await page.evaluate((me) => {
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
        if (me && author.toLowerCase() === me) return;
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
  }, myUsernameLC || '');
}

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

async function postOriginalTweet(page, text) {
  await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2000 + Math.random() * 2000);
  const box = await page.waitForSelector('div[data-testid="tweetTextarea_0"]', { timeout: 10000 });
  await box.click();
  await page.waitForTimeout(400 + Math.random() * 400);
  await page.keyboard.type(text, { delay: 30 + Math.random() * 40 });
  await page.waitForTimeout(1000 + Math.random() * 1000);
  const btn = await page.waitForSelector('button[data-testid="tweetButtonInline"]', { timeout: 5000 });
  await btn.click();
  await page.waitForTimeout(3000);
  return true;
}

async function deleteOwnComment(page, tweetUrl, myUsernameLC) {
  try {
    await page.goto(tweetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
    const articles = await page.$$('article[data-testid="tweet"]');
    for (const article of articles) {
      const nameEl = await article.$('div[data-testid="User-Name"]');
      if (!nameEl) continue;
      const nameText = await nameEl.textContent();
      if (!nameText || !nameText.toLowerCase().includes(myUsernameLC)) continue;
      const moreBtn = await article.$('[data-testid="caret"]');
      if (!moreBtn) continue;
      await moreBtn.click();
      await page.waitForTimeout(1000);
      const menuItems = await page.$$('[role="menuitem"]');
      for (const item of menuItems) {
        const t = await item.textContent();
        if (t && t.includes('Delete')) { await item.click(); break; }
      }
      await page.waitForTimeout(1000);
      const confirmBtn = await page.$('[data-testid="confirmationSheetConfirm"]');
      if (confirmBtn) await confirmBtn.click();
      await page.waitForTimeout(1000);
      return true;
    }
    return false;
  } catch (e) {
    console.error('Delete error:', e.message);
    return false;
  }
}

async function randomLike(page, tweetUrl, probability = 0.4) {
  if (Math.random() > probability) return false;
  try {
    await page.goto(tweetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1500 + Math.random() * 2000);
    const lb = await page.$('button[data-testid="like"]');
    if (lb) {
      await lb.click();
      await page.waitForTimeout(1000 + Math.random() * 2000);
      return true;
    }
  } catch (e) {}
  return false;
}

module.exports = {
  scrapeList,
  scrapeHomeTimeline,
  postComment,
  postOriginalTweet,
  deleteOwnComment,
  randomLike,
};
