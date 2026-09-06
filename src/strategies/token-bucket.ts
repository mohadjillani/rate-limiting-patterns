import type { Redis } from 'ioredis';
import type { Decision, LimiterOptions, RateLimiter } from '../limiter.ts';
import { defineScript, runner, toDecision } from './script.ts';

/**
 * Refills continuously and allows a burst up to the capacity.
 *
 * Two numbers per key regardless of traffic, so the memory cost matches the
 * fixed window while the behaviour is smoother: a client that has been idle
 * spends its accumulated allowance at once, and a client at a steady rate is
 * never refused for having been unlucky about where a window boundary fell.
 *
 * The cost is that "100 per minute" no longer means what a window means. A
 * bucket of 100 refilling over a minute permits 100 in the first second and
 * then a trickle, which is usually what an API wants and occasionally not what
 * a contract says.
 */
export class TokenBucketLimiter implements RateLimiter {
  readonly name = 'token-bucket';
  private readonly prefix: string;

  constructor(
    private readonly redis: Redis,
    private readonly options: LimiterOptions,
  ) {
    this.prefix = options.prefix ?? 'rl:tb';
    defineScript(redis, 'token_bucket', 1);
  }

  private key(key: string): string {
    return `${this.prefix}:${key}`;
  }

  async consume(key: string, cost = 1): Promise<Decision> {
    const result = await runner(this.redis, 'token_bucket')(
      this.key(key),
      this.options.limit,
      this.options.windowMs,
      cost,
    );
    return toDecision(result);
  }

  peek(key: string): Promise<Decision> {
    return this.consume(key, 0);
  }

  async reset(key: string): Promise<void> {
    await this.redis.del(this.key(key));
  }
}
