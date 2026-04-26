function createTelegramClient({ token, chatId }) {
  if (!token) throw new Error('Telegram client requires a token');
  if (!chatId) throw new Error('Telegram client requires a chatId');

  let offset = 0;
  const allowedChat = String(chatId);

  async function send(text, replyMarkup) {
    const body = { chat_id: chatId, text, parse_mode: 'HTML' };
    if (replyMarkup) body.reply_markup = JSON.stringify(replyMarkup);
    try {
      const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return await r.json();
    } catch (e) {
      console.error('Telegram send error:', e.message);
      return null;
    }
  }

  async function answerCallback(callbackId) {
    try {
      await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: callbackId }),
      });
    } catch (e) {
      console.error('Telegram answerCallback error:', e.message);
    }
  }

  async function editMessage(messageId, text) {
    try {
      await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML' }),
      });
    } catch (e) {
      console.error('Telegram editMessage error:', e.message);
    }
  }

  async function pollUpdates({ timeout = 1 } = {}) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&timeout=${timeout}`);
      const u = await r.json();
      if (!u.ok || !u.result) return [];

      const allowed = [];
      for (const up of u.result) {
        offset = up.update_id + 1;
        const incomingChatId = String(
          up.message?.chat?.id ?? up.callback_query?.message?.chat?.id ?? ''
        );
        if (incomingChatId !== allowedChat) {
          console.warn(`Dropping Telegram update from unauthorized chat ${incomingChatId}`);
          continue;
        }
        allowed.push(up);
      }
      return allowed;
    } catch (e) {
      console.error('Telegram poll error:', e.message);
      return [];
    }
  }

  return { send, answerCallback, editMessage, pollUpdates };
}

module.exports = { createTelegramClient };
