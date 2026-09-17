-- Adopt the provider's own refusal as local state.
--
-- KEYS[1] request bucket hash { tokens, ts }
-- ARGV: requestCapacity, windowMs, retryAfterMs
--
-- A 429 means the local model of the quota was wrong — usually because other
-- clients share it, or because the provider counts something this code does
-- not. Retrying on the local schedule after that is how a service turns one
-- 429 into a stream of them.
--
-- Only the request bucket is held. Every call costs a request whatever its
-- size, so one hold there blocks all of them, and the token bucket is left
-- alone because a refused call consumed no tokens.
--
-- Rather than store a separate "blocked until" flag, the bucket is pushed into
-- exactly enough debt to refill to *one* request at `retryAfterMs` — one, not
-- zero, because zero would mean the caller then waits a further refill period
-- for the request it was just told it could make. The hold expires by the same
-- arithmetic as everything else here.
local capacity = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local retry_after = tonumber(ARGV[3])
local rate = capacity / window

local time = redis.call('TIME')
local now = (tonumber(time[1]) * 1000) + math.floor(tonumber(time[2]) / 1000)

redis.call('HSET', KEYS[1], 'tokens', 1 - (rate * retry_after), 'ts', now)
-- The hold can outlast the window it was derived from, so the expiry has to
-- cover it as well as the usual two windows.
redis.call('PEXPIRE', KEYS[1], math.max(window * 2, retry_after + window))

return { 0, capacity, 0, now + retry_after, retry_after }
