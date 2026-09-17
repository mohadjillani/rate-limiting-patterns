-- Reserve against two token buckets at once.
--
-- KEYS[1] request bucket hash { tokens, ts }
-- KEYS[2] token bucket hash   { tokens, ts }
-- ARGV: requestCapacity, tokenCapacity, windowMs, estimatedTokens, requestCost
--
-- A model provider enforces requests-per-minute and tokens-per-minute
-- simultaneously, and a call needs room under both. Charging them as two
-- separate limiters is wrong in a way that only shows up under load: the
-- request bucket is debited, the token bucket refuses, and the caller has paid
-- a request for a call it never made. Every refusal here leaves both buckets
-- untouched, which is the whole reason this is one script and not two.
local request_capacity = tonumber(ARGV[1])
local token_capacity = tonumber(ARGV[2])
local window = tonumber(ARGV[3])
local estimated = tonumber(ARGV[4])
-- Zero for a peek: report the state without spending a request on the answer.
local request_cost = tonumber(ARGV[5])

local request_rate = request_capacity / window
local token_rate = token_capacity / window

local time = redis.call('TIME')
local now = (tonumber(time[1]) * 1000) + math.floor(tonumber(time[2]) / 1000)

-- Refills a bucket to `now` without writing, so the two checks below both run
-- against current state before either one commits.
local function refill(key, capacity, rate)
  local state = redis.call('HMGET', key, 'tokens', 'ts')
  local tokens = tonumber(state[1])
  local ts = tonumber(state[2])
  if tokens == nil or ts == nil then
    return capacity
  end
  return math.min(capacity, tokens + ((now - ts) * rate))
end

local function commit(key, tokens)
  redis.call('HSET', key, 'tokens', tokens, 'ts', now)
  redis.call('PEXPIRE', key, window * 2)
end

local requests = refill(KEYS[1], request_capacity, request_rate)
local tokens = refill(KEYS[2], token_capacity, token_rate)

-- Whichever bucket is further from affording this call decides the wait, so a
-- caller that backs off for `retryAfterMs` finds both of them ready.
local wait = 0
if requests < request_cost then
  wait = math.ceil((request_cost - requests) / request_rate)
end
if tokens < estimated then
  local token_wait = math.ceil((estimated - tokens) / token_rate)
  if token_wait > wait then
    wait = token_wait
  end
end

if wait > 0 then
  -- Persist the refill on the refusal path too: without it a key whose PEXPIRE
  -- is close would be evicted mid-backoff and reappear at full capacity.
  commit(KEYS[1], requests)
  commit(KEYS[2], tokens)
  return { 0, token_capacity, math.max(0, math.floor(tokens)), now + wait, wait }
end

requests = requests - request_cost
tokens = tokens - estimated
commit(KEYS[1], requests)
commit(KEYS[2], tokens)

local until_full = math.ceil((token_capacity - tokens) / token_rate)
return { 1, token_capacity, math.floor(tokens), now + until_full, 0 }
