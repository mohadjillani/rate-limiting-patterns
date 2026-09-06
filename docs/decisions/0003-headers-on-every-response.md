# 3. Send `RateLimit-*` headers on every response

Status: accepted

## Context

Many implementations set rate-limit headers only on the 429. By then the client
has already been refused, and the information arrives exactly one request too
late to be useful.

The header names are also a choice. `X-RateLimit-*` is what most APIs still
send; the IETF draft dropped the `X-` prefix, in line with RFC 6648.

## Decision

`RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` on every
response, and `Retry-After` in addition on a 429. `RateLimit-Reset` is seconds
from now, not an absolute timestamp. `Retry-After` is never zero.

Where a per-client and a global limiter are both configured, the client's own
numbers are the ones returned — they are what the client can act on, and the
global limit is not their business.

## Consequences

A well-behaved client can slow down before it is refused, which is the only
point at which slowing down helps anyone.

`Retry-After: 0` is worth calling out: it invites an immediate retry, which is
the behaviour the limit exists to prevent. It is floored at one second.

Seconds rather than a timestamp avoids requiring the client's clock to agree
with the server's — and a client whose clock is wrong is a client that will
either retry too early or wait far too long.

The cost is three headers on every response. It is real for a very
high-volume API and small enough that no measurement here justified removing
them.
