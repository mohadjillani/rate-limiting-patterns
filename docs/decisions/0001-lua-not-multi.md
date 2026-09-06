# 1. One Lua script per decision, not MULTI or a read-then-write

Status: accepted

## Context

A rate-limit decision reads a counter and writes it back. Done from the
application, two nodes read the same value and both write, and the limit is
exceeded by however many nodes were racing. No amount of application code fixes
it, because the gap between the read and the write is where the problem lives.

`WATCH`/`MULTI` closes the gap by retrying on conflict, which under contention —
exactly when a rate limiter matters — means several round trips per decision and
a retry loop that gets longer as load rises.

## Decision

Each strategy is one Lua script, invoked with `EVALSHA` through ioredis'
`defineCommand`. Redis runs it atomically, so a decision is one round trip and
cannot interleave with another.

The script reads the clock with Redis' `TIME` rather than taking a timestamp
from the caller.

## Consequences

A decision is atomic by construction. The test that pins this runs 200
simultaneous `consume` calls against one key and asserts that exactly `limit`
are allowed — not approximately.

Using Redis' clock removes a whole class of bug: application nodes with a few
hundred milliseconds of skew would otherwise disagree about which window a
request belongs to, and the limit would be enforced twice at a boundary or not
at all. It also means the limiter has one clock, which is the only number of
clocks a distributed decision can safely have.

`defineCommand`'s `EVALSHA`-then-`EVAL` fallback matters more than it looks.
Redis drops its script cache on restart and on `SCRIPT FLUSH`; a client that
only ever sends `EVALSHA` starts returning `NOSCRIPT` to every request the
moment that happens.

The cost is Lua. The logic lives in a language with no types and no tests of
its own, and it is debugged by reading it carefully. Each script is kept short
enough to hold in your head for that reason, and the behaviour is pinned by
tests through the TypeScript interface.
