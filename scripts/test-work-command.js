// Quick test: send /work in Telegram, then run this script within 30 seconds
require('dotenv').config();
const fs = require('fs');

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;

function loadText(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } }

async function test() {
  console.log('Checking for recent Telegram messages...');
  const r = await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/getUpdates?offset=-5');
  const u = await r.json();

  if (!u.ok) { console.error('Telegram API error:', u); return; }

  const msgs = (u.result || []).filter(m => m.message && m.message.text);
  console.log('Found ' + msgs.length + ' recent messages:');
  msgs.forEach(m => console.log('  → "' + m.message.text + '"'));

  // Respond to /work if found
  const workMsg = msgs.find(m => m.message.text.trim().toLowerCase() === '/work');
  if (workMsg) {
    const currentWork = loadText('./prompts/current-work.txt').replace(/^#.*$/gm, '').trim();
    const body = { chat_id: TG_CHAT, text: '📋 Current work context:\n\n' + (currentWork || '(empty)') + '\n\n✅ /work command is working!', parse_mode: 'HTML' };
    const res = await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const data = await res.json();
    console.log(data.ok ? '\n✅ Reply sent to Telegram!' : '\n❌ Failed to send:', data);
  } else {
    console.log('\nNo /work command found. Send /work in Telegram first, then re-run this script.');
  }
}

test().catch(console.error);
