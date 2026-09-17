# 4. Reserve an estimate, then settle it, for quotas we do not own

Status: accepted

## Context

The three strategies here admit a call by charging a cost that is known at
admission time. One HTTP request costs one, and the accounting is exact.

An upstream model provider breaks that assumption twice.

First, it enforces two quotas at once — requests per minute and tokens per
minute — and a call needs room under both.

Second, the cost is not known when the call is admitted. The prompt can be
counted; the completion is generated afterwards and is the larger and more
variable half. Charging the prompt alone is not an approximation that averages
out, because the error is always in the same direction: the local counter
always believes more allowance remains than really does, and the gap widens
until the provider starts returning 429.

The obvious repair — charge nothing up front, record usage afterwards — is
worse under concurrency. Twenty calls issued together all see the full
allowance, because none of them has finished.

## Decision

`ProviderQuota` admits in two phases.

`reserve(key, estimatedTokens)` charges one request and the estimate against
both buckets in a single script, committing both or neither.
`settle(reservation, actualTokens)` applies the difference once the response is
complete. Between the two, the estimate is held, so concurrent callers see it
as spent.

`backOff(key, retryAfterMs)` exists because the local model is a guess about
someone else's counter. When the provider disagrees, it wins.

Three details that are load-bearing:

- **The refusal path commits nothing.** Two independent limiters would debit
  the request bucket and then have the token bucket refuse, spending a request
  on a call that never happened.
- **An overspend drives the token bucket negative.** Those tokens are already
  paid for upstream. Flooring at zero would discard the overspend and leave the
  local view permanently optimistic — the same drift, reintroduced.
- **A refund is capped at the capacity**, which makes settling twice harmless.

## Consequences

Callers must settle on every path a reserved call can end on, including
failures: a request that errors after the provider read the prompt still spent
those tokens. A missed settle leaks the estimate until the key expires, which
makes the limiter tighter than the quota rather than looser — the safe
direction, and the reason the estimate is held rather than the maximum.

The estimate's quality now matters. A wildly low estimate lets a burst through
that settling then pays for in debt; a wildly high one wastes allowance until
settle returns it. Neither is a correctness bug, and both are visible as the
size of the corrections.

`peek` takes an explicit zero request cost. Reading the state through the same
script as a reservation would otherwise charge a request for the answer.

This does not model quotas that count in units the client cannot see, such as
cached-prompt discounts or per-model weighting. Where that matters, `backOff`
is the mechanism that keeps the local view honest.
