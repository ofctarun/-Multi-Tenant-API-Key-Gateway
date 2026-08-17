const db = require('../db');
const { hashApiKey } = require('../utils/crypto');

async function authenticateApiKey(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized: Missing or malformed Authorization header' });
    }

    const rawApiKey = authHeader.substring(7).trim();
    if (!rawApiKey) {
      return res.status(401).json({ error: 'Unauthorized: Empty API key provided' });
    }

    const keyHash = hashApiKey(rawApiKey);

    const query = `
      SELECT id, tenant_id, key_hash, key_prefix, last_four, rate_limit_per_minute, is_active, expires_at, created_at
      FROM api_keys
      WHERE key_hash = $1
        AND is_active = TRUE
        AND (expires_at IS NULL OR expires_at > NOW())
    `;
    const result = await db.query(query, [keyHash]);

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Unauthorized: Invalid or expired API key' });
    }

    const keyRecord = result.rows[0];
    req.apiKeyRecord = keyRecord;
    req.tenantId = keyRecord.tenant_id;

    next();
  } catch (error) {
    console.error('Authentication middleware error:', error);
    return res.status(500).json({ error: 'Internal server error during authentication' });
  }
}

module.exports = {
  authenticateApiKey,
};
