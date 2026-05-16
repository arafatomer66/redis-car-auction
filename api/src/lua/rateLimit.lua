-- rateLimit.lua — Sliding-window log rate limiter.
-- Atomically appends now() to a sorted set, prunes anything older than the window,
-- and returns 1 if the request fits under the limit, 0 otherwise.
--
-- KEYS[1] = rl key (sorted set)
-- ARGV[1] = now (ms)
-- ARGV[2] = window (ms)
-- ARGV[3] = limit (max events per window)

local key    = KEYS[1]
local now    = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit  = tonumber(ARGV[3])

-- Drop everything outside the window.
redis.call("ZREMRANGEBYSCORE", key, "-inf", now - window)

local count = tonumber(redis.call("ZCARD", key))
if count >= limit then
  return { 0, count, limit }
end

redis.call("ZADD", key, now, tostring(now) .. ":" .. tostring(math.random(1, 1e9)))
redis.call("PEXPIRE", key, window)
return { 1, count + 1, limit }
