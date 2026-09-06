import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { Decision, LimiterOptions, RateLimiter } from '../limiter.ts';
import { defineScript, runner, toDecision } from './script.ts';

/**
 * Keeps one entry per request and counts the trailing window exactly.
 *
 * It has no boundary flaw — the window really does slide — and it is the
 * expensive one: memory grows with the *rate*, not with the number of clients.
 * A limit of 1,000 per minute means up to 1,000 sorted-set members per key,
 * and a hundred thousand clients at that limit is a Redis sizing question
 * rather than a rounding error.
 *
 * The bound is worth stating precisely: `limit` members per key, plus the
 * sorted set overhead, for as long as a client stays active.
 */
export class SlidingLogLimiter implements RateLimiter {
  readonly name = 'sliding-log';
  private readonly prefix: string;

  constructor(
    private readonly redis: Redis,
    private readonly options: LimiterOptions,
  ) {
    this.prefix = options.prefix ?? 'rl:sl';
    defineScript(redis, 'sliding_log', 1);
  }

  private key(key: string): string {
    return `${this.prefix}:${key}`;
  }

  async consume(key: string, cost = 1): Promise<Decision> {
    const result = await runner(this.redis, 'sliding_log')(
      this.key(key),
      this.options.limit,
      this.options.windowMs,
      cost,
      // Unique per call: ZADD with a repeated member updates a score instead of
      // adding one, so a shared member id would silently stop the count rising.
      randomUUID(),
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
