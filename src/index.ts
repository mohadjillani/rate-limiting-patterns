export type { Decision, LimiterOptions, RateLimiter } from './limiter.ts';
export { LimitExceededError } from './limiter.ts';
export { FixedWindowLimiter } from './strategies/fixed-window.ts';
export { SlidingLogLimiter } from './strategies/sliding-log.ts';
export { TokenBucketLimiter } from './strategies/token-bucket.ts';
export { rateLimit, type RateLimitMiddlewareOptions } from './middleware/express.ts';
export {
  withDegradation,
  type DegradePolicy,
  type DegradedDecision,
  type DegradingLimiter,
} from './degrade.ts';
