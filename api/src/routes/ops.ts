import { Router } from "express";
import { redis } from "../config/redis.js";
import { queueDepth } from "../redis/queue.js";
import { recentHourlyStats } from "../workers/analyticsWorker.js";
import { fBidCount, fTopBidder } from "../redis/functions.js";
import { keys } from "../redis/keys.js";

// Phase 20 concept: production-grade observability commands.
//
// SLOWLOG       — every command that exceeded a latency threshold
// LATENCY       — peak latency events Redis observed internally
// MEMORY USAGE  — bytes a single key is using
// MEMORY STATS  — server-wide memory breakdown
// CLIENT LIST   — connected clients and their state
// OBJECT        — encoding / freq / idletime of a key
// SORT          — server-side sort + lookups (one of the oldest commands)

export const opsRouter = Router();

opsRouter.get("/slowlog", async (_req, res) => {
  const entries = (await redis.call("SLOWLOG", "GET", "20")) as unknown[];
  res.json({ entries });
});

opsRouter.get("/latency", async (_req, res) => {
  const latest = (await redis.call("LATENCY", "LATEST")) as unknown[];
  const history = (await redis.call("LATENCY", "HISTORY", "event-loop")) as unknown[];
  res.json({ latest, history });
});

opsRouter.get("/memory", async (req, res) => {
  const key = req.query.key as string | undefined;
  const stats = (await redis.call("MEMORY", "STATS")) as unknown[];
  const usage = key
    ? await redis.call("MEMORY", "USAGE", key, "SAMPLES", "0")
    : null;
  const info = await redis.info("memory");
  res.json({ stats, usage, info });
});

opsRouter.get("/object/:key", async (req, res) => {
  const k = req.params.key;
  const [encoding, freq, idletime, type] = await Promise.all([
    redis.call("OBJECT", "ENCODING", k).catch(() => null),
    redis.call("OBJECT", "FREQ", k).catch(() => null),
    redis.call("OBJECT", "IDLETIME", k).catch(() => null),
    redis.call("TYPE", k).catch(() => null),
  ]);
  res.json({ key: k, type, encoding, freq, idletime });
});

opsRouter.get("/clients", async (_req, res) => {
  const list = (await redis.call("CLIENT", "LIST")) as string;
  res.json({ raw: list });
});

// Phase 20: SORT — sort a list/set, optionally with BY/GET to look up other keys.
// We sort the recently-viewed list of a user by auction price and fetch titles.
opsRouter.get("/sort/recent", async (req, res) => {
  const userId = (req.headers["x-user-id"] as string) || "demo-alice";
  const sorted = (await redis.sort(
    keys.recentlyViewed(userId),
    "BY",
    "auction:*->currentPrice",
    "GET",
    "auction:*->title",
    "GET",
    "auction:*->currentPrice",
    "GET",
    "#",
    "DESC",
    "ALPHA",
  )) as string[];
  // SORT returns interleaved [title, price, id, title, price, id, ...]
  const items: { id: string; title: string; price: string }[] = [];
  for (let i = 0; i < sorted.length; i += 3) {
    items.push({ title: sorted[i], price: sorted[i + 1], id: sorted[i + 2] });
  }
  res.json({ items });
});

opsRouter.get("/queues", async (_req, res) => {
  res.json(await queueDepth());
});

opsRouter.get("/analytics", async (_req, res) => {
  res.json(await recentHourlyStats());
});

// Phase 17: read via Redis Functions instead of HGET.
opsRouter.get("/functions/:auctionId", async (req, res) => {
  const auctionKey = `auction:${req.params.auctionId}`;
  try {
    const [count, top] = await Promise.all([
      fBidCount(auctionKey),
      fTopBidder(auctionKey),
    ]);
    res.json({ bidCount: count, topBidder: top });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
