const positive = (value, fallback) => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : fallback;

// All AI endpoints share the same process concurrency budget. IP-based limits
// deliberately do not trust the caller-controlled anonymousId.
export function createAILimiter({
  maxConcurrent = positive(process.env.AI_MAX_CONCURRENT, 2),
  maxPerMinute = positive(process.env.AI_REQUESTS_PER_MINUTE, 10),
  windowMs = 60_000,
  now = Date.now,
} = {}) {
  const requests = new Map();
  let active = 0;
  return function limitAI(req, res, next) {
    const time = now();
    for (const [key, value] of requests) if (value.until <= time) requests.delete(key);
    const key = req.ip ?? req.socket?.remoteAddress ?? 'unknown';
    const quota = requests.get(key) ?? { count: 0, until: time + windowMs };
    if (quota.count >= maxPerMinute) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((quota.until - time) / 1000))));
      return res.status(429).json({ success: false, code: 'AI_RATE_LIMITED', message: 'Too many AI requests. Please wait a minute.' });
    }
    if (active >= maxConcurrent || requests.size >= 10_000) {
      res.setHeader('Retry-After', '5');
      return res.status(429).json({ success: false, code: 'AI_BUSY', message: 'The AI service is busy. Please try again shortly.' });
    }
    quota.count += 1;
    requests.set(key, quota);
    active += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      active -= 1;
      res.removeListener('finish', release);
      res.removeListener('close', release);
    };
    res.once('finish', release);
    res.once('close', release);
    next();
  };
}

export const limitAI = createAILimiter();
