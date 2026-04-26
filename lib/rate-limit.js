function makeRateLimiter(config) {
  function canComment(logs) {
    const now = Date.now();
    const hourKey = new Date().toISOString().substring(0, 13);
    const dayKey = new Date().toISOString().split('T')[0];

    const hourCount = logs.hourly?.[hourKey] || 0;
    const dayCount = logs.daily?.[dayKey] || 0;

    if (hourCount >= config.maxPerHour) {
      return { ok: false, reason: `Hourly limit (${config.maxPerHour})` };
    }
    if (dayCount >= config.maxPerDay) {
      return { ok: false, reason: `Daily limit (${config.maxPerDay})` };
    }

    if (config.minGapMs) {
      const last = logs.comments?.[logs.comments.length - 1];
      if (last && now - new Date(last.time).getTime() < config.minGapMs) {
        return { ok: false, reason: `Too soon (${Math.round(config.minGapMs / 60000)} min gap)` };
      }
    }

    if (config.burstLimit && config.burstWindowMs) {
      const burst = (logs.comments || []).filter(c => now - new Date(c.time).getTime() < config.burstWindowMs);
      if (burst.length >= config.burstLimit) {
        const oldestBurst = new Date(burst[0].time).getTime();
        const cooldownEnd = oldestBurst + config.burstWindowMs + (config.burstCooldownMs || 0);
        if (now < cooldownEnd) {
          return { ok: false, reason: `Burst cooldown (${Math.round((cooldownEnd - now) / 60000)} min left)` };
        }
      }
    }

    return { ok: true };
  }

  function canCommentOnAuthor(logs, author) {
    if (!config.sameAuthorCooldownMs) return true;
    const now = Date.now();
    return !(logs.comments || []).find(c =>
      c.author === author && (now - new Date(c.time).getTime()) < config.sameAuthorCooldownMs
    );
  }

  function recordComment(logs, author, tweetUrl, comment) {
    const now = new Date();
    const hourKey = now.toISOString().substring(0, 13);
    const dayKey = now.toISOString().split('T')[0];
    if (!logs.hourly) logs.hourly = {};
    if (!logs.daily) logs.daily = {};
    if (!logs.comments) logs.comments = [];
    logs.comments.push({ time: now.toISOString(), author, tweetUrl, comment: comment.substring(0, 100) });
    logs.hourly[hourKey] = (logs.hourly[hourKey] || 0) + 1;
    logs.daily[dayKey] = (logs.daily[dayKey] || 0) + 1;
    if (logs.comments.length > 200) logs.comments = logs.comments.slice(-200);
    return logs;
  }

  return { canComment, canCommentOnAuthor, recordComment };
}

module.exports = { makeRateLimiter };
