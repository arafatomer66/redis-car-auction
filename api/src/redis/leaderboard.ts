import { redis } from "../config/redis.js";
import { keys } from "./keys.js";

// Phase 9 concept: Sorted Set for "hot auctions" + HyperLogLog for unique bidders.

// Increment activity score for an auction.
export async function bumpHotAuction(auctionId: string, by = 1) {
  await redis.zincrby(keys.hotAuctions(), by, auctionId);
}

export async function getHotAuctions(limit = 10) {
  const entries = await redis.zrevrange(
    keys.hotAuctions(),
    0,
    limit - 1,
    "WITHSCORES",
  );
  const items: { auctionId: string; score: number }[] = [];
  for (let i = 0; i < entries.length; i += 2) {
    items.push({ auctionId: entries[i], score: Number(entries[i + 1]) });
  }
  return items;
}

// HyperLogLog — O(1) memory unique-count, ~0.8% error.
export async function addUniqueBidder(auctionId: string, bidderId: string) {
  await redis.pfadd(keys.uniqueBidders(auctionId), bidderId);
}

export async function countUniqueBidders(auctionId: string): Promise<number> {
  return redis.pfcount(keys.uniqueBidders(auctionId));
}
