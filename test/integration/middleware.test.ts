import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/demo/server.ts';

const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
let server: Server;
let base: string;

beforeAll(async () => {
  const app = createApp({
    redis,
    strategy: 'fixed-window',
    limit: 3,
    windowMs: 60_000,
    globalLimit: 100,
    policy: 'open',
  });

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      resolve();
    });
  });
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) =>
    server.close(() => {
      resolve();
    }),
  );
  const keys = await redis.keys('demo:*');
  if (keys.length > 0) await redis.del(...keys);
  await redis.quit();
});

function client(): string {
  return `c-${String(Math.random()).slice(2)}`;
}

async function get(path: string, id: string): Promise<Response> {
  return fetch(`${base}${path}`, { headers: { 'x-client-id': id } });
}

describe('the express middleware', () => {
  it('does not rate limit the health check', async () => {
    for (let i = 0; i < 10; i += 1) {
      expect((await fetch(`${base}/health`)).status).toBe(200);
    }
  });

  /**
   * Headers on every response, not only on the 429.
   *
   * A client can only slow down before it is refused if it is told where it
   * stands while it is still being served.
   */
  it('reports the allowance on a successful response', async () => {
    const response = await get('/api/ping', client());

    expect(response.headers.get('RateLimit-Limit')).toBe('3');
    expect(response.headers.get('RateLimit-Remaining')).toBe('2');
    expect(Number(response.headers.get('RateLimit-Reset'))).toBeGreaterThan(0);
  });

  it('returns 429 with Retry-After once the allowance is spent', async () => {
    const id = client();
    for (let i = 0; i < 3; i += 1) expect((await get('/api/ping', id)).status).toBe(200);

    const limited = await get('/api/ping', id);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ error: 'rate_limited' });
    // Never zero: `Retry-After: 0` invites the immediate retry the limit
    // exists to prevent.
    expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1);
  });

  it('limits each client separately', async () => {
    const first = client();
    const second = client();

    for (let i = 0; i < 3; i += 1) await get('/api/ping', first);

    expect((await get('/api/ping', first)).status).toBe(429);
    expect((await get('/api/ping', second)).status).toBe(200);
  });

  it('charges an expensive route more', async () => {
    const id = client();
    // Cost 5 against a limit of 3: refused on the first call, where a
    // per-request limit would have allowed it.
    expect((await get('/api/expensive', id)).status).toBe(429);
    expect((await get('/api/ping', id)).status).toBe(200);
  });
});
