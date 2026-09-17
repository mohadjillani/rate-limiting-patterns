import { Redis } from 'ioredis';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ProviderQuota } from '../../src/provider-quota.ts';

const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');

// File scope, not inside a describe: teardown in one block would close the
// connection the later blocks are still using.
afterAll(async () => {
  await redis.quit();
});

const build = (requestsPerMinute: number, tokensPerMinute: number): ProviderQuota =>
  new ProviderQuota(redis, {
    requestsPerMinute,
    tokensPerMinute,
    prefix: 'test:pq',
  });

describe('reserving against two quotas', () => {
  const key = `reserve-${String(Math.random()).slice(2)}`;

  beforeEach(async () => {
    await build(10, 1000).reset(key);
  });

  it('admits a call that fits under both quotas', async () => {
    const quota = build(10, 1000);
    const { decision, reservation } = await quota.reserve(key, 100);

    expect(decision.allowed).toBe(true);
    expect(decision.remaining).toBe(900);
    expect(reservation).toEqual({ key, estimatedTokens: 100 });
  });

  it('refuses when the token quota cannot cover the estimate', async () => {
    const quota = build(10, 1000);
    await quota.reserve(key, 950);

    const { decision, reservation } = await quota.reserve(key, 200);

    expect(decision.allowed).toBe(false);
    expect(reservation).toBeNull();
    expect(decision.retryAfterMs).toBeGreaterThan(0);
  });

  it('refuses when the request quota is spent even though tokens remain', async () => {
    const quota = build(2, 100_000);
    await quota.reserve(key, 1);
    await quota.reserve(key, 1);

    const { decision } = await quota.reserve(key, 1);

    expect(decision.allowed).toBe(false);
    // The tokens were never the constraint, so the caller is told to wait for
    // the request bucket rather than to send a smaller prompt.
    expect(decision.remaining).toBeGreaterThan(90_000);
  });

  it('leaves the request bucket untouched when the token quota refuses', async () => {
    const quota = build(3, 1000);
    await quota.reserve(key, 900);

    const refused = await quota.reserve(key, 500);
    expect(refused.decision.allowed).toBe(false);

    // Asserted by spending the rest of the request budget rather than by
    // reading a counter: the token bucket refills while the test runs, so an
    // equality check on `remaining` would fail on a slow runner and prove
    // nothing about the request bucket anyway.
    expect((await quota.reserve(key, 10)).decision.allowed).toBe(true);
    expect((await quota.reserve(key, 10)).decision.allowed).toBe(true);
    expect((await quota.reserve(key, 10)).decision.allowed).toBe(false);
  });

  it('peeks without spending a request', async () => {
    const quota = build(2, 1000);
    await quota.peek(key);
    await quota.peek(key);

    const { decision } = await quota.reserve(key, 10);

    expect(decision.allowed).toBe(true);
  });
});
