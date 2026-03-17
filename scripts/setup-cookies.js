const fs = require('fs');

// This script converts cookies exported from EditThisCookie browser extension
// into Playwright's storageState format.

const INPUT = process.argv[2] || './cookies-raw.json';
const OUTPUT = process.argv[3] || './x-session.json';

try {
  const raw = JSON.parse(fs.readFileSync(INPUT, 'utf8'));
  
  const cookies = raw.map(c => ({
    name: c.name,
    value: c.value,
    domain: c.domain || '.x.com',
    path: c.path || '/',
    expires: c.expirationDate || -1,
    httpOnly: c.httpOnly || false,
    secure: c.secure || true,
    sameSite: ({ 'no_restriction': 'None', 'lax': 'Lax', 'strict': 'Strict' }[(c.sameSite || '').toLowerCase()] || 'Lax')
  }));

  const storageState = {
    cookies,
    origins: [{
      origin: 'https://x.com',
      localStorage: []
    }]
  };

  fs.writeFileSync(OUTPUT, JSON.stringify(storageState, null, 2));
  console.log('✅ Converted ' + cookies.length + ' cookies');
  console.log('Saved to: ' + OUTPUT);
} catch(e) {
  console.error('Error:', e.message);
  console.log('\nUsage: node scripts/setup-cookies.js [input.json] [output.json]');
  console.log('Export your X cookies using EditThisCookie extension as JSON first.');
}
