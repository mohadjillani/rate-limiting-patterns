import { readFileSync } from 'node:fs';
import type { Redis } from 'ioredis';
import type { Decision } from '../limiter.ts';

/** What every script returns: allowed, limit, remaining, resetAt, retryAfterMs. */
export type ScriptResult = [number, number, number, number, number];

export function loadScript(name: string): string {
  return readFileSync(new URL(`lua/${name}.lua`, import.meta.url), 'utf8');
}

/**
 * Registers a Lua script as a method on the client.
 *
 * `defineCommand` sends EVALSHA and falls back to EVAL when the script is not
 * cached — which matters more than it sounds. Redis drops its script cache on
 * restart and on `SCRIPT FLUSH`, and a limiter that only ever sends EVALSHA
 * starts returning NOSCRIPT to every request the moment that happens.
 */
export function defineScript(redis: Redis, name: string, keys: number): void {
  redis.defineCommand(name, { numberOfKeys: keys, lua: loadScript(name) });
}

export function toDecision(result: ScriptResult): Decision {
  const [allowed, limit, remaining, resetAt, retryAfterMs] = result;
  return {
    allowed: allowed === 1,
    limit,
    remaining,
    resetAt,
    retryAfterMs,
  };
}

/** ioredis types custom commands loosely; this keeps the casts in one place. */
export type ScriptRunner = (...args: (string | number)[]) => Promise<ScriptResult>;

export function runner(redis: Redis, name: string): ScriptRunner {
  const client = redis as unknown as Record<string, ScriptRunner>;
  const command = client[name];
  if (!command) throw new Error(`script ${name} was not defined on this client`);
  return command.bind(redis);
}
