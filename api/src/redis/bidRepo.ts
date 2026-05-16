import { randomUUID } from "node:crypto";
import { redis } from "../config/redis.js";
import { keys } from "./keys.js";

// Phase 3 concept: Sorted Set for bid history (score = amount), Hash for bid detail,
// MULTI/EXEC + WATCH for optimistic locking on auction price.
// In Phase 4 we replace this with a Lua script for true atomicity.

export interface PlaceBidResult {
  ok: boolean;
  reason?: "not_found" | "ended" | "too_low" | "conflict";
  newPrice?: number;
  bidId?: string;
  bidCount?: number;
}

export interface BidRecord {
  id: string;
  bidderId: string;
  amount: number;
  ts: number;
}

const MAX_RETRIES = 3;

export async function placeBidMulti(
  auctionId: string,
  bidderId: string,
  amount: number,
): Promise<PlaceBidResult> {
  const auctionKey = keys.auction(auctionId);
  const bidsKey = keys.bids(auctionId);

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    // WATCH the auction hash. If anyone modifies it before EXEC, the txn aborts.
    await redis.watch(auctionKey);
    const state = await redis.hgetall(auctionKey);

    if (!state || Object.keys(state).length === 0) {
      await redis.unwatch();
      return { ok: false, reason: "not_found" };
    }
    if (state.status !== "live") {
      await redis.unwatch();
      return { ok: false, reason: "ended" };
    }
    if (Number(state.endsAt) <= Date.now()) {
      await redis.unwatch();
      return { ok: false, reason: "ended" };
    }
    const minBid = Number(state.currentPrice) + Number(state.minIncrement);
    if (amount < minBid) {
      await redis.unwatch();
      return { ok: false, reason: "too_low", newPrice: Number(state.currentPrice) };
    }

    const bidId = randomUUID();
    const ts = Date.now();
    const bidCount = Number(state.bidCount) + 1;

    const exec = await redis
      .multi()
      .zadd(bidsKey, amount, bidId)
      .hset(keys.bid(bidId), {
        bidderId,
        amount: String(amount),
        ts: String(ts),
        auctionId,
      })
      .hset(auctionKey, {
        currentPrice: String(amount),
        topBidderId: bidderId,
        bidCount: String(bidCount),
      })
      .exec();

    // exec returns null when WATCH-guarded keys changed → retry.
    if (exec === null) continue;
    return { ok: true, newPrice: amount, bidId, bidCount };
  }
  return { ok: false, reason: "conflict" };
}

// Bid history newest-first.
export async function listBids(
  auctionId: string,
  limit = 20,
): Promise<BidRecord[]> {
  // ZREVRANGE WITHSCORES → top bids by amount desc.
  const entries = await redis.zrevrange(
    keys.bids(auctionId),
    0,
    limit - 1,
    "WITHSCORES",
  );

  const ids: string[] = [];
  const amounts: number[] = [];
  for (let i = 0; i < entries.length; i += 2) {
    ids.push(entries[i]);
    amounts.push(Number(entries[i + 1]));
  }
  if (ids.length === 0) return [];

  const pipe = redis.pipeline();
  ids.forEach((id) => pipe.hgetall(keys.bid(id)));
  const results = await pipe.exec();

  return ids.map((id, i) => {
    const h = (results?.[i]?.[1] as Record<string, string>) ?? {};
    return {
      id,
      bidderId: h.bidderId ?? "",
      amount: amounts[i],
      ts: Number(h.ts ?? 0),
    };
  });
}
