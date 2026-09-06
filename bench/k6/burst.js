import http from 'k6/http';
import { check } from 'k6';

/**
 * Far above the limit, from a small number of clients.
 *
 * What is being checked is not that requests are refused — they obviously are —
 * but that refusal stays cheap. A limiter that gets slower as it refuses more
 * turns a burst into an outage, which is the opposite of its job.
 */
export const options = {
  scenarios: {
    burst: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.RATE || 500),
      timeUnit: '1s',
      duration: __ENV.DURATION || '20s',
      preAllocatedVUs: 100,
    },
  },
  thresholds: {
    // A 429 is a correct response here, so the built-in failure rate is not
    // the signal. Latency is.
    http_req_duration: ['p(95)<100', 'p(99)<250'],
  },
};

const BASE = __ENV.BASE_URL || 'http://127.0.0.1:3000';

export default function burst() {
  const id = `burst-${__VU % 5}`;
  const response = http.get(`${BASE}/api/ping`, { headers: { 'x-client-id': id } });

  check(response, {
    answered: (r) => r.status === 200 || r.status === 429,
    'refusals carry Retry-After': (r) => r.status !== 429 || r.headers['Retry-After'] !== undefined,
  });
}
