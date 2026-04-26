function resolveEnv(prefix, suffix) {
  const prefixed = prefix ? `${prefix.toUpperCase()}_${suffix}` : null;
  return (prefixed && process.env[prefixed]) || process.env[suffix] || null;
}

function resolveTelegramAuth(botName) {
  const token = resolveEnv(botName, 'TELEGRAM_BOT_TOKEN');
  const chatId = resolveEnv(botName, 'TELEGRAM_CHAT_ID');
  if (!token) {
    const hint = botName ? `${botName.toUpperCase()}_TELEGRAM_BOT_TOKEN or TELEGRAM_BOT_TOKEN` : 'TELEGRAM_BOT_TOKEN';
    throw new Error(`Missing Telegram bot token (set ${hint})`);
  }
  if (!chatId) {
    const hint = botName ? `${botName.toUpperCase()}_TELEGRAM_CHAT_ID or TELEGRAM_CHAT_ID` : 'TELEGRAM_CHAT_ID';
    throw new Error(`Missing Telegram chat ID (set ${hint})`);
  }
  return { token, chatId };
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

module.exports = { resolveEnv, resolveTelegramAuth, requireEnv };
