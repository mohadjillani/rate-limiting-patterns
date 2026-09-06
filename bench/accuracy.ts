import { writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import { Redis } from 'ioredis';
import type { RateLimiter } from '../src/limiter.ts';
import { FixedWindowLimiter } from '../src/strategies/fixed-window.ts';
import { SlidingLogLimiter } from '../src/strategies/sliding-log.ts';
import { TokenBucketLimiter } from '../src/strategies/token-bucket.ts';

const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');

const WINDOW_MS = 2_000;
const LIMIT = 100;
const CLIENTS = 50;
const REQUESTS_PER_CLIENT = 40;

interface StrategyUnderTest {
  name: string;
  prefix: string;
  build: () => RateLimiter;
}

const STRATEGIES: StrategyUnderTest[] = [
  {
    name: 'fixed-window',
    prefix: 'bench:fw',
    build: () =>
      new FixedWindowLimiter(redis, { limit: LIMIT, windowMs: WINDOW_MS, prefix: 'bench:fw' }),
  },
  {
    name: 'sliding-log',
    prefix: 'bench:sl',
    build: () =>
      new SlidingLogLimiter(redis, { limit: LIMIT, windowMs: WINDOW_MS, prefix: 'bench:sl' }),
  },
  {
    name: 'token-bucket',
    prefix: 'bench:tb',
    build: () =>
      new TokenBucketLimiter(redis, { limit: LIMIT, windowMs: WINDOW_MS, prefix: 'bench:tb' }),
  },
];

async function clear(prefix: string): Promise<void> {
  const keys = await redis.keys(`${prefix}*`);
  if (keys.length > 0) await redis.del(...keys);
}

async function commandsProcessed(): Promise<number> {
  const info = await redis.info('stats');
  return Number(/total_commands_processed:(\d+)/.exec(info)?.[1] ?? 0);
}

async function memoryFor(prefix: string): Promise<number> {
  const keys = await redis.keys(`${prefix}*`);
  let total = 0;
  for (const key of keys) total += (await redis.memory('USAGE', key)) ?? 0;
  return total;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return Number((sorted[index] ?? 0).toFixed(3));
}

async function redisNow(): Promise<number> {
  const [seconds, micros] = await redis.time();
  return Number(seconds) * 1000 + Math.floor(Number(micros) / 1000);
}

export interface BoundaryResult {
  strategy: string;
  /** Allowed in the last moment of one window plus the first of the next. */
  allowedAcrossBoundary: number;
  /** What a perfectly sliding limiter would have allowed over that span. */
  ideal: number;
  /** allowedAcrossBoundary / ideal — 1.0 is exact, 2.0 is twice the limit. */
  overshoot: number;
}

/**
 * How much a client gets through by straddling a window boundary.
 *
 * The whole allowance is spent just before a boundary and again just after. A
 * strategy with a true sliding window allows `LIMIT` over that span; a fixed
 * window allows `2 × LIMIT`, in a period much shorter than one window.
 */
async function measureBoundary(strategy: StrategyUnderTest): Promise<BoundaryResult> {
  await clear(strategy.prefix);
  const limiter = strategy.build();
  const key = 'boundary';

  const now = await redisNow();
  const untilBoundary = WINDOW_MS - (now % WINDOW_MS);
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, untilBoundary - 150)));

  const before = await Promise.all(Array.from({ length: LIMIT }, () => limiter.consume(key)));
  await new Promise((resolve) => setTimeout(resolve, 300));
  const after = await Promise.all(Array.from({ length: LIMIT }, () => limiter.consume(key)));

  const allowed = [...before, ...after].filter((decision) => decision.allowed).length;
  return {
    strategy: strategy.name,
    allowedAcrossBoundary: allowed,
    ideal: LIMIT,
    overshoot: Number((allowed / LIMIT).toFixed(2)),
  };
}

export interface CostResult {
  strategy: string;
  decisions: number;
  /** Redis commands the whole run cost, including the ones the scripts issue. */
  redisCommands: number;
  commandsPerDecision: number;
  /** Bytes held across every key the strategy created. */
  memoryBytes: number;
  bytesPerClient: number;
  p50Ms: number;
  p99Ms: number;
}

/**
 * What each strategy costs Redis for the same traffic.
 *
 * Latency here is measured against a Redis on the same machine, so it is a
 * floor rather than a production number — the interesting comparison is
 * between the strategies, and the ordering holds because they all pay the same
 * network cost.
 */
async function measureCost(strategy: StrategyUnderTest): Promise<CostResult> {
  await clear(strategy.prefix);
  const limiter = strategy.build();

  const before = await commandsProcessed();
  const latencies: number[] = [];

  for (let round = 0; round < REQUESTS_PER_CLIENT; round += 1) {
    await Promise.all(
      Array.from({ length: CLIENTS }, async (_unused, client) => {
        const started = performance.now();
        await limiter.consume(`client-${String(client)}`);
        latencies.push(performance.now() - started);
      }),
    );
  }

  const after = await commandsProcessed();
  const memoryBytes = await memoryFor(strategy.prefix);
  const decisions = CLIENTS * REQUESTS_PER_CLIENT;

  return {
    strategy: strategy.name,
    decisions,
    // The INFO calls this function makes are inside the delta, so the figure
    // is rounded rather than reported to the command.
    redisCommands: after - before,
    commandsPerDecision: Number(((after - before) / decisions).toFixed(2)),
    memoryBytes,
    bytesPerClient: Math.round(memoryBytes / CLIENTS),
    p50Ms: percentile(latencies, 50),
    p99Ms: percentile(latencies, 99),
  };
}

export interface BenchReport {
  generatedAt: string;
  machine: string;
  redisVersion: string;
  parameters: { limit: number; windowMs: number; clients: number; requestsPerClient: number };
  boundary: BoundaryResult[];
  cost: CostResult[];
}

async function main(): Promise<void> {
  const serverInfo = await redis.info('server');
  const report: BenchReport = {
    generatedAt: new Date().toISOString(),
    machine: `${os.type()} ${os.arch()}, ${String(os.cpus().length)} cores, Node ${process.version}`,
    redisVersion: /redis_version:([^\r\n]+)/.exec(serverInfo)?.[1] ?? 'unknown',
    parameters: {
      limit: LIMIT,
      windowMs: WINDOW_MS,
      clients: CLIENTS,
      requestsPerClient: REQUESTS_PER_CLIENT,
    },
    boundary: [],
    cost: [],
  };

  for (const strategy of STRATEGIES) {
    report.boundary.push(await measureBoundary(strategy));
    report.cost.push(await measureCost(strategy));
    await clear(strategy.prefix);
  }

  await mkdir(new URL('results/', import.meta.url), { recursive: true });
  const output = new URL('results/accuracy.json', import.meta.url);
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);

  console.log(`boundary overshoot (1.00 = exact, 2.00 = twice the limit)`);
  for (const result of report.boundary) {
    console.log(
      `  ${result.strategy.padEnd(14)} ${result.overshoot.toFixed(2)}× (${String(result.allowedAcrossBoundary)}/${String(result.ideal)})`,
    );
  }
  console.log(`\ncost per decision`);
  for (const result of report.cost) {
    console.log(
      `  ${result.strategy.padEnd(14)} ${String(result.commandsPerDecision)} cmds, ${String(result.bytesPerClient)} B/client, p99 ${String(result.p99Ms)}ms`,
    );
  }

  await redis.quit();
}

await main();
