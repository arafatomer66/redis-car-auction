import { redis } from "../config/redis.js";
import { keys } from "./keys.js";

// Phase 6 concept: SET membership for live presence tracking.

export async function addWatcher(auctionId: string, userId: string) {
  await redis.sadd(keys.watchers(auctionId), userId);
  // Auto-expire watcher sets so stale rooms don't linger forever.
  await redis.expire(keys.watchers(auctionId), 60 * 60 * 24);
}

export async function removeWatcher(auctionId: string, userId: string) {
  await redis.srem(keys.watchers(auctionId), userId);
}

export async function countWatchers(auctionId: string): Promise<number> {
  return redis.scard(keys.watchers(auctionId));
}
