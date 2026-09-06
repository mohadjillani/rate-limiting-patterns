import http from 'k6/http';
import { check } from 'k6';

/**
 * A steady rate below the limit.
 *
 * The control: nothing should be refused, and the point is the latency the
 * limiter adds when it is not refusing anything — which is the cost paid on
 * every request, forever, and the number most implementations never look at.
 */
// Must be below the demo server's limit, or the control measures refusals.
// Pair it: `LIMIT=1000 WINDOW_MS=10000 npm run demo` gives 100/s, comfortably
// above the 50/s here. Do not pass k6's `--vus` or `--duration` flags — they
// replace the arrival-rate scenario with an open-throttle run, which turns the
// control into a burst test.
const RATE = Number(__ENV.RATE || 50);

export const options = {
  scenarios: {
    steady: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: __ENV.DURATION || '30s',
      preAllocatedVUs: Math.max(20, RATE / 2),
    },
  },
  thresholds: {
    // Under the limit, a 429 means the limiter is wrong, not that the load is
    // too high.
    'http_req_failed{expected_response:true}': ['rate<0.01'],
    http_req_duration: ['p(95)<50'],
  },
};

const BASE = __ENV.BASE_URL || 'http://127.0.0.1:3000';

export default function steady() {
  const id = `steady-${__VU}`;
  const response = http.get(`${BASE}/api/ping`, { headers: { 'x-client-id': id } });

  check(response, {
    allowed: (r) => r.status === 200,
    'reports the allowance': (r) => r.headers['Ratelimit-Remaining'] !== undefined,
  });
}
