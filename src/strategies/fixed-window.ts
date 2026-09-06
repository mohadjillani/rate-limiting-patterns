import type { Redis } from 'ioredis';
import type { Decision, LimiterOptions, RateLimiter } from '../limiter.ts';
import { defineScript, runner, toDecision } from './script.ts';

/**
 * Counts requests in a clock-aligned window.
 *
 * The cheapest of the three: one counter per key per window, one round trip,
 * memory proportional to active clients rather than to requests.
 *
 * Its flaw is the boundary. A client that spends the whole allowance in the
 * last moment of one window and the whole allowance in the first moment of the
 * next has made 2× the limit in a period shorter than one window, and no
 * amount of tuning removes it — it is what "fixed window" means. The benchmark
 * measures exactly how much gets through.
 */
export class FixedWindowLimiter implements RateLimiter {
  readonly name = 'fixed-window';
  private readonly prefix: string;

  constructor(
    private readonly redis: Redis,
    private readonly options: LimiterOptions,
  ) {
    this.prefix = options.prefix ?? 'rl:fw';
    defineScript(redis, 'fixed_window', 1);
  }

  private key(key: string): string {
    return `${this.prefix}:${key}`;
  }

  async consume(key: string, cost = 1): Promise<Decision> {
    const result = await runner(this.redis, 'fixed_window')(
      this.key(key),
      this.options.limit,
      this.options.windowMs,
      cost,
    );
    return toDecision(result);
  }

  peek(key: string): Promise<Decision> {
    // Cost zero: the script's own check rejects nothing at zero cost, so it
    // reports state without changing it.
    return this.consume(key, 0);
  }

  async reset(key: string): Promise<void> {
    const keys = await this.redis.keys(`${this.key(key)}:*`);
    if (keys.length > 0) await this.redis.del(...keys);
  }
}
