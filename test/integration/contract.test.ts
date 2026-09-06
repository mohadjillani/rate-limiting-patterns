import { Redis } from 'ioredis';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { FixedWindowLimiter } from '../../src/strategies/fixed-window.ts';
import { SlidingLogLimiter } from '../../src/strategies/sliding-log.ts';
import { TokenBucketLimiter } from '../../src/strategies/token-bucket.ts';
import type { RateLimiter } from '../../src/limiter.ts';

const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');

const strategies: { name: string; build: (limit: number, windowMs: number) => RateLimiter }[] = [
  {
    name: 'fixed-window',
    build: (limit, windowMs) =>
      new FixedWindowLimiter(redis, { limit, windowMs, prefix: 'test:fw' }),
  },
  {
    name: 'sliding-log',
    build: (limit, windowMs) =>
      new SlidingLogLimiter(redis, { limit, windowMs, prefix: 'test:sl' }),
  },
  {
    name: 'token-bucket',
    build: (limit, windowMs) =>
      new TokenBucketLimiter(redis, { limit, windowMs, prefix: 'test:tb' }),
  },
];

// File scope, not inside the first describe: teardown in one block would close
// the connection the later blocks are still using.
afterAll(async () => {
  await redis.quit();
});

/**
 * The contract every strategy must satisfy.
 *
 * Written once and run three times, because the point of the shared interface
 * is that a caller can swap strategies. A behaviour that only two of them have
 * is not part of the contract, and the per-strategy suites below cover those.
 */
describe.each(strategies)('$name', ({ build }) => {
  const key = `contract-${String(Math.random()).slice(2)}`;

  beforeEach(async () => {
    await build(5, 60_000).reset(key);
  });

  it('allows up to the limit and then refuses', async () => {
    const limiter = build(3, 60_000);

    expect((await limiter.consume(key)).allowed).toBe(true);
    expect((await limiter.consume(key)).allowed).toBe(true);
    expect((await limiter.consume(key)).allowed).toBe(true);

    const denied = await limiter.consume(key);
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
  });

  it('counts down the remaining allowance', async () => {
    const limiter = build(3, 60_000);
    expect((await limiter.consume(key)).remaining).toBe(2);
    expect((await limiter.consume(key)).remaining).toBe(1);
    expect((await limiter.consume(key)).remaining).toBe(0);
  });

  it('reports the limit it was configured with', async () => {
    expect((await build(7, 60_000).consume(key)).limit).toBe(7);
  });

  it('charges a cost greater than one', async () => {
    const limiter = build(5, 60_000);
    expect((await limiter.consume(key, 4)).remaining).toBe(1);
    expect((await limiter.consume(key, 2)).allowed).toBe(false);
    expect((await limiter.consume(key, 1)).allowed).toBe(true);
  });

  it('does not charge for a peek', async () => {
    const limiter = build(3, 60_000);
    await limiter.consume(key);

    expect((await limiter.peek(key)).remaining).toBe(2);
    expect((await limiter.peek(key)).remaining).toBe(2);
  });

  it('keeps separate keys separate', async () => {
    const limiter = build(1, 60_000);
    expect((await limiter.consume(`${key}-a`)).allowed).toBe(true);
    expect((await limiter.consume(`${key}-b`)).allowed).toBe(true);
    expect((await limiter.consume(`${key}-a`)).allowed).toBe(false);

    await limiter.reset(`${key}-a`);
    await limiter.reset(`${key}-b`);
  });

  it('forgets a key after a reset', async () => {
    const limiter = build(1, 60_000);
    await limiter.consume(key);
    await limiter.reset(key);
    expect((await limiter.consume(key)).allowed).toBe(true);
  });

  /**
   * The reason every decision is one Lua script.
   *
   * A read-then-write from the application cannot be fixed with more code:
   * between the read and the write, another node has already spent the
   * allowance. Two hundred simultaneous calls must allow exactly the limit —
   * not "about" the limit.
   */
  it('allows exactly the limit under 200 concurrent calls', async () => {
    const limiter = build(50, 60_000);
    const results = await Promise.all(Array.from({ length: 200 }, () => limiter.consume(key)));

    expect(results.filter((decision) => decision.allowed)).toHaveLength(50);
  });

  it('never reports a negative remaining', async () => {
    const limiter = build(2, 60_000);
    const results = await Promise.all(Array.from({ length: 20 }, () => limiter.consume(key)));
    for (const decision of results) expect(decision.remaining).toBeGreaterThanOrEqual(0);
  });

  it('gives a reset time in the future while the key is limited', async () => {
    const limiter = build(1, 60_000);
    await limiter.consume(key);
    const denied = await limiter.consume(key);

    expect(denied.resetAt).toBeGreaterThan(Date.now());
  });
});
