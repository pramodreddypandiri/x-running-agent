function getIdentity() {
  const username = (process.env.X_USERNAME || '').trim();
  if (!username) {
    throw new Error('X_USERNAME is required (without @)');
  }
  return {
    username,
    usernameLC: username.toLowerCase(),
    displayName: process.env.X_DISPLAY_NAME || username,
    handle: '@' + username,
  };
}

module.exports = { getIdentity };
