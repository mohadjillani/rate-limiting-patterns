import { Redis } from 'ioredis';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ProviderQuota, type Reservation } from '../../src/provider-quota.ts';

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

/** Narrows away the refusal case, which every caller here has ruled out. */
const granted = async (
  quota: ProviderQuota,
  key: string,
  estimatedTokens: number,
): Promise<Reservation> => {
  const { reservation } = await quota.reserve(key, estimatedTokens);
  if (!reservation) throw new Error('expected the reservation to be granted');
  return reservation;
};

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

describe('settling a reservation against actual usage', () => {
  const key = `settle-${String(Math.random()).slice(2)}`;

  beforeEach(async () => {
    await build(10, 1000).reset(key);
  });

  // The token bucket refills while the test runs, so exact equality on
  // `remaining` is a flake waiting for a slow runner. A few tokens of slack
  // covers the refill without hiding a wrong correction, which is always off
  // by hundreds here.
  const expectAbout = (actual: number, expected: number): void => {
    expect(actual).toBeGreaterThanOrEqual(expected);
    expect(actual).toBeLessThan(expected + 20);
  };

  it('returns the difference when the completion came in under the estimate', async () => {
    const quota = build(10, 1000);
    const reservation = await granted(quota, key, 500);

    const settled = await quota.settle(reservation, 100);

    expectAbout(settled.remaining, 900);
  });

  it('takes the difference when the completion ran over the estimate', async () => {
    const quota = build(10, 1000);
    const reservation = await granted(quota, key, 100);

    const settled = await quota.settle(reservation, 600);

    expectAbout(settled.remaining, 400);
  });

  it('holds the estimate until the call is settled', async () => {
    const quota = build(10, 1000);
    const reservation = await granted(quota, key, 800);

    // Concurrent callers see the estimate as spent, which is the point of
    // reserving rather than charging afterwards.
    expect((await quota.reserve(key, 300)).decision.allowed).toBe(false);

    await quota.settle(reservation, 0);
    expect((await quota.reserve(key, 300)).decision.allowed).toBe(true);
  });

  it('carries an overspend as debt that refuses the next call', async () => {
    const quota = build(10, 1000);
    const reservation = await granted(quota, key, 100);

    // The provider has already been paid for these, so the bucket has to go
    // negative rather than pretend the allowance is merely empty.
    const settled = await quota.settle(reservation, 1500);

    expect(settled.allowed).toBe(false);
    expect(settled.remaining).toBe(0);
    expect(settled.retryAfterMs).toBeGreaterThan(0);
    expect((await quota.reserve(key, 1)).decision.allowed).toBe(false);
  });

  it('never refunds past the capacity, so a double settle cannot mint tokens', async () => {
    const quota = build(10, 1000);
    const reservation = await granted(quota, key, 200);

    await quota.settle(reservation, 0);
    const second = await quota.settle(reservation, 0);

    // Settling twice is a retry bug, not a theory: the refund is capped at the
    // capacity so the worst case is a quota that is briefly too generous
    // rather than one that grows every time the path is re-run.
    expect(second.remaining).toBe(1000);
  });
});
