-- Sliding window log.
--
-- KEYS[1] sorted set, ARGV: limit, windowMs, cost, member seed
--
-- Every accepted request is a member scored by its timestamp. The count in the
-- trailing window is exact, which is the whole point: a fixed window lets
-- through up to 2× the limit across a boundary, and this cannot.
local limit = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local seed = ARGV[4]

local time = redis.call('TIME')
local now = (tonumber(time[1]) * 1000) + math.floor(tonumber(time[2]) / 1000)
local cutoff = now - window

redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', cutoff)
local used = redis.call('ZCARD', KEYS[1])

local function oldest_reset()
  local first = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  if first[2] == nil then return now + window end
  return math.floor(tonumber(first[2])) + window
end

if used + cost > limit then
  local reset_at = oldest_reset()
  return { 0, limit, math.max(0, limit - used), reset_at, math.max(0, reset_at - now) }
end

for i = 1, cost do
  -- The member must be unique or ZADD updates a score instead of adding a
  -- member, and the count silently stops growing.
  redis.call('ZADD', KEYS[1], now, seed .. ':' .. tostring(i))
end
-- One TTL longer than the window, so an idle key disappears instead of
-- accumulating one sorted set per client forever.
redis.call('PEXPIRE', KEYS[1], window + 1000)

return { 1, limit, math.max(0, limit - (used + cost)), oldest_reset(), 0 }
