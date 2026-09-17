import type { Redis } from 'ioredis';
import type { Decision } from './limiter.ts';
import { defineScript, runner, toDecision } from './strategies/script.ts';

export interface ProviderQuotaOptions {
  /** Requests the provider allows per window (RPM at the default window). */
  requestsPerMinute: number;
  /** Tokens the provider allows per window (TPM at the default window). */
  tokensPerMinute: number;
  /** Defaults to 60s, because that is the period providers publish quotas in. */
  windowMs?: number;
  prefix?: string;
}

/**
 * A granted reservation, to be handed back to {@link ProviderQuota.settle}.
 *
 * It carries the estimate so settling needs only the actual usage — the caller
 * should not have to remember what it guessed.
 */
export interface Reservation {
  readonly key: string;
  readonly estimatedTokens: number;
}

/**
 * Rate limiting for a quota you do not own.
 *
 * The three strategies in this repo all assume the cost of a call is known
 * when the call is admitted. For a model provider it is not: you know the
 * prompt size, and the completion — the larger and more variable half — is
 * known only once the response has finished streaming. A limiter that charges
 * the prompt and stops is wrong by however long the answer turned out to be,
 * and the error is one-sided, so it accumulates.
 *
 * So admission is two-phase. `reserve` charges an estimate against both the
 * request and token quotas atomically; `settle` corrects it once the real
 * number is known. Between those two calls the estimate is held, which is what
 * stops a burst of concurrent calls from each seeing the allowance the others
 * are about to spend.
 */
export class ProviderQuota {
  readonly name = 'provider-quota';
  private readonly prefix: string;
  private readonly windowMs: number;

  constructor(
    private readonly redis: Redis,
    private readonly options: ProviderQuotaOptions,
  ) {
    this.prefix = options.prefix ?? 'rl:pq';
    this.windowMs = options.windowMs ?? 60_000;
    defineScript(redis, 'provider_quota', 2);
    defineScript(redis, 'provider_settle', 1);
    defineScript(redis, 'provider_backoff', 1);
  }

  private keys(key: string): [string, string] {
    return [`${this.prefix}:${key}:req`, `${this.prefix}:${key}:tok`];
  }

  /**
   * Charges one request and `estimatedTokens` against the quota.
   *
   * The returned decision reports the *token* allowance, since that is the one
   * a caller can act on by sending less context.
   */
  async reserve(
    key: string,
    estimatedTokens: number,
    requestCost = 1,
  ): Promise<{ decision: Decision; reservation: Reservation | null }> {
    const [requestKey, tokenKey] = this.keys(key);
    const result = await runner(this.redis, 'provider_quota')(
      requestKey,
      tokenKey,
      this.options.requestsPerMinute,
      this.options.tokensPerMinute,
      this.windowMs,
      estimatedTokens,
      requestCost,
    );
    const decision = toDecision(result);
    return {
      decision,
      reservation: decision.allowed ? { key, estimatedTokens } : null,
    };
  }

  /**
   * Corrects a reservation against the tokens the call actually used.
   *
   * Call it on every path a reserved call can end on, including failure: a
   * request that errors after the provider has already read the prompt has
   * still spent those tokens, and one that never left the process has spent
   * none. Skipping it on the error path is the leak that makes a limiter
   * drift tighter than the quota it is modelling.
   */
  async settle(reservation: Reservation, actualTokens: number): Promise<Decision> {
    const [, tokenKey] = this.keys(reservation.key);
    const result = await runner(this.redis, 'provider_settle')(
      tokenKey,
      this.options.tokensPerMinute,
      this.windowMs,
      reservation.estimatedTokens - actualTokens,
    );
    return toDecision(result);
  }

  /**
   * Records a 429 from the provider, holding the quota until its reset.
   *
   * Pass the `Retry-After` header the provider sent. Local accounting is a
   * model of someone else's counter and the provider is the authority on when
   * it disagrees — commonly because the quota is shared with other clients of
   * the same key.
   */
  async backOff(key: string, retryAfterMs: number): Promise<Decision> {
    const [requestKey] = this.keys(key);
    const result = await runner(this.redis, 'provider_backoff')(
      requestKey,
      this.options.requestsPerMinute,
      this.windowMs,
      retryAfterMs,
    );
    return toDecision(result);
  }

  /** Current state, charging neither a request nor a token. */
  async peek(key: string): Promise<Decision> {
    const { decision } = await this.reserve(key, 0, 0);
    return decision;
  }

  async reset(key: string): Promise<void> {
    await this.redis.del(...this.keys(key));
  }
}
