-- Fixed window.
--
-- KEYS[1] base key, ARGV: limit, windowMs, cost
--
-- The window is derived from Redis' own clock rather than the caller's. Two
-- application nodes with a few hundred milliseconds of skew would otherwise
-- disagree about which window a request belongs to, and the limit would be
-- enforced twice at the boundary — or not at all.
local limit = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])

local time = redis.call('TIME')
local now = (tonumber(time[1]) * 1000) + math.floor(tonumber(time[2]) / 1000)

local window_start = now - (now % window)
local key = KEYS[1] .. ':' .. window_start
local reset_at = window_start + window

local used = tonumber(redis.call('GET', key)) or 0

if used + cost > limit then
  return { 0, limit, math.max(0, limit - used), reset_at, reset_at - now }
end

local total = redis.call('INCRBY', key, cost)
-- Set the expiry every time rather than only on creation: a key whose PEXPIRE
-- was lost (a failover between INCR and PEXPIRE) would otherwise live forever
-- and hold the window open permanently.
redis.call('PEXPIRE', key, window)

return { 1, limit, math.max(0, limit - total), reset_at, 0 }
