# Methodology

Written before the benchmarks were run, so the measurements answer questions
that were decided in advance rather than the ones that happened to look good.

## What is measured

**Boundary overshoot.** The whole allowance is spent in the last ~150 ms of one
window, then again ~300 ms later in the next. A limiter with a true sliding
window should allow `limit` across that span. The number reported is
`allowed ÷ limit`: 1.00× is exact, 2.00× is twice the allowance in well under
one window.

Timing is aligned using Redis' own clock (`TIME`), not the benchmark process's,
for the same reason the Lua scripts use it: two clocks a few hundred
milliseconds apart would disagree about where the boundary is, and the
measurement would be of the skew rather than of the algorithm.

**Cost per decision.** 50 clients × 40 requests each, one key per client.
Reported: Redis commands per decision (the delta in
`total_commands_processed`, which includes the calls each Lua script makes
internally), bytes held across the strategy's keys via `MEMORY USAGE`, and p50
and p99 of the round-trip time from the client.

## What these numbers do not claim

**They are not throughput numbers.** Redis runs on the same machine as the
benchmark. There is no network, no TLS, no contention from other tenants. The
latency column is a floor. Treat the _ordering_ as meaningful and the absolute
values as unavailable for capacity planning.

**They are not a verdict.** 2.00× overshoot is disqualifying for a limit that
exists to stop abuse and irrelevant for one that exists to keep a report
endpoint from being hammered. The measurement says what each strategy does; it
does not say which one you need.

**The memory figure is per active client at this limit.** Sliding log holds one
sorted-set member per accepted request, so its cost scales with `limit`, not
with the number of clients. At a limit of 100 it is roughly 34× the fixed
window; at a limit of 1,000 the ratio is much worse. Multiply before copying.

**Single Redis, no failover.** Nothing here measures behaviour during a
failover, under `maxmemory` eviction, or across a cluster where the keys of one
decision could land on different slots. The strategies each use one key per
decision, which makes them cluster-safe; that is a design property, not a
measured one.

**One machine, one run.** No repeat runs, no confidence intervals. The gaps
being reported — 2× versus 1×, 60 bytes versus 2 KB — are far larger than the
run-to-run variation, which is why a single run is enough to support the
claims made. A claim about a 5% difference would not be.

## Reproducing

```bash
redis-server &          # or docker compose up -d
npm run bench:accuracy  # writes bench/results/accuracy.json
npm run bench:render    # writes docs/bench/{README.md,chart.svg}
```

The JSON is not committed — it is machine-specific, and a committed copy would
invite comparing your machine's numbers against someone else's. The rendered
report is committed, with the machine it came from printed at the top.

## The k6 scenarios

`bench/k6/` holds three load profiles against the demo server: steady rate,
burst, and a burst deliberately straddling a window boundary. They measure the
_middleware_ rather than the strategies — request latency, the share of 429s,
and whether the `RateLimit-*` headers stay consistent under load.

They are not part of CI. A load test on a shared runner measures the runner.
Run them locally, against a demo server started with the strategy you want to
compare:

```bash
# The steady scenario is the control and must run *below* the limit:
# 1000 per 10s is 100/s, against the scenario's 50/s.
STRATEGY=token-bucket LIMIT=1000 WINDOW_MS=10000 npm run demo &
k6 run bench/k6/steady.js
k6 run bench/k6/burst.js                       # 500/s: refusals expected
k6 run -e WINDOW_MS=10000 bench/k6/boundary.js # compare across strategies
```

Do not pass k6's `--vus` or `--duration` flags to the arrival-rate scenarios.
They replace the scenario with an open-throttle run, which turns the control
into a burst test — the numbers still come out, and they measure something
else.
