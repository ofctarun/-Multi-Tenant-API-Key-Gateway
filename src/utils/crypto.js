const crypto = require('crypto');

const KEY_PREFIX = 'sk_live_';

/**
 * Generate a cryptographically secure URL-safe API key with prefix.
 * @returns {string} The full plaintext API key.
 */
function generateApiKey() {
  const randomBytes = crypto.randomBytes(24).toString('base64url');
  return `${KEY_PREFIX}${randomBytes}`;
}

/**
 * Compute the SHA-256 hash of a key.
 * @param {string} key
 * @returns {string} Hex-encoded SHA-256 hash.
 */
function hashApiKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

/**
 * Get the last 4 characters of a key.
 * @param {string} key
 * @returns {string}
 */
function getLastFour(key) {
  return key.slice(-4);
}

/**
 * Create a masked representation of an API key.
 * @param {string} prefix
 * @param {string} lastFour
 * @returns {string} e.g. "sk_live_...3f9a"
 */
function maskApiKey(prefix, lastFour) {
  return `${prefix}...${lastFour}`;
}

module.exports = {
  KEY_PREFIX,
  generateApiKey,
  hashApiKey,
  getLastFour,
  maskApiKey,
};
