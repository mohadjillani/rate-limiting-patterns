import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import { FixedWindowLimiter } from '../../src/strategies/fixed-window.ts';
import { SlidingLogLimiter } from '../../src/strategies/sliding-log.ts';
import { TokenBucketLimiter } from '../../src/strategies/token-bucket.ts';

const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
const WINDOW = 2_000;
const LIMIT = 10;

afterAll(async () => {
  await redis.quit();
});

/** Redis' clock, since that is the one the scripts align windows to. */
async function redisNow(): Promise<number> {
  const [seconds, micros] = await redis.time();
  return Number(seconds) * 1000 + Math.floor(Number(micros) / 1000);
}

/** Sleeps until just before the next window boundary. */
async function waitForBoundary(marginMs: number): Promise<void> {
  const now = await redisNow();
  const untilBoundary = WINDOW - (now % WINDOW);
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, untilBoundary - marginMs)));
}

async function burst(
  limiter: { consume(key: string): Promise<{ allowed: boolean }> },
  key: string,
  count: number,
): Promise<number> {
  const results = await Promise.all(Array.from({ length: count }, () => limiter.consume(key)));
  return results.filter((decision) => decision.allowed).length;
}

/**
 * The measurement that decides between the strategies.
 *
 * A fixed window resets on a clock boundary, so a client that spends its whole
 * allowance just before the boundary and again just after has made 2× the limit
 * in a fraction of a window. This is not a bug to be tuned away — it is what
 * "fixed window" means, and the only fix is a different algorithm.
 */
describe('behaviour at a window boundary', () => {
  it('fixed window lets through twice the limit', async () => {
    const limiter = new FixedWindowLimiter(redis, {
      limit: LIMIT,
      windowMs: WINDOW,
      prefix: 'test:boundary:fw',
    });
    const key = `b-${String(Math.random()).slice(2)}`;
    await limiter.reset(key);

    await waitForBoundary(200);
    const before = await burst(limiter, key, LIMIT);

    await new Promise((resolve) => setTimeout(resolve, 400));
    const after = await burst(limiter, key, LIMIT);

    expect(before).toBe(LIMIT);
    expect(after).toBe(LIMIT);
    // 20 requests inside roughly 600ms, against a limit of 10 per 2s.
    expect(before + after).toBe(LIMIT * 2);
  });

  it('sliding log holds the limit across the boundary', async () => {
    const limiter = new SlidingLogLimiter(redis, {
      limit: LIMIT,
      windowMs: WINDOW,
      prefix: 'test:boundary:sl',
    });
    const key = `b-${String(Math.random()).slice(2)}`;
    await limiter.reset(key);

    await waitForBoundary(200);
    const before = await burst(limiter, key, LIMIT);

    await new Promise((resolve) => setTimeout(resolve, 400));
    const after = await burst(limiter, key, LIMIT);

    expect(before).toBe(LIMIT);
    // Nothing gets through: the ten requests from 600ms ago are still inside
    // the trailing window, because the window really does slide.
    expect(after).toBe(0);
  });

  it('token bucket refuses the second burst and then refills', async () => {
    const limiter = new TokenBucketLimiter(redis, {
      limit: LIMIT,
      windowMs: WINDOW,
      prefix: 'test:boundary:tb',
    });
    const key = `b-${String(Math.random()).slice(2)}`;
    await limiter.reset(key);

    expect(await burst(limiter, key, LIMIT)).toBe(LIMIT);
    expect((await limiter.consume(key)).allowed).toBe(false);

    // 10 tokens per 2s is one token every 200ms; after 600ms about three are
    // back. Asserted as a range rather than an exact count because the refill
    // is continuous and the sleep is not exact.
    await new Promise((resolve) => setTimeout(resolve, 600));
    const refilled = await burst(limiter, key, LIMIT);
    expect(refilled).toBeGreaterThanOrEqual(2);
    expect(refilled).toBeLessThanOrEqual(5);
  });
});

describe('sliding log memory', () => {
  it('stores one member per request and no more', async () => {
    const limiter = new SlidingLogLimiter(redis, {
      limit: 20,
      windowMs: 60_000,
      prefix: 'test:mem:sl',
    });
    const key = `m-${String(Math.random()).slice(2)}`;
    await limiter.reset(key);

    await burst(limiter, key, 15);
    // The cost this strategy pays: memory grows with the request rate, not
    // with the number of clients.
    expect(await redis.zcard(`test:mem:sl:${key}`)).toBe(15);

    // Refused requests are not recorded, so a client being hammered does not
    // make the key grow without bound.
    await burst(limiter, key, 30);
    expect(await redis.zcard(`test:mem:sl:${key}`)).toBe(20);
    await limiter.reset(key);
  });
});

describe('key expiry', () => {
  it('gives every key a TTL so idle clients do not accumulate', async () => {
    const keys = [
      {
        limiter: new FixedWindowLimiter(redis, {
          limit: 5,
          windowMs: 5_000,
          prefix: 'test:ttl:fw',
        }),
        pattern: 'test:ttl:fw:*',
      },
      {
        limiter: new SlidingLogLimiter(redis, { limit: 5, windowMs: 5_000, prefix: 'test:ttl:sl' }),
        pattern: 'test:ttl:sl:*',
      },
      {
        limiter: new TokenBucketLimiter(redis, {
          limit: 5,
          windowMs: 5_000,
          prefix: 'test:ttl:tb',
        }),
        pattern: 'test:ttl:tb:*',
      },
    ];

    for (const { limiter, pattern } of keys) {
      await limiter.consume(`ttl-${String(Math.random()).slice(2)}`);
      const found = await redis.keys(pattern);
      expect(found.length).toBeGreaterThan(0);

      for (const key of found) {
        // -1 means no expiry, which is how a rate limiter leaks a key per
        // client forever.
        expect(await redis.pttl(key)).toBeGreaterThan(0);
      }
      await redis.del(...found);
    }
  });
});
