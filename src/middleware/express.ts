import type { NextFunction, Request, Response } from 'express';
import type { Decision, RateLimiter } from '../limiter.ts';

export interface RateLimitMiddlewareOptions {
  /** The per-client limiter. */
  limiter: RateLimiter;
  /**
   * A second limiter applied to every request under one key.
   *
   * Per-client limits do not protect a service from many clients. A global
   * limiter is the backstop, and the order matters: the per-client check runs
   * first so a single noisy client is refused before it can spend the global
   * allowance that everyone else needs.
   */
  global?: { limiter: RateLimiter; key?: string };
  /** Derives the client identity. Defaults to the socket address. */
  keyFor?: (req: Request) => string;
  /** Requests charged per call, e.g. a heavier cost for an expensive route. */
  costFor?: (req: Request) => number;
  onLimited?: (req: Request, decision: Decision, scope: 'client' | 'global') => void;
}

/**
 * Sets the IETF draft `RateLimit-*` headers.
 *
 * Named without the `X-` prefix because the draft dropped it, and sent on every
 * response rather than only on a 429: a client can only slow down before it is
 * refused if it is told where it stands while it is still being served.
 */
export function setHeaders(res: Response, decision: Decision): void {
  const resetSeconds = Math.max(0, Math.ceil((decision.resetAt - Date.now()) / 1000));
  res.setHeader('RateLimit-Limit', decision.limit);
  res.setHeader('RateLimit-Remaining', decision.remaining);
  res.setHeader('RateLimit-Reset', resetSeconds);
}

export function rateLimit(options: RateLimitMiddlewareOptions) {
  const keyFor = options.keyFor ?? ((req: Request) => req.ip ?? 'unknown');
  const costFor = options.costFor ?? (() => 1);

  return async function rateLimitMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const cost = costFor(req);
    const decision = await options.limiter.consume(keyFor(req), cost);

    if (!decision.allowed) {
      deny(res, decision);
      options.onLimited?.(req, decision, 'client');
      return;
    }

    if (options.global) {
      const globalDecision = await options.global.limiter.consume(
        options.global.key ?? 'global',
        cost,
      );
      if (!globalDecision.allowed) {
        deny(res, globalDecision);
        options.onLimited?.(req, globalDecision, 'global');
        return;
      }
      // The client's own headers are the useful ones to return: they are what
      // the client can act on. The global limit is not their business.
    }

    setHeaders(res, decision);
    next();
  };
}

function deny(res: Response, decision: Decision): void {
  setHeaders(res, decision);
  // Seconds, and never zero: `Retry-After: 0` invites an immediate retry,
  // which is the behaviour the limit exists to prevent.
  res.setHeader('Retry-After', Math.max(1, Math.ceil(decision.retryAfterMs / 1000)));
  res.status(429).json({
    error: 'rate_limited',
    retryAfterMs: decision.retryAfterMs,
  });
}
