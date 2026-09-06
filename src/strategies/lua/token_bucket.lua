-- Token bucket.
--
-- KEYS[1] hash of { tokens, ts }, ARGV: capacity, windowMs, cost
--
-- Refills continuously rather than in steps, so a client that has been quiet
-- accumulates allowance up to the capacity and can spend it in a burst — which
-- is the behaviour an API usually wants and neither window strategy offers.
local capacity = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local rate = capacity / window -- tokens per millisecond

local time = redis.call('TIME')
local now = (tonumber(time[1]) * 1000) + math.floor(tonumber(time[2]) / 1000)

local state = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(state[1])
local ts = tonumber(state[2])

if tokens == nil or ts == nil then
  tokens = capacity
  ts = now
end

-- Clamped at the capacity: without this a bucket idle for a day would hand out
-- a day's worth of requests in one burst.
tokens = math.min(capacity, tokens + ((now - ts) * rate))

if tokens < cost then
  local needed = cost - tokens
  local wait = math.ceil(needed / rate)
  redis.call('HSET', KEYS[1], 'tokens', tokens, 'ts', now)
  redis.call('PEXPIRE', KEYS[1], window * 2)
  return { 0, capacity, math.floor(tokens), now + wait, wait }
end

tokens = tokens - cost
redis.call('HSET', KEYS[1], 'tokens', tokens, 'ts', now)
-- Twice the window: long enough that a key is never evicted while it still
-- holds a partially spent bucket, short enough that idle keys do not pile up.
redis.call('PEXPIRE', KEYS[1], window * 2)

local until_full = math.ceil((capacity - tokens) / rate)
return { 1, capacity, math.floor(tokens), now + until_full, 0 }
