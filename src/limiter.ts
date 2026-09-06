export interface Decision {
  allowed: boolean;
  /** The configured ceiling, echoed back for the `RateLimit` headers. */
  limit: number;
  /** How much of the allowance is left after this decision. Never negative. */
  remaining: number;
  /** Unix ms at which the allowance is expected to be fully available again. */
  resetAt: number;
  /** How long to wait before retrying. Zero when the request was allowed. */
  retryAfterMs: number;
}

export interface RateLimiter {
  readonly name: string;
  /**
   * Charges `cost` against `key` and decides.
   *
   * One round trip, atomic. Everything else about a rate limiter follows from
   * that: a read-then-write from the application cannot be made correct with
   * more code, because between the read and the write another node has already
   * spent the allowance.
   */
  consume(key: string, cost?: number): Promise<Decision>;
  /** Current state without charging anything. For tests and dashboards. */
  peek(key: string): Promise<Decision>;
  reset(key: string): Promise<void>;
}

export interface LimiterOptions {
  /** Requests allowed per window, or bucket capacity for the token bucket. */
  limit: number;
  windowMs: number;
  /** Prefix for every Redis key, so one instance can host several limiters. */
  prefix?: string;
}

export class LimitExceededError extends Error {
  constructor(readonly decision: Decision) {
    super(`rate limit exceeded, retry in ${String(decision.retryAfterMs)}ms`);
    this.name = 'LimitExceededError';
  }
}
