import { describe, expect, it, vi } from 'vitest';
import { withDegradation } from '../../src/degrade.ts';
import type { Decision, RateLimiter } from '../../src/limiter.ts';

const allowed: Decision = { allowed: true, limit: 10, remaining: 9, resetAt: 0, retryAfterMs: 0 };

function limiter(behaviour: () => Promise<Decision>): RateLimiter {
  return {
    name: 'stub',
    consume: behaviour,
    peek: () => Promise.resolve(allowed),
    reset: () => Promise.resolve(),
  };
}

const failing = (): Promise<Decision> => Promise.reject(new Error('ECONNREFUSED'));

describe('withDegradation', () => {
  it('passes decisions straight through while Redis answers', async () => {
    const wrapped = withDegradation(
      limiter(() => Promise.resolve(allowed)),
      { policy: 'closed' },
    );
    const decision = await wrapped.consume('key');

    expect(decision).toMatchObject({ allowed: true, remaining: 9, degraded: false });
  });

  it('allows the request when the policy is open', async () => {
    const wrapped = withDegradation(limiter(failing), { policy: 'open' });
    const decision = await wrapped.consume('key');

    expect(decision.allowed).toBe(true);
    expect(decision.degraded).toBe(true);
    expect(decision.retryAfterMs).toBe(0);
  });

  it('refuses the request when the policy is closed', async () => {
    const wrapped = withDegradation(limiter(failing), { policy: 'closed', cooldownMs: 3_000 });
    const decision = await wrapped.consume('key');

    expect(decision.allowed).toBe(false);
    expect(decision.degraded).toBe(true);
    // Non-zero, so a client that respects Retry-After does not hammer a Redis
    // instance that is already struggling.
    expect(decision.retryAfterMs).toBe(3_000);
  });

  it('never throws, whatever the limiter does', async () => {
    const wrapped = withDegradation(
      limiter(() => Promise.reject(new Error('anything at all'))),
      { policy: 'open' },
    );
    await expect(wrapped.consume('key')).resolves.toMatchObject({ degraded: true });
  });

  /**
   * The breaker is not decoration. Without it every request during an outage
   * waits for a connection timeout first, and a limiter that adds two seconds
   * to every request has taken the service down more thoroughly than the
   * missing limit would have.
   */
  it('stops calling Redis once the failure threshold is reached', async () => {
    const consume = vi.fn(failing);
    const wrapped = withDegradation(limiter(consume), {
      policy: 'open',
      threshold: 3,
      cooldownMs: 10_000,
    });

    for (let i = 0; i < 10; i += 1) await wrapped.consume('key');

    expect(consume).toHaveBeenCalledTimes(3);
  });

  it('lets one request through after the cooldown to test the connection', async () => {
    const consume = vi.fn(failing);
    const wrapped = withDegradation(limiter(consume), {
      policy: 'open',
      threshold: 1,
      cooldownMs: 20,
    });

    await wrapped.consume('key');
    expect(consume).toHaveBeenCalledTimes(1);

    await wrapped.consume('key');
    expect(consume).toHaveBeenCalledTimes(1);

    await new Promise((resolve) => setTimeout(resolve, 30));
    await wrapped.consume('key');
    expect(consume).toHaveBeenCalledTimes(2);
  });

  it('closes the breaker again after a success', async () => {
    let fail = true;
    const consume = vi.fn(() => (fail ? failing() : Promise.resolve(allowed)));
    const wrapped = withDegradation(limiter(consume), {
      policy: 'open',
      threshold: 2,
      cooldownMs: 20,
    });

    await wrapped.consume('key');
    await wrapped.consume('key');
    fail = false;

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await wrapped.consume('key')).degraded).toBe(false);

    // Back to normal: the next call is not swallowed by a still-open breaker.
    expect((await wrapped.consume('key')).degraded).toBe(false);
  });

  it('reports every degraded decision so it can be alerted on', async () => {
    const onDegraded = vi.fn();
    const wrapped = withDegradation(limiter(failing), { policy: 'open', onDegraded });

    await wrapped.consume('key');

    // Silent degradation is the failure mode that matters: a service that has
    // been unprotected for a week and nobody noticed.
    expect(onDegraded).toHaveBeenCalledWith(expect.any(Error), 'open');
  });
});
