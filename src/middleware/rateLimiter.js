const crypto = require('crypto');
const redis = require('../redis');
const db = require('../db');

const WINDOW_MS = 60 * 1000; // 60 seconds

/**
 * Sliding Window Rate Limiter Middleware using Redis Sorted Sets
 */
async function slidingWindowRateLimiter(req, res, next) {
  const apiKeyRecord = req.apiKeyRecord;
  if (!apiKeyRecord) {
    return res.status(500).json({ error: 'Rate limiter error: missing authenticated key record' });
  }

  const apiKeyId = apiKeyRecord.id;
  const rateLimitPerMinute = apiKeyRecord.rate_limit_per_minute;
  const redisKey = `rate_limit:${apiKeyId}`;
  const now = Date.now();
  const windowStart = now - WINDOW_MS;
  const requestId = `${now}:${crypto.randomUUID()}`;

  try {
    // Transactionally execute Redis commands using MULTI/EXEC
    const multi = redis.multi();
    multi.zremrangebyscore(redisKey, 0, windowStart);
    multi.zadd(redisKey, now, requestId);
    multi.zcard(redisKey);
    multi.expire(redisKey, 60);

    const results = await multi.exec();
    
    // ioredis exec returns array of [err, result]
    // Index 2 corresponds to zcard
    const zcardResult = results[2];
    const count = zcardResult && zcardResult[1] ? zcardResult[1] : 1;

    const endpointPath = req.baseUrl + req.path;

    if (count > rateLimitPerMinute) {
      // Calculate Retry-After header
      let retryAfterSeconds = 60;
      try {
        const oldestEntry = await redis.zrange(redisKey, 0, 0, 'WITHSCORES');
        if (oldestEntry && oldestEntry.length >= 2) {
          const oldestScore = parseFloat(oldestEntry[1]);
          retryAfterSeconds = Math.max(1, Math.ceil((oldestScore + WINDOW_MS - now) / 1000));
        }
      } catch (err) {
        console.error('Error fetching oldest timestamp for Retry-After:', err);
      }

      // Record rate limited request in audit_logs (status_code 429)
      try {
        await db.query(
          'INSERT INTO audit_logs (api_key_id, endpoint, status_code) VALUES ($1, $2, $3)',
          [apiKeyId, endpointPath, 429]
        );
      } catch (logErr) {
        console.error('Failed to log audit entry for 429:', logErr);
      }

      res.setHeader('Retry-After', String(retryAfterSeconds));
      return res.status(429).json({
        error: 'Too Many Requests',
        message: 'Rate limit exceeded. Please try again later.',
        retryAfter: retryAfterSeconds,
      });
    }

    // Record successful authenticated request in audit_logs (status_code 200)
    try {
      await db.query(
        'INSERT INTO audit_logs (api_key_id, endpoint, status_code) VALUES ($1, $2, $3)',
        [apiKeyId, endpointPath, 200]
      );
    } catch (logErr) {
      console.error('Failed to log audit entry for 200:', logErr);
    }

    next();
  } catch (error) {
    console.error('Rate limiter error:', error);
    // On Redis failure, log warning and fail open or call next()
    next();
  }
}

module.exports = {
  slidingWindowRateLimiter,
};
