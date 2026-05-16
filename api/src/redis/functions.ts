import { redis } from "../config/redis.js";

// Phase 17 concept: Redis 7+ Functions.
//
// Functions are *named* server-side procedures grouped into libraries that
// persist across restarts (unlike scripts, which live only in script cache).
// Loaded once via FUNCTION LOAD. Called via FCALL <name>.
//
// We register a small library with two helpers used by the read-side:
//   auction.bid_count    → reads bidCount from auction hash (typed, with default)
//   auction.top_bidder   → returns topBidderId or empty string

const LIBRARY = `#!lua name=auctionlib

redis.register_function('bid_count', function(keys, args)
  local v = redis.call('HGET', keys[1], 'bidCount')
  return tonumber(v) or 0
end)

redis.register_function('top_bidder', function(keys, args)
  return redis.call('HGET', keys[1], 'topBidderId') or ''
end)
`;

let loaded = false;
export async function loadAuctionFunctions() {
  if (loaded) return;
  try {
    await redis.call("FUNCTION", "LOAD", "REPLACE", LIBRARY);
    loaded = true;
    console.log("[functions] auctionlib registered (bid_count, top_bidder)");
  } catch (err: any) {
    // Older Redis (<7.0) lacks FUNCTION. We log and carry on — phase is optional.
    console.warn("[functions] FUNCTION LOAD unsupported on this Redis:", err.message);
  }
}

export async function fBidCount(auctionKey: string): Promise<number> {
  const r = await redis.call("FCALL", "bid_count", "1", auctionKey);
  return Number(r ?? 0);
}

export async function fTopBidder(auctionKey: string): Promise<string> {
  const r = await redis.call("FCALL", "top_bidder", "1", auctionKey);
  return String(r ?? "");
}
