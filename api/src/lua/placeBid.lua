-- placeBid.lua
-- Atomic bid placement: validate + write + return state, all in one round-trip.
-- Runs server-side so no other command can interleave between read and write.
--
-- KEYS[1] = auction hash    (auction:<id>)
-- KEYS[2] = bids zset       (bids:<id>)
-- KEYS[3] = bid hash        (bid:<bidId>)
-- KEYS[4] = expiry marker   (expire:auction:<id>)
--
-- ARGV[1] = bidId
-- ARGV[2] = bidderId
-- ARGV[3] = amount (number, as string)
-- ARGV[4] = ts (epoch ms, as string)
-- ARGV[5] = antiSnipeMs (how close to end triggers a TTL extension)
-- ARGV[6] = antiSnipeExtendSec (seconds to extend TTL if anti-snipe fires)
--
-- Returns a table:
--   { "ok", newPrice, bidCount, endsAt, prevTopBidderId, extended }
--   { "err", reason }   where reason ∈ { "not_found", "ended", "too_low" }

if redis.call("EXISTS", KEYS[1]) == 0 then
  return { "err", "not_found" }
end

local status   = redis.call("HGET", KEYS[1], "status")
local endsAt   = tonumber(redis.call("HGET", KEYS[1], "endsAt"))
local price    = tonumber(redis.call("HGET", KEYS[1], "currentPrice"))
local minInc   = tonumber(redis.call("HGET", KEYS[1], "minIncrement"))
local prevTop  = redis.call("HGET", KEYS[1], "topBidderId") or ""
local bidCount = tonumber(redis.call("HGET", KEYS[1], "bidCount")) or 0

local now      = tonumber(ARGV[4])
local amount   = tonumber(ARGV[3])
local snipeMs  = tonumber(ARGV[5])
local extendS  = tonumber(ARGV[6])

if status ~= "live" or now >= endsAt then
  return { "err", "ended" }
end

if amount < price + minInc then
  return { "err", "too_low" }
end

-- Write the bid (sorted set by amount + bid detail hash)
redis.call("ZADD", KEYS[2], amount, ARGV[1])
redis.call("HSET", KEYS[3],
  "bidderId", ARGV[2],
  "amount",   ARGV[3],
  "ts",       ARGV[4],
  "auctionId", string.sub(KEYS[1], 9)
)

-- Update auction state
bidCount = bidCount + 1
local newEndsAt = endsAt
local extended  = 0
if (endsAt - now) <= snipeMs then
  newEndsAt = endsAt + extendS * 1000
  extended  = 1
end

redis.call("HSET", KEYS[1],
  "currentPrice", ARGV[3],
  "topBidderId",  ARGV[2],
  "bidCount",     tostring(bidCount),
  "endsAt",       tostring(newEndsAt)
)

-- Extend the TTL marker so keyspace expired event fires at the new endsAt.
local newTtl = math.max(1, math.floor((newEndsAt - now) / 1000))
redis.call("SET", KEYS[4], string.sub(KEYS[1], 9), "EX", newTtl)
redis.call("EXPIRE", KEYS[1], newTtl + 60)

return { "ok", ARGV[3], tostring(bidCount), tostring(newEndsAt), prevTop, tostring(extended) }
