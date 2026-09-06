import type { Decision, RateLimiter } from './limiter.ts';

export type DegradePolicy = 'open' | 'closed';

export interface DegradeOptions {
  /**
   * What to do when Redis cannot answer.
   *
   * `open` allows the request. The service stays up and is unprotected for the
   * duration — the right choice when the rate limit exists to be fair, and the
   * wrong one when it exists to stop abuse.
   *
   * `closed` refuses. Nothing gets through unmetered, and a Redis outage
   * becomes a full outage of everything behind the limiter.
   *
   * There is no third option, and picking one is the point: an implementation
   * that has not decided fails open by accident, usually inside a `catch` that
   * logs and continues.
   */
  policy: DegradePolicy;
  /** Consecutive failures before the breaker opens and stops calling Redis. */
  threshold?: number;
  /** How long to stay open before letting one request test the connection. */
  cooldownMs?: number;
  onDegraded?: (error: unknown, policy: DegradePolicy) => void;
}

export interface DegradedDecision extends Decision {
  /** True when Redis did not answer and the policy decided instead. */
  degraded: boolean;
}

/**
 * Wraps a limiter so a Redis failure produces a decision rather than an
 * exception.
 *
 * The breaker matters as much as the policy. Without one, every request during
 * an outage waits for a connection timeout first, and a rate limiter that adds
 * a two-second delay to everything has taken the service down more effectively
 * than the missing limit would have.
 */
/**
 * A limiter whose decisions say whether Redis actually answered.
 *
 * Declared as its own interface rather than an intersection with
 * `RateLimiter`: an intersection resolves `consume` to the first signature, so
 * the extra field would be invisible to every caller.
 */
export interface DegradingLimiter extends Omit<RateLimiter, 'consume'> {
  consume(key: string, cost?: number): Promise<DegradedDecision>;
}

export function withDegradation(limiter: RateLimiter, options: DegradeOptions): DegradingLimiter {
  const threshold = options.threshold ?? 5;
  const cooldownMs = options.cooldownMs ?? 5_000;

  let failures = 0;
  let openedAt = 0;

  const fallback = (error: unknown): DegradedDecision => {
    options.onDegraded?.(error, options.policy);
    return {
      allowed: options.policy === 'open',
      limit: 0,
      remaining: 0,
      resetAt: Date.now() + cooldownMs,
      retryAfterMs: options.policy === 'open' ? 0 : cooldownMs,
      degraded: true,
    };
  };

  return {
    name: limiter.name,

    async consume(key: string, cost = 1): Promise<DegradedDecision> {
      const isOpen = failures >= threshold;
      // Half-open: one request is allowed through to find out whether Redis is
      // back. Letting them all through would re-flood a recovering instance.
      if (isOpen && Date.now() - openedAt < cooldownMs) {
        return fallback(new Error('breaker open'));
      }

      try {
        const decision = await limiter.consume(key, cost);
        failures = 0;
        return { ...decision, degraded: false };
      } catch (error) {
        failures += 1;
        if (failures >= threshold) openedAt = Date.now();
        return fallback(error);
      }
    },

    peek: (key) => limiter.peek(key),
    reset: (key) => limiter.reset(key),
  };
}
