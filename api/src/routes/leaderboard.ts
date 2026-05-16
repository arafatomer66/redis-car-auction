import { Router } from "express";
import {
  countUniqueBidders,
  getHotAuctions,
} from "../redis/leaderboard.js";
import { getAuction } from "../redis/auctionRepo.js";
import { cacheAside } from "../redis/cache.js";
import { keys } from "../redis/keys.js";

export const leaderboardRouter = Router();

leaderboardRouter.get("/hot", async (_req, res) => {
  const entries = await getHotAuctions(10);
  const items = await Promise.all(
    entries.map(async (e) => {
      const a = await getAuction(e.auctionId);
      return a ? { ...a, hotScore: e.score } : null;
    }),
  );
  res.json({ items: items.filter(Boolean) });
});

// Phase 14 — cache-aside with stampede protection.
// The "compute" function pretends to be slow (multiple ZCARD/PFCOUNT).
// First call → miss. Concurrent calls → wait. Within 10s → hit.
leaderboardRouter.get("/auctions/:id/stats", async (req, res) => {
  const result = await cacheAside(
    keys.cacheStats(req.params.id),
    keys.cacheStatsLock(req.params.id),
    async () => {
      const unique = await countUniqueBidders(req.params.id);
      return { uniqueBidders: unique };
    },
    { ttlSec: 10, lockTtlSec: 3 },
  );
  res.set("X-Cache", result.source);
  res.json(result.value);
});
