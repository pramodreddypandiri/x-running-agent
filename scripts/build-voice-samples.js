const fs = require('fs');

const CORPUS_PATH = './data/my-tweets-corpus.json';
const OUT_PATH = './prompts/voice-samples.txt';
const SAMPLE_COUNT = 40;

function buildVoiceSamples({
  corpusPath = CORPUS_PATH,
  outPath = OUT_PATH,
  sampleCount = SAMPLE_COUNT,
} = {}) {
  const corpus = JSON.parse(fs.readFileSync(corpusPath, 'utf8'));
  const score = (t) => t.impressionsN + t.likesN * 50 + t.repliesN * 200 + t.repostsN * 100;

  const cleaned = corpus
    .filter(t => {
      const txt = (t.text || '').trim();
      if (txt.length < 30 || txt.length > 320) return false;
      if (/https?:\/\//.test(txt)) return false;
      if (/^@\w+\s*$/.test(txt)) return false;
      return true;
    })
    .sort((a, b) => score(b) - score(a));

  const seen = new Set();
  const picked = [];
  for (const t of cleaned) {
    const key = t.text.slice(0, 40).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(t);
    if (picked.length >= sampleCount) break;
  }

  const header = `# RECENT TWEETS BY PRAMOD (VOICE ANCHOR)
# Auto-generated from data/my-tweets-corpus.json by scripts/build-voice-samples.js
# These are real things Pramod said on X that got engagement.
# Use them to calibrate register, length, sharpness, vocabulary.
# Last updated: ${new Date().toISOString().split('T')[0]}

`;

  const body = picked
    .map(t => `- ${t.text.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim()}`)
    .join('\n');

  fs.writeFileSync(outPath, header + body + '\n');

  return {
    picked: picked.length,
    minScore: picked.length ? score(picked[picked.length - 1]) : 0,
    maxScore: picked.length ? score(picked[0]) : 0,
    samples: picked,
  };
}

module.exports = { buildVoiceSamples };

if (require.main === module) {
  const r = buildVoiceSamples();
  console.log(`Picked ${r.picked} samples → ${OUT_PATH}`);
  console.log(`Score range: ${r.minScore} – ${r.maxScore}`);
}
