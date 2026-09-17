-- Correct a held reservation against what the call actually cost.
--
-- KEYS[1] token bucket hash { tokens, ts }
-- ARGV: capacity, windowMs, delta
--
-- `delta` is positive when the completion came in under the estimate and the
-- difference goes back, negative when it ran over and the difference is owed.
--
-- The overspend case is the interesting one: the tokens are already spent with
-- the provider, so refusing to record them would leave the local view
-- permanently more optimistic than the provider's. The bucket is therefore
-- allowed below zero, and a caller in debt waits for it to refill back to what
-- the next call needs. That is the same arithmetic as a refusal, so nothing
-- downstream has to know about the negative state.
local capacity = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local delta = tonumber(ARGV[3])
local rate = capacity / window

local time = redis.call('TIME')
local now = (tonumber(time[1]) * 1000) + math.floor(tonumber(time[2]) / 1000)

local state = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(state[1])
local ts = tonumber(state[2])

if tokens == nil or ts == nil then
  -- Settling against a bucket that has expired: the window it belonged to is
  -- over, so there is nothing left to correct.
  return { 1, capacity, capacity, now, 0 }
end

tokens = math.min(capacity, tokens + ((now - ts) * rate))

-- A refund is capped at the capacity; a charge is not floored, on purpose.
tokens = math.min(capacity, tokens + delta)

redis.call('HSET', KEYS[1], 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', KEYS[1], window * 2)

if tokens < 0 then
  local wait = math.ceil((-tokens) / rate)
  return { 0, capacity, 0, now + wait, wait }
end

local until_full = math.ceil((capacity - tokens) / rate)
return { 1, capacity, math.floor(tokens), now + until_full, 0 }
