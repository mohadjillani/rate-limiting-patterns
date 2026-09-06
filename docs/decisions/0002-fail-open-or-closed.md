# 2. Make the Redis-is-down behaviour a decision, not a `catch`

Status: accepted

## Context

Redis will be unavailable at some point. Most rate limiter implementations
handle this in a `try/catch` that logs and calls `next()`, which is a decision
to fail open — made implicitly, usually by whoever wrote the error handling, and
usually not written down.

Both behaviours are defensible and they are not interchangeable:

- **Fail open** keeps the service up and unprotected. Right when the limit
  exists for fairness; wrong when it exists to stop abuse, because an attacker
  who can make Redis unavailable has also removed the limit.
- **Fail closed** lets nothing through unmetered, and turns a Redis outage into
  an outage of everything behind the limiter.

## Decision

`withDegradation(limiter, { policy })` takes `'open'` or `'closed'`
explicitly. There is no default. A circuit breaker sits in front: after a
threshold of consecutive failures it stops calling Redis for a cooldown, then
lets one request through to test recovery. Every degraded decision is reported
through `onDegraded` and carries `degraded: true`.

## Consequences

The behaviour is in the call site, so a reader can see what happens during an
outage without reading the error handling.

The breaker is not decoration. Without it, every request during an outage waits
for a connection timeout first, and a rate limiter that adds two seconds to
every request has taken the service down more effectively than the missing limit
would have.

`onDegraded` exists because the failure that actually costs money is the silent
one: a service that has run unprotected for a week because failing open logged
at debug level. Wire it to a counter and alert on it.

Half-open lets exactly one request through per cooldown. More would re-flood a
Redis that is only just back.
