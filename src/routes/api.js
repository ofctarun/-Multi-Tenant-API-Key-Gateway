const express = require('express');
const db = require('../db');
const { generateApiKey, hashApiKey, getLastFour, maskApiKey, KEY_PREFIX } = require('../utils/crypto');
const { authenticateApiKey } = require('../middleware/auth');
const { slidingWindowRateLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

// Helper to ensure tenant exists
async function tenantExists(tenantId) {
  const result = await db.query('SELECT id FROM tenants WHERE id = $1', [tenantId]);
  return result.rows.length > 0;
}

/**
 * 1. Issue a new API key for a tenant
 * POST /api/tenants/:tenantId/keys
 */
router.post('/tenants/:tenantId/keys', async (req, res) => {
  try {
    const tenantId = parseInt(req.params.tenantId, 10);
    if (isNaN(tenantId)) {
      return res.status(400).json({ error: 'Invalid tenant ID' });
    }

    const exists = await tenantExists(tenantId);
    if (!exists) {
      // Auto-create tenant if not exists to facilitate testing
      await db.query('INSERT INTO tenants (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [tenantId, `Tenant ${tenantId}`]);
    }

    const rateLimitPerMinute = parseInt(req.body.rateLimitPerMinute || 100, 10);
    if (isNaN(rateLimitPerMinute) || rateLimitPerMinute <= 0) {
      return res.status(400).json({ error: 'Invalid rateLimitPerMinute value' });
    }

    const rawApiKey = generateApiKey();
    const keyHash = hashApiKey(rawApiKey);
    const lastFour = getLastFour(rawApiKey);

    const insertQuery = `
      INSERT INTO api_keys (tenant_id, key_hash, key_prefix, last_four, rate_limit_per_minute, is_active)
      VALUES ($1, $2, $3, $4, $5, TRUE)
      RETURNING id, last_four, rate_limit_per_minute
    `;
    const result = await db.query(insertQuery, [tenantId, keyHash, KEY_PREFIX, lastFour, rateLimitPerMinute]);
    const row = result.rows[0];

    return res.status(201).json({
      apiKey: rawApiKey,
      keyRecord: {
        id: row.id,
        lastFour: row.last_four,
        rateLimitPerMinute: row.rate_limit_per_minute,
      },
    });
  } catch (error) {
    console.error('Error creating API key:', error);
    return res.status(500).json({ error: 'Internal server error while creating API key' });
  }
});

/**
 * 2. List all API keys for a tenant (masked)
 * GET /api/tenants/:tenantId/keys
 */
router.get('/tenants/:tenantId/keys', async (req, res) => {
  try {
    const tenantId = parseInt(req.params.tenantId, 10);
    if (isNaN(tenantId)) {
      return res.status(400).json({ error: 'Invalid tenant ID' });
    }

    const query = `
      SELECT id, key_prefix, last_four, created_at, is_active, rate_limit_per_minute, expires_at
      FROM api_keys
      WHERE tenant_id = $1
      ORDER BY created_at DESC
    `;
    const result = await db.query(query, [tenantId]);

    const formattedKeys = result.rows.map((row) => ({
      id: row.id,
      maskedKey: maskApiKey(row.key_prefix, row.last_four),
      createdAt: row.created_at.toISOString(),
      isActive: row.is_active && (!row.expires_at || new Date(row.expires_at) > new Date()),
      rateLimitPerMinute: row.rate_limit_per_minute,
      expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
    }));

    return res.status(200).json(formattedKeys);
  } catch (error) {
    console.error('Error listing API keys:', error);
    return res.status(500).json({ error: 'Internal server error while listing API keys' });
  }
});

/**
 * 3. Protected Resource Endpoint
 * GET /api/protected
 */
router.get('/protected', authenticateApiKey, slidingWindowRateLimiter, (req, res) => {
  return res.status(200).json({
    message: 'Access granted to protected endpoint',
    tenantId: req.tenantId,
    keyId: req.apiKeyRecord.id,
    timestamp: new Date().toISOString(),
  });
});

/**
 * 4. Revoke an API key immediately
 * DELETE /api/keys/:keyId
 */
router.delete('/keys/:keyId', async (req, res) => {
  try {
    const keyId = parseInt(req.params.keyId, 10);
    if (isNaN(keyId)) {
      return res.status(400).json({ error: 'Invalid key ID' });
    }

    const updateQuery = `
      UPDATE api_keys
      SET is_active = FALSE
      WHERE id = $1
    `;
    await db.query(updateQuery, [keyId]);

    return res.status(204).send();
  } catch (error) {
    console.error('Error revoking API key:', error);
    return res.status(500).json({ error: 'Internal server error while revoking API key' });
  }
});

/**
 * 5. Rotate an API key with 1-minute grace period
 * POST /api/keys/:keyId/rotate
 */
router.post('/keys/:keyId/rotate', async (req, res) => {
  try {
    const keyId = parseInt(req.params.keyId, 10);
    if (isNaN(keyId)) {
      return res.status(400).json({ error: 'Invalid key ID' });
    }

    // Fetch existing key
    const findQuery = `SELECT * FROM api_keys WHERE id = $1 AND is_active = TRUE`;
    const findResult = await db.query(findQuery, [keyId]);

    if (findResult.rows.length === 0) {
      return res.status(404).json({ error: 'API key not found or already inactive' });
    }

    const oldKeyRecord = findResult.rows[0];

    // Set grace period of 1 minute (60 seconds) for the old key
    const setGraceQuery = `
      UPDATE api_keys
      SET expires_at = NOW() + INTERVAL '1 minute'
      WHERE id = $1
    `;
    await db.query(setGraceQuery, [keyId]);

    // Issue new key for same tenant
    const newRawApiKey = generateApiKey();
    const newKeyHash = hashApiKey(newRawApiKey);
    const newLastFour = getLastFour(newRawApiKey);

    const insertQuery = `
      INSERT INTO api_keys (tenant_id, key_hash, key_prefix, last_four, rate_limit_per_minute, is_active)
      VALUES ($1, $2, $3, $4, $5, TRUE)
      RETURNING id
    `;
    await db.query(insertQuery, [
      oldKeyRecord.tenant_id,
      newKeyHash,
      KEY_PREFIX,
      newLastFour,
      oldKeyRecord.rate_limit_per_minute,
    ]);

    return res.status(200).json({
      newApiKey: newRawApiKey,
    });
  } catch (error) {
    console.error('Error rotating API key:', error);
    return res.status(500).json({ error: 'Internal server error while rotating API key' });
  }
});

/**
 * 6. Audit logs & usage stats for Console Dashboard
 * GET /api/tenants/:tenantId/audit-logs
 */
router.get('/tenants/:tenantId/audit-logs', async (req, res) => {
  try {
    const tenantId = parseInt(req.params.tenantId, 10);
    if (isNaN(tenantId)) {
      return res.status(400).json({ error: 'Invalid tenant ID' });
    }

    const page = parseInt(req.query.page || '1', 10);
    const limit = parseInt(req.query.limit || '20', 10);
    const offset = (page - 1) * limit;

    const logsQuery = `
      SELECT al.id, al.api_key_id, al.endpoint, al.status_code, al.timestamp,
             ak.key_prefix, ak.last_four
      FROM audit_logs al
      JOIN api_keys ak ON al.api_key_id = ak.id
      WHERE ak.tenant_id = $1
      ORDER BY al.timestamp DESC
      LIMIT $2 OFFSET $3
    `;
    const logsResult = await db.query(logsQuery, [tenantId, limit, offset]);

    const countQuery = `
      SELECT COUNT(*)
      FROM audit_logs al
      JOIN api_keys ak ON al.api_key_id = ak.id
      WHERE ak.tenant_id = $1
    `;
    const countResult = await db.query(countQuery, [tenantId]);
    const totalLogs = parseInt(countResult.rows[0].count, 10);

    // Hourly aggregation for chart visualization
    const chartQuery = `
      SELECT 
        TO_CHAR(DATE_TRUNC('minute', al.timestamp), 'HH24:MI') AS time_label,
        COUNT(*) AS request_count,
        SUM(CASE WHEN al.status_code = 429 THEN 1 ELSE 0 END) AS rate_limited_count
      FROM audit_logs al
      JOIN api_keys ak ON al.api_key_id = ak.id
      WHERE ak.tenant_id = $1 AND al.timestamp >= NOW() - INTERVAL '1 hour'
      GROUP BY DATE_TRUNC('minute', al.timestamp), TO_CHAR(DATE_TRUNC('minute', al.timestamp), 'HH24:MI')
      ORDER BY DATE_TRUNC('minute', al.timestamp) ASC
    `;
    const chartResult = await db.query(chartQuery, [tenantId]);

    const formattedLogs = logsResult.rows.map((r) => ({
      id: r.id,
      apiKeyId: r.api_key_id,
      maskedKey: maskApiKey(r.key_prefix, r.last_four),
      endpoint: r.endpoint,
      statusCode: r.status_code,
      timestamp: r.timestamp.toISOString(),
    }));

    return res.status(200).json({
      logs: formattedLogs,
      pagination: {
        page,
        limit,
        totalLogs,
        totalPages: Math.ceil(totalLogs / limit) || 1,
      },
      hourlyStats: chartResult.rows,
    });
  } catch (error) {
    console.error('Error fetching audit logs:', error);
    return res.status(500).json({ error: 'Internal server error while fetching audit logs' });
  }
});

/**
 * 7. List tenants helper endpoint for UI dropdown
 * GET /api/tenants
 */
router.get('/tenants', async (req, res) => {
  try {
    const result = await db.query('SELECT id, name, created_at FROM tenants ORDER BY id ASC');
    return res.status(200).json(result.rows);
  } catch (error) {
    console.error('Error listing tenants:', error);
    return res.status(500).json({ error: 'Internal server error while listing tenants' });
  }
});

module.exports = router;
