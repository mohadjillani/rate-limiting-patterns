import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';

/**
 * A burst deliberately straddling a window boundary.
 *
 * `allowed_per_burst` is the number to read — how many of one client's 30
 * requests got through in one straddling burst. Pair it with a limit the burst
 * can actually exceed:
 *
 *   STRATEGY=fixed-window LIMIT=20 WINDOW_MS=10000 npm run demo
 *
 * then run the same scenario against each strategy and compare. A limit
 * generous enough to swallow the burst measures nothing.
 *
 * This is a load-shaped sanity check, not the measurement of record. Client
 * clocks, scheduling jitter and the sleep's own precision all blur the
 * boundary, so the separation it shows is directional. `bench/accuracy.ts`
 * aligns to Redis' clock and is the number the report quotes.
 */
const allowedPerBurst = new Trend('allowed_per_burst');

export const options = {
  scenarios: {
    straddle: {
      executor: 'per-vu-iterations',
      vus: Number(__ENV.VUS || 5),
      iterations: Number(__ENV.ITERATIONS || 6),
      maxDuration: '120s',
    },
  },
  thresholds: {
    // A script exception leaves k6 exiting 0 with a summary that looks fine,
    // so the run asserts it actually did the work.
    checks: ['rate>0.99'],
    allowed_per_burst: ['min>=0'],
  },
};

const BASE = __ENV.BASE_URL || 'http://127.0.0.1:3000';
const WINDOW_MS = Number(__ENV.WINDOW_MS || 10000);
const BURST = Number(__ENV.BURST || 30);

export default function boundary() {
  const id = `boundary-${__VU}`;

  // Sleep until just before the next window boundary, then fire everything.
  const untilBoundary = WINDOW_MS - (Date.now() % WINDOW_MS);
  sleep(Math.max(0, untilBoundary - 200) / 1000);

  let allowed = 0;
  for (let i = 0; i < BURST; i += 1) {
    const response = http.get(`${BASE}/api/ping`, { headers: { 'x-client-id': id } });
    if (response.status === 200) {
      allowed += 1;
    }
    check(response, { answered: (r) => r.status === 200 || r.status === 429 });
  }
  allowedPerBurst.add(allowed);
}
