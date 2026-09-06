import express from 'express';
import { Redis } from 'ioredis';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withDegradation, type DegradePolicy } from '../degrade.ts';
import type { LimiterOptions, RateLimiter } from '../limiter.ts';
import { rateLimit } from '../middleware/express.ts';
import { FixedWindowLimiter } from '../strategies/fixed-window.ts';
import { SlidingLogLimiter } from '../strategies/sliding-log.ts';
import { TokenBucketLimiter } from '../strategies/token-bucket.ts';

export type StrategyName = 'fixed-window' | 'sliding-log' | 'token-bucket';

export function buildLimiter(
  strategy: StrategyName,
  redis: Redis,
  options: LimiterOptions,
): RateLimiter {
  switch (strategy) {
    case 'sliding-log':
      return new SlidingLogLimiter(redis, options);
    case 'token-bucket':
      return new TokenBucketLimiter(redis, options);
    default:
      return new FixedWindowLimiter(redis, options);
  }
}

export interface DemoOptions {
  redis: Redis;
  strategy: StrategyName;
  limit: number;
  windowMs: number;
  globalLimit: number;
  policy: DegradePolicy;
}

export function createApp(options: DemoOptions) {
  const app = express();

  const limiter = withDegradation(
    buildLimiter(options.strategy, options.redis, {
      limit: options.limit,
      windowMs: options.windowMs,
      prefix: `demo:${options.strategy}`,
    }),
    { policy: options.policy },
  );

  const global = buildLimiter(options.strategy, options.redis, {
    limit: options.globalLimit,
    windowMs: options.windowMs,
    prefix: `demo:${options.strategy}:global`,
  });

  // Ahead of the limiter: a health check that can be rate limited is a health
  // check that reports the service as down while it is merely busy.
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', strategy: options.strategy });
  });

  app.use(
    rateLimit({
      limiter,
      global: { limiter: global },
      // The client id comes from a header here so a load generator can
      // simulate many clients from one machine. A real service would use the
      // authenticated user, the API key, or the address from a trusted proxy
      // header — never a client-supplied one.
      keyFor: (req) => String(req.headers['x-client-id'] ?? req.ip ?? 'unknown'),
      costFor: (req) => (req.path === '/api/expensive' ? 5 : 1),
    }),
  );

  app.get('/api/ping', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/api/expensive', (_req, res) => {
    res.json({ ok: true, cost: 5 });
  });

  return app;
}

const entry = process.argv[1];
if (entry && fileURLToPath(import.meta.url) === path.resolve(entry)) {
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
  const port = Number(process.env.PORT ?? 3000);

  const app = createApp({
    redis,
    strategy: (process.env.STRATEGY as StrategyName | undefined) ?? 'token-bucket',
    limit: Number(process.env.LIMIT ?? 100),
    windowMs: Number(process.env.WINDOW_MS ?? 60_000),
    globalLimit: Number(process.env.GLOBAL_LIMIT ?? 10_000),
    policy: (process.env.DEGRADE_POLICY as DegradePolicy | undefined) ?? 'open',
  });

  app.listen(port, () => {
    console.log(
      `demo listening on http://127.0.0.1:${String(port)} (${process.env.STRATEGY ?? 'token-bucket'})`,
    );
  });
}
