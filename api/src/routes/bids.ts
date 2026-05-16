import { Router } from "express";
import { z } from "zod";
import { listBids, placeBidMulti } from "../redis/bidRepo.js";
import { placeBidLua } from "../redis/bidLua.js";
import { publishBid } from "../redis/pubsub.js";
import { addToAuditStream, addNotification } from "../redis/streams.js";
import { enqueueNotify } from "../redis/queue.js";
import { getAuction } from "../redis/auctionRepo.js";
import { bumpHotAuction, addUniqueBidder } from "../redis/leaderboard.js";
import { checkBidRateLimit } from "../redis/rateLimit.js";

export const bidsRouter = Router();

const bidSchema = z.object({
  amount: z.number().positive(),
});

bidsRouter.post("/auctions/:id/bids", async (req, res) => {
  const parsed = bidSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const bidderId = (req.headers["x-user-id"] as string) || "demo-bob";
  const auctionId = req.params.id;

  // Phase 14 — sliding-window rate limit (5 bids / 10s / user).
  const rl = await checkBidRateLimit(bidderId);
  if (!rl.allowed) {
    return res
      .status(429)
      .json({ ok: false, reason: "rate_limited", count: rl.count, limit: rl.limit });
  }

  // Use the Lua path by default (Phase 4) — pass ?strategy=multi to use the MULTI/WATCH path.
  const useLua = req.query.strategy !== "multi";
  const before = await getAuction(auctionId);
  const result = useLua
    ? await placeBidLua(auctionId, bidderId, parsed.data.amount)
    : await placeBidMulti(auctionId, bidderId, parsed.data.amount);

  if (!result.ok) return res.status(409).json(result);

  const after = await getAuction(auctionId);
  if (after) {
    // Phase 5 — broadcast live to watchers.
    await publishBid(auctionId, {
      bidId: result.bidId!,
      bidderId,
      amount: result.newPrice!,
      bidCount: result.bidCount!,
      endsAt: after.endsAt,
      ts: Date.now(),
    });
    // Phase 7 — audit + notify outbid user.
    await addToAuditStream({
      auctionId,
      bidId: result.bidId!,
      bidderId,
      amount: result.newPrice!,
    });
    if (before?.topBidderId && before.topBidderId !== bidderId) {
      // Phase 16 — push onto the reliable LMOVE queue;
      // notifyWorker drains it and writes to per-user streams.
      await enqueueNotify({
        userId: before.topBidderId,
        type: "outbid",
        auctionId,
        title: after.title,
        amount: result.newPrice!,
      });
    }
    // Phase 9 — leaderboards + unique bidders.
    await bumpHotAuction(auctionId);
    await addUniqueBidder(auctionId, bidderId);
  }

  res.status(201).json(result);
});

bidsRouter.get("/auctions/:id/bids", async (req, res) => {
  const limit = Math.min(50, Number(req.query.limit ?? 20));
  const items = await listBids(req.params.id, limit);
  res.json({ items });
});
