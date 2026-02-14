// backend/services/redisClient.mjs
import Redis from 'ioredis';

const redisURL = process.env.REDIS_URL || 'redis://redis:6379';
console.log(`[Redis] Connecting to ${redisURL}`);

const redis = new Redis(redisURL, {
    // Add retry strategy for better resilience
    retryStrategy(times) {
        const delay = Math.min(times * 50, 2000); // 50ms, 100ms, ..., 2000ms
        return delay;
    },
    maxRetriesPerRequest: 3,
});

redis.on('connect', () => {
    console.log('[Redis] Client connected successfully.');
});

redis.on('error', (err) => {
    console.error('[Redis] Connection Error:', err);
});

export default redis;