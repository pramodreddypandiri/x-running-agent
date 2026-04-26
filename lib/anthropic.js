const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';

async function callClaude({
  apiKey,
  prompt,
  model = DEFAULT_MODEL,
  maxTokens = 400,
  retries = 3,
}) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      const data = await r.json();
      if (data.content && data.content[0]) return data.content[0].text;
      if (data.error?.type === 'overloaded_error') {
        const wait = (attempt + 1) * 10;
        console.log(`Claude API overloaded, retrying in ${wait}s (attempt ${attempt + 1}/${retries})`);
        await new Promise(res => setTimeout(res, wait * 1000));
        continue;
      }
      console.error('Claude API error:', JSON.stringify(data));
      return null;
    } catch (e) {
      console.error('Claude fetch error:', e.message);
    }
  }
  return null;
}

function parseLetterOptions(text, maxLetter = 'E') {
  if (!text) return [];
  const trimmed = text.trim();
  if (trimmed === 'SKIP' || trimmed.startsWith('SKIP')) return [];

  const lines = trimmed.split('\n').filter(l => l.trim());
  const opts = [];
  let cur = '';
  const re = new RegExp(`^[A-${maxLetter}]:`);
  for (const line of lines) {
    if (re.test(line)) {
      if (cur) opts.push(cur.trim());
      cur = line.replace(/^[A-Z]:\s*/, '').replace(/^["']|["']$/g, '');
    } else if (cur) {
      cur += ' ' + line.trim();
    }
  }
  if (cur) opts.push(cur.trim());
  return opts;
}

function weightedPick(options, weights) {
  if (options.length === 0) return null;
  let rand = Math.random();
  for (let i = 0; i < weights.length && i < options.length; i++) {
    rand -= weights[i];
    if (rand <= 0) return options[i];
  }
  return options[options.length - 1];
}

module.exports = { callClaude, parseLetterOptions, weightedPick, DEFAULT_MODEL };
