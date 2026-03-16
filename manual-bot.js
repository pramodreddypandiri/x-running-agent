const { chromium } = require('playwright');
const fs = require('fs');

// ─── PATHS ───
const CONFIG_PATH = process.env.CONFIG_PATH || './config.json';
const SESSION_PATH = process.env.SESSION_PATH || './x-session.json';
const LOG_PATH = './data/manual-logs.json';
const PROMPT_PATH = process.env.MANUAL_PROMPT_PATH || './prompts/manual-prompt.txt';
const FEEDBACK_PATH = './data/feedback.json';
const VIRAL_PATH = './data/viral-patterns.txt';
const SEEN_PATH = './data/manual-seen.json';
const STATE_PATH = './data/manual-state.json';

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;
const API_KEY = process.env.ANTHROPIC_API_KEY;
const CHECK_MS = 5 * 60 * 1000;

// ─── STATE (paused, tweet window, etc) ───
function loadState() {
  return loadJSON(STATE_PATH, { paused: false, maxTweetAgeMin: 30 });
}
function saveState(s) { saveJSON(STATE_PATH, s); }

// ─── HELPERS ───
function loadJSON(p, fb) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } }
function saveJSON(p, d) { fs.writeFileSync(p, JSON.stringify(d, null, 2)); }
function loadText(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } }

// ─── FEEDBACK ───
function loadFeedback() { return loadJSON(FEEDBACK_PATH, { approvals: [], rejections: [], edits: [] }); }
function saveFeedback(fb) { saveJSON(FEEDBACK_PATH, fb); }
function addApproval(ta, tt, oi, ol, ct, ao, ln) {
  const fb = loadFeedback();
  fb.approvals.push({ date: new Date().toISOString(), tweetAuthor: ta, tweetText: tt.substring(0,200), chosenOption: ol, commentText: ct, rejectedOptions: ao.filter((_,i)=>i!==oi).map(c=>c.substring(0,200)), listName: ln });
  saveFeedback(fb);
}
function addRejection(ta, tt, reason, ac, ln) {
  const fb = loadFeedback();
  fb.rejections.push({ date: new Date().toISOString(), tweetAuthor: ta, tweetText: tt.substring(0,200), reason, rejectedComments: ac.map(c=>c.substring(0,200)), listName: ln });
  saveFeedback(fb);
}
function addEdit(ta, tt, oc, ec, ln) {
  const fb = loadFeedback();
  fb.edits.push({ date: new Date().toISOString(), tweetAuthor: ta, tweetText: tt.substring(0,200), originalComments: oc.map(c=>c.substring(0,200)), editedComment: ec, listName: ln });
  saveFeedback(fb);
}
function buildFeedbackContext() {
  const fb = loadFeedback(); let ctx = '';
  const ra = fb.approvals.slice(-15);
  if (ra.length > 0) { ctx += 'COMMENTS TALHA APPROVED:\n'; ra.forEach(a => { ctx += '- @' + a.tweetAuthor + ' -> chose ' + a.chosenOption + ': "' + a.commentText + '"\n'; }); ctx += '\n'; }
  const rr = fb.rejections.slice(-10);
  if (rr.length > 0) { ctx += 'COMMENTS TALHA REJECTED:\n'; rr.forEach(r => { ctx += '- Reason: ' + r.reason + '. Example: "' + (r.rejectedComments[0]||'').substring(0,80) + '"\n'; }); ctx += '\n'; }
  const re = fb.edits.slice(-5);
  if (re.length > 0) { ctx += 'TALHA EDITS:\n'; re.forEach(e => { ctx += '- "' + e.editedComment + '"\n'; }); ctx += '\n'; }
  if (fb.approvals.length >= 10) {
    const oc = {}; fb.approvals.slice(-30).forEach(a => { oc[a.chosenOption] = (oc[a.chosenOption]||0)+1; });
    const s = Object.entries(oc).sort((a,b)=>b[1]-a[1]);
    ctx += 'PATTERN: Picks ' + s[0]?.[0] + ' most (' + s[0]?.[1] + 'x). Weight but vary.\n';
  }
  return ctx || 'No feedback yet.';
}

// ─── LOGGING ───
function loadLogs() { return loadJSON(LOG_PATH, { comments: [], dailyStats: {} }); }
function saveLogs(l) { saveJSON(LOG_PATH, l); }
function logComment(e) {
  const l = loadLogs(); l.comments.push({...e, timestamp: new Date().toISOString()});
  const t = new Date().toISOString().split('T')[0];
  if (!l.dailyStats[t]) l.dailyStats[t] = {commentsPosted:0, commentsApproved:0, commentsRejected:0, tweetsFound:0};
  if (e.status==='posted') l.dailyStats[t].commentsPosted++;
  if (e.status==='approved') l.dailyStats[t].commentsApproved++;
  if (e.status==='rejected') l.dailyStats[t].commentsRejected++;
  if (e.status==='found') l.dailyStats[t].tweetsFound++;
  saveLogs(l);
}

// ─── TELEGRAM ───
async function sendTG(text, rm) {
  const b = {chat_id: TG_CHAT, text, parse_mode: 'HTML'};
  if (rm) b.reply_markup = JSON.stringify(rm);
  const r = await fetch('https://api.telegram.org/bot'+TG_TOKEN+'/sendMessage', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(b)});
  return await r.json();
}
async function getTGUpdates(off) {
  const r = await fetch('https://api.telegram.org/bot'+TG_TOKEN+'/getUpdates?offset='+off+'&timeout=30');
  return await r.json();
}
async function answerCB(id) {
  await fetch('https://api.telegram.org/bot'+TG_TOKEN+'/answerCallbackQuery', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({callback_query_id:id})});
}

// ─── CLAUDE API ───
async function generateComments(tweetText, tweetAuthor, strategy, gp) {
  const fc = buildFeedbackContext();
  const vp = loadText(VIRAL_PATH) || 'No viral data yet.';
  const prompt = gp.replace('{FEEDBACK_CONTEXT}', fc).replace('{VIRAL_PATTERNS}', vp).replace('{LIST_STRATEGY}', strategy).replace('{AUTHOR}', tweetAuthor).replace('{TWEET_TEXT}', tweetText);
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method:'POST', headers:{'Content-Type':'application/json','x-api-key':API_KEY,'anthropic-version':'2023-06-01'},
    body: JSON.stringify({model:'claude-sonnet-4-20250514', max_tokens:800, messages:[{role:'user',content:prompt}]})
  });
  const d = await r.json();
  if (d.content && d.content[0]) {
    const t = d.content[0].text.trim(); const opts = []; const lines = t.split('\n').filter(l=>l.trim()); let cur = '';
    for (const line of lines) { if(line.match(/^[A-E]:/)){if(cur)opts.push(cur.trim());cur=line.replace(/^[A-E]:\s*/,'').replace(/^["']|["']$/g,'');}else if(cur){cur+=' '+line.trim();} }
    if (cur) opts.push(cur.trim());
    return opts.length > 0 ? opts : [t];
  }
  return null;
}

// ─── BROWSER ───
async function scrapeTweetList(page, listUrl) {
  console.log('Checking: ' + listUrl);
  await page.goto(listUrl, {waitUntil:'domcontentloaded', timeout:60000});
  await page.waitForTimeout(3000);
  await page.evaluate(() => window.scrollBy(0, 500));
  await page.waitForTimeout(2000);
  return await page.evaluate(() => {
    const els = document.querySelectorAll('article[data-testid="tweet"]'); const res = [];
    els.forEach(el => {
      try {
        const sc = el.querySelector('[data-testid="socialContext"]');
        if (sc && sc.textContent.includes('reposted')) return;
        const ia = el.querySelectorAll('article'); if (ia.length > 1) return;
        const ae = el.querySelector('div[data-testid="User-Name"] a');
        const author = ae ? ae.getAttribute('href').replace('/','') : 'unknown';
        const te = el.querySelector('div[data-testid="tweetText"]');
        const text = te ? te.innerText : '';
        const ti = el.querySelector('time');
        const time = ti ? ti.getAttribute('datetime') : null;
        let url = '';
        el.querySelectorAll('a[href*="/status/"]').forEach(l => {
          const h = l.getAttribute('href'); if (h && h.match(/\/status\/\d+$/)) url = 'https://x.com' + h;
        });
        if (text && url) res.push({author, text, time, tweetUrl: url});
      } catch(e) {}
    });
    return res;
  });
}

async function postComment(page, tweetUrl, commentText) {
  console.log('Posting on: ' + tweetUrl);
  await page.goto(tweetUrl, {waitUntil:'domcontentloaded', timeout:60000});
  await page.waitForTimeout(2000 + Math.random()*2000);
  const rb = await page.waitForSelector('div[data-testid="tweetTextarea_0"]', {timeout:10000});
  await rb.click(); await page.waitForTimeout(300 + Math.random()*500);
  await page.keyboard.type(commentText, {delay: 30 + Math.random()*50});
  await page.waitForTimeout(800 + Math.random()*1000);
  const btn = await page.waitForSelector('button[data-testid="tweetButtonInline"]', {timeout:5000});
  await btn.click(); await page.waitForTimeout(2000 + Math.random()*2000);
  return true;
}

async function randomLike(page, tw) {
  if (Math.random() > 0.4) return;
  try {
    await page.goto(tw.tweetUrl, {waitUntil:'domcontentloaded', timeout:60000});
    await page.waitForTimeout(1500 + Math.random()*2000);
    const lb = await page.$('button[data-testid="like"]');
    if (lb) { await lb.click(); console.log('Liked @'+tw.author); await page.waitForTimeout(1000+Math.random()*2000); }
  } catch(e) {}
}

// ─── APPROVAL QUEUE ───
const pendingApprovals = new Map();
const pendingRej = new Map();
let tgOff = 0;

async function requestApproval(tweet, comments, listName) {
  const id = Date.now().toString();
  const labels = ['A','B','C','D','E'];
  const types = ['One-liner','Question','Experience','Wild card','Nuance'];
  let msg = '\ud83d\udc26 <b>@'+tweet.author+'</b> \u00b7 <i>'+listName+'</i>\n\n<b>Tweet:</b>\n'+tweet.text.substring(0,400)+'\n\n';
  comments.forEach((c,i) => { if(i<5) msg += '<b>'+labels[i]+'</b> <i>('+types[i]+')</i>\n'+c+'\n\n'; });
  msg += '\ud83d\udd17 ' + tweet.tweetUrl;
  const r1 = comments.slice(0,5).map((_,i) => ({text:'\u2705 '+labels[i], callback_data:'ap_'+id+'_'+i}));
  const r2 = [{text:'\u274c Skip', callback_data:'sk_'+id}, {text:'\u270f\ufe0f Edit', callback_data:'ed_'+id}];
  await sendTG(msg, {inline_keyboard: [r1, r2]});
  pendingApprovals.set(id, {tweet, comments, listName, status:'pending', createdAt:Date.now()});
  logComment({tweetAuthor:tweet.author, tweetUrl:tweet.tweetUrl, listName, status:'found', approvalId:id});
}

// ─── POSTING QUEUE ───
const postQ = []; let posting = false;
async function processPostQ(page) {
  if (posting || postQ.length === 0) return;
  posting = true;
  while (postQ.length > 0) {
    const item = postQ.shift();
    try {
      await postComment(page, item.tweet.tweetUrl, item.comment);
      await sendTG('\u2705 Posted on @'+item.tweet.author+"'s tweet!");
      logComment({tweetAuthor:item.tweet.author, tweetUrl:item.tweet.tweetUrl, comment:item.comment, listName:item.listName, status:'posted'});
    } catch(e) { await sendTG('\u26a0\ufe0f Failed: '+e.message); }
    if (postQ.length > 0) {
      const d = (120 + Math.random()*180) * 1000;
      console.log('Next in '+Math.round(d/1000)+'s');
      await new Promise(r => setTimeout(r, d));
    }
  }
  posting = false;
}

// ─── TELEGRAM COMMANDS ───
async function handleCommand(text) {
  const state = loadState();
  const parts = text.trim().split(' ');
  const cmd = parts[0].toLowerCase();

  if (cmd === '/help') {
    await sendTG(
      '\ud83e\udd16 <b>X Agent Commands</b>\n\n' +
      '/status \u2014 Current status\n' +
      '/pause \u2014 Stop checking for tweets\n' +
      '/resume \u2014 Start checking again\n' +
      '/report \u2014 Today\'s stats\n' +
      '/set_window [min] \u2014 Change tweet age limit (current: ' + state.maxTweetAgeMin + ' min)\n' +
      '/lists \u2014 Show active lists\n' +
      '/queue \u2014 Show posting queue\n' +
      '/feedback \u2014 Show learning stats\n' +
      '/help \u2014 This message'
    );
    return true;
  }

  if (cmd === '/status') {
    const logs = loadLogs();
    const today = new Date().toISOString().split('T')[0];
    const s = logs.dailyStats[today] || {commentsPosted:0, tweetsFound:0, commentsRejected:0};
    const fb = loadFeedback();
    await sendTG(
      '\ud83d\udcca <b>Status</b>\n\n' +
      'State: ' + (state.paused ? '\u23f8 Paused' : '\u25b6\ufe0f Running') + '\n' +
      'Tweet window: ' + state.maxTweetAgeMin + ' min\n' +
      'Posting queue: ' + postQ.length + ' comments waiting\n\n' +
      '<b>Today:</b>\n' +
      'Tweets found: ' + s.tweetsFound + '\n' +
      'Comments posted: ' + s.commentsPosted + '\n' +
      'Skipped: ' + s.commentsRejected + '\n\n' +
      '<b>All-time learning:</b>\n' +
      'Approved: ' + fb.approvals.length + '\n' +
      'Rejected: ' + fb.rejections.length + '\n' +
      'Edits: ' + fb.edits.length
    );
    return true;
  }

  if (cmd === '/pause') {
    state.paused = true; saveState(state);
    await sendTG('\u23f8 <b>Paused.</b> I\'ll stop checking for new tweets. Pending approvals still work. Type /resume to continue.');
    return true;
  }

  if (cmd === '/resume') {
    state.paused = false; saveState(state);
    await sendTG('\u25b6\ufe0f <b>Resumed!</b> Checking for tweets again.');
    return true;
  }

  if (cmd === '/report') {
    await sendDailyReport();
    return true;
  }

  if (cmd === '/set_window') {
    const mins = parseInt(parts[1]);
    if (!mins || mins < 1 || mins > 1440) {
      await sendTG('Usage: /set_window [minutes]\nExample: /set_window 60\nCurrent: ' + state.maxTweetAgeMin + ' min\nRange: 1-1440');
      return true;
    }
    state.maxTweetAgeMin = mins; saveState(state);
    await sendTG('\u2705 Tweet window set to <b>' + mins + ' minutes</b>. Will only comment on tweets younger than ' + mins + ' min.');
    return true;
  }

  if (cmd === '/lists') {
    const config = loadJSON(CONFIG_PATH, {lists:[]});
    if (config.lists.length === 0) {
      await sendTG('No lists configured.');
      return true;
    }
    let msg = '\ud83d\udcdd <b>Active Lists (' + config.lists.length + ')</b>\n\n';
    config.lists.forEach((l, i) => {
      msg += '<b>' + (i+1) + '. ' + l.name + '</b>\n';
      msg += l.url + '\n';
      msg += '<i>' + l.strategy.substring(0, 100) + '...</i>\n\n';
    });
    await sendTG(msg);
    return true;
  }

  if (cmd === '/queue') {
    if (postQ.length === 0) {
      await sendTG('Posting queue is empty.');
    } else {
      let msg = '\ud83d\udce4 <b>Posting Queue (' + postQ.length + ')</b>\n\n';
      postQ.forEach((item, i) => {
        msg += (i+1) + '. @' + item.tweet.author + ': "' + item.comment.substring(0, 80) + '..."\n';
      });
      await sendTG(msg);
    }
    return true;
  }

  if (cmd === '/feedback') {
    const fb = loadFeedback();
    let msg = '\ud83e\udde0 <b>Learning Data</b>\n\n';
    msg += 'Total approved: ' + fb.approvals.length + '\n';
    msg += 'Total rejected: ' + fb.rejections.length + '\n';
    msg += 'Total edits: ' + fb.edits.length + '\n\n';
    if (fb.approvals.length >= 5) {
      const oc = {}; fb.approvals.slice(-30).forEach(a => { oc[a.chosenOption] = (oc[a.chosenOption]||0)+1; });
      const types = {A:'One-liner', B:'Question', C:'Experience', D:'Wild card', E:'Nuance'};
      const sorted = Object.entries(oc).sort((a,b)=>b[1]-a[1]);
      msg += '<b>Your top picks (last 30):</b>\n';
      sorted.forEach(([o,c]) => { msg += o + ' (' + (types[o]||o) + '): ' + c + ' times\n'; });
    }
    if (fb.rejections.length >= 3) {
      const rc = {}; fb.rejections.slice(-20).forEach(r => { rc[r.reason] = (rc[r.reason]||0)+1; });
      msg += '\n<b>Top skip reasons:</b>\n';
      Object.entries(rc).sort((a,b)=>b[1]-a[1]).forEach(([r,c]) => { msg += r + ': ' + c + '\n'; });
    }
    await sendTG(msg);
    return true;
  }

  return false; // Not a command
}

// ─── CHECK APPROVALS + COMMANDS ───
async function checkApprovals() {
  try {
    const u = await getTGUpdates(tgOff);
    if (!u.ok || !u.result) return;

    for (const up of u.result) {
      tgOff = up.update_id + 1;

      // Handle callback buttons (approve/reject/edit/rejection reasons)
      if (up.callback_query) {
        const d = up.callback_query.data; const p = d.split('_');
        const act = p[0]; const aid = p[1]; const oi = p[2] !== undefined ? parseInt(p[2]) : -1;
        await answerCB(up.callback_query.id);

        if (act === 'rr') {
          const pr = pendingRej.get(aid);
          if (pr) {
            const reasons = ['Too generic','Too self-promotional','Wrong tone','Not relevant','Too long','Sounds like AI'];
            addRejection(pr.tweet.author, pr.tweet.text, reasons[oi]||'Unknown', pr.comments, pr.listName);
            await sendTG('\ud83d\udcdd "' + (reasons[oi]||'Unknown') + '" \u2014 noted. Learning.');
            pendingRej.delete(aid);
          }
          continue;
        }

        const pend = pendingApprovals.get(aid); if (!pend) continue;

        if (act === 'ap' && oi >= 0) {
          const labels = ['A','B','C','D','E'];
          const chosen = pend.comments[oi];
          postQ.push({tweet:pend.tweet, comment:chosen, listName:pend.listName});
          addApproval(pend.tweet.author, pend.tweet.text, oi, labels[oi], chosen, pend.comments, pend.listName);
          await sendTG('\u2705 ' + labels[oi] + ' queued! (' + postQ.length + ' in queue)');
          logComment({tweetAuthor:pend.tweet.author, tweetUrl:pend.tweet.tweetUrl, comment:chosen, listName:pend.listName, status:'approved', approvalId:aid});
          pendingApprovals.delete(aid);
        } else if (act === 'sk') {
          const rk = {inline_keyboard:[[{text:'\ud83d\ude10 Generic',callback_data:'rr_'+aid+'_0'},{text:'\ud83c\udfaf Self-promo',callback_data:'rr_'+aid+'_1'},{text:'\ud83d\udde3 Wrong tone',callback_data:'rr_'+aid+'_2'}],[{text:'\ud83e\udd37 Not relevant',callback_data:'rr_'+aid+'_3'},{text:'\ud83d\udccf Too long',callback_data:'rr_'+aid+'_4'},{text:'\ud83e\udd16 Sounds AI',callback_data:'rr_'+aid+'_5'}]]};
          await sendTG('Why skip?', rk);
          pendingRej.set(aid, {tweet:pend.tweet, comments:pend.comments, listName:pend.listName});
          logComment({tweetAuthor:pend.tweet.author, tweetUrl:pend.tweet.tweetUrl, listName:pend.listName, status:'rejected', approvalId:aid});
          pendingApprovals.delete(aid);
        } else if (act === 'ed') {
          pend.status = 'editing';
          await sendTG('\u270f\ufe0f Type your comment:');
        }
      }

      // Handle text messages (commands or edits)
      if (up.message && up.message.text) {
        const txt = up.message.text;

        // Check if it's a command
        if (txt.startsWith('/')) {
          await handleCommand(txt);
          continue;
        }

        // Check if someone is editing
        const ee = [...pendingApprovals.entries()].find(([k,p]) => p.status === 'editing');
        if (ee) {
          const [eid, ed] = ee;
          addEdit(ed.tweet.author, ed.tweet.text, ed.comments, txt, ed.listName);
          postQ.push({tweet:ed.tweet, comment:txt, listName:ed.listName});
          await sendTG('\u2705 Your comment queued! (' + postQ.length + ')');
          pendingApprovals.delete(eid);
        }
      }
    }
  } catch(e) { console.error('Err:', e.message); }
}

// ─── DAILY REPORT ───
async function sendDailyReport() {
  const l = loadLogs(); const fb = loadFeedback();
  const today = new Date().toISOString().split('T')[0];
  const s = l.dailyStats[today] || {commentsPosted:0, tweetsFound:0, commentsRejected:0};
  let rpt = '\ud83d\udcca <b>Daily Report \u2014 ' + today + '</b>\n\n';
  rpt += '\ud83d\udc26 Tweets: ' + s.tweetsFound + '\n\u2705 Posted: ' + s.commentsPosted + '\n\u274c Skipped: ' + s.commentsRejected + '\n';
  const ta = fb.approvals.filter(a => a.date.startsWith(today));
  if (ta.length > 0) {
    const oc = {}; ta.forEach(a => {oc[a.chosenOption]=(oc[a.chosenOption]||0)+1;});
    const types = {A:'One-liner',B:'Question',C:'Experience',D:'Wild card',E:'Nuance'};
    rpt += '\n\ud83d\udcc8 <b>Picks:</b>\n';
    Object.entries(oc).sort((a,b)=>b[1]-a[1]).forEach(([o,c]) => {rpt += o+' ('+( types[o]||o)+'): '+c+'\n';});
  }
  const tr = fb.rejections.filter(r => r.date.startsWith(today));
  if (tr.length > 0) {
    const rc = {}; tr.forEach(r => {rc[r.reason]=(rc[r.reason]||0)+1;});
    rpt += '\n\ud83d\udeab <b>Skips:</b>\n';
    Object.entries(rc).forEach(([r,c]) => {rpt += r+': '+c+'\n';});
  }
  rpt += '\n\ud83d\udcda All-time: ' + fb.approvals.length + ' approved, ' + fb.rejections.length + ' rejected, ' + fb.edits.length + ' edits';
  await sendTG(rpt);
}

// ─── SEEN TWEETS ───
function loadSeenTweets() { try { return new Set(JSON.parse(fs.readFileSync(SEEN_PATH,'utf8'))); } catch { return new Set(); } }
function saveSeenTweets(s) { fs.writeFileSync(SEEN_PATH, JSON.stringify([...s])); }

// ─── MAIN ───
async function main() {
  console.log('X Comment Agent v4 starting...');
  if (!TG_TOKEN || !TG_CHAT || !API_KEY) { console.error('Missing env'); process.exit(1); }

  const config = loadJSON(CONFIG_PATH, null);
  if (!config) { console.error('No config'); process.exit(1); }
  const gp = loadText(PROMPT_PATH);
  if (!gp) { console.error('No prompt'); process.exit(1); }
  const seen = loadSeenTweets();
  const fb = loadFeedback();
  const state = loadState();

  const browser = await chromium.launch({headless:true, args:['--no-sandbox','--disable-setuid-sandbox','--disable-gpu']});
  const ctx = await browser.newContext({storageState:SESSION_PATH, viewport:{width:1280,height:720}, userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'});
  const page = await ctx.newPage();

  console.log('Verifying X login...');
  await page.goto('https://x.com/home', {waitUntil:'domcontentloaded', timeout:60000});
  await page.waitForTimeout(3000);
  const li = await page.evaluate(() => !document.querySelector('a[href="/login"]'));
  if (!li) { await sendTG('X session expired. Re-export cookies.'); process.exit(1); }

  console.log('Logged in!');
  await sendTG(
    '\ud83e\udd16 <b>X Agent v4 online!</b>\n\n' +
    '\u2022 5 options (A-E)\n' +
    '\u2022 Learning (' + fb.approvals.length + ' approved, ' + fb.rejections.length + ' rejected)\n' +
    '\u2022 ' + config.lists.length + ' list(s)\n' +
    '\u2022 Tweet window: ' + state.maxTweetAgeMin + ' min\n' +
    '\u2022 State: ' + (state.paused ? 'Paused' : 'Running') + '\n' +
    '\u2022 Random likes + batched posting\n\n' +
    'Type /help to see all commands.'
  );

  // Schedule daily report at 11 PM
  const sr = () => {
    const n = new Date(); const r = new Date(); r.setHours(23,0,0,0);
    if (r <= n) r.setDate(r.getDate()+1);
    setTimeout(async () => { await sendDailyReport(); sr(); }, r - n);
  };
  sr();

  // Main loop
  while (true) {
    try {
      const currentState = loadState();

      if (!currentState.paused) {
        const maxAge = currentState.maxTweetAgeMin * 60 * 1000;

        for (const list of config.lists) {
          const tweets = await scrapeTweetList(page, list.url);
          console.log('Found ' + tweets.length + ' in "' + list.name + '"');

          for (const tw of tweets) {
            if (seen.has(tw.tweetUrl)) continue;
            if (tw.time) {
              const age = Date.now() - new Date(tw.time).getTime();
              if (age > maxAge) { seen.add(tw.tweetUrl); continue; }
            }
            if (tw.author.toLowerCase() === (process.env.X_USERNAME || 'your_username')) { seen.add(tw.tweetUrl); continue; }

            console.log('New: @' + tw.author);
            await randomLike(page, tw);
            const comments = await generateComments(tw.text, tw.author, list.strategy, gp);
            if (comments && comments.length > 0) await requestApproval(tw, comments, list.name);
            seen.add(tw.tweetUrl); saveSeenTweets(seen);
            await page.waitForTimeout(2000 + Math.random()*3000);
          }
        }
      } else {
        console.log('Paused. Skipping list check.');
      }

      await processPostQ(page);

      // Check approvals/commands frequently
      for (let i = 0; i < 5; i++) {
        await new Promise(r => setTimeout(r, CHECK_MS / 5));
        await checkApprovals();
        await processPostQ(page);
      }
    } catch(e) {
      console.error('Error:', e.message);
      await sendTG('Error: ' + e.message);
      await page.waitForTimeout(30000);
    }
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
