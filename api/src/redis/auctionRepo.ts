import { redis } from "../config/redis.js";
import { keys } from "./keys.js";

// Phase 2 concept: HASH for auction state + STRING+TTL (expiryMarker) so that
// when the auction "expires" Redis fires a keyspace notification we can react to.

export type AuctionStatus = "live" | "closed";

export interface AuctionState {
  id: string;
  title: string;
  description: string;
  imageUrl: string;
  sellerId: string;
  startPrice: number;
  currentPrice: number;
  minIncrement: number;
  endsAt: number;          // epoch ms
  status: AuctionStatus;
  topBidderId: string;     // "" if none yet
  bidCount: number;
  // Car-specific
  year: number;
  make: string;
  model: string;
  trim: string;
  mileage: number;
  transmission: string;
  fuel: string;
  exterior: string;
  location: string;
}

const num = (v: string | undefined, fallback = 0) =>
  v === undefined ? fallback : Number(v);

function hashToState(id: string, h: Record<string, string>): AuctionState {
  return {
    id,
    title: h.title ?? "",
    description: h.description ?? "",
    imageUrl: h.imageUrl ?? "",
    sellerId: h.sellerId ?? "",
    startPrice: num(h.startPrice),
    currentPrice: num(h.currentPrice),
    minIncrement: num(h.minIncrement, 1),
    endsAt: num(h.endsAt),
    status: (h.status as AuctionStatus) ?? "live",
    topBidderId: h.topBidderId ?? "",
    bidCount: num(h.bidCount),
    year: num(h.year),
    make: h.make ?? "",
    model: h.model ?? "",
    trim: h.trim ?? "",
    mileage: num(h.mileage),
    transmission: h.transmission ?? "",
    fuel: h.fuel ?? "",
    exterior: h.exterior ?? "",
    location: h.location ?? "",
  };
}

export async function createAuction(state: AuctionState) {
  const ttlSec = Math.max(1, Math.floor((state.endsAt - Date.now()) / 1000));
  const auctionKey = keys.auction(state.id);
  const expiryKey = keys.expiryMarker(state.id);

  // Pipelining — single round-trip for multiple writes.
  // Concept: PIPELINING for batched writes.
  await redis
    .multi()
    .hset(auctionKey, {
      title: state.title,
      description: state.description,
      imageUrl: state.imageUrl,
      sellerId: state.sellerId,
      startPrice: String(state.startPrice),
      currentPrice: String(state.currentPrice),
      minIncrement: String(state.minIncrement),
      endsAt: String(state.endsAt),
      status: state.status,
      topBidderId: state.topBidderId,
      bidCount: String(state.bidCount),
      year: String(state.year),
      make: state.make,
      model: state.model,
      trim: state.trim,
      mileage: String(state.mileage),
      transmission: state.transmission,
      fuel: state.fuel,
      exterior: state.exterior,
      location: state.location,
    })
    .expire(auctionKey, ttlSec + 60) // keep state a minute past expiry for the close handler
    .set(expiryKey, state.id, "EX", ttlSec) // this is the key that fires the expired event
    .exec();
}

export async function getAuction(id: string): Promise<AuctionState | null> {
  const h = await redis.hgetall(keys.auction(id));
  if (!h || Object.keys(h).length === 0) return null;
  return hashToState(id, h);
}

// Concept: SCAN (non-blocking iteration) instead of KEYS (which blocks).
export async function listAuctionIds(): Promise<string[]> {
  const ids: string[] = [];
  let cursor = "0";
  do {
    const [next, batch] = await redis.scan(
      cursor,
      "MATCH",
      "auction:*",
      "COUNT",
      100,
    );
    cursor = next;
    for (const k of batch) ids.push(k.slice("auction:".length));
  } while (cursor !== "0");
  return ids;
}

export async function listAuctions(): Promise<AuctionState[]> {
  const ids = await listAuctionIds();
  if (ids.length === 0) return [];
  // Batched HGETALL with a pipeline — one round-trip for N reads.
  const pipe = redis.pipeline();
  ids.forEach((id) => pipe.hgetall(keys.auction(id)));
  const results = await pipe.exec();
  const out: AuctionState[] = [];
  results?.forEach((r, i) => {
    if (!r || r[0]) return;
    const h = r[1] as Record<string, string>;
    if (Object.keys(h).length > 0) out.push(hashToState(ids[i], h));
  });
  // Sort by endsAt ascending so soon-to-close auctions are first.
  out.sort((a, b) => a.endsAt - b.endsAt);
  return out;
}

export async function getTTL(id: string): Promise<number> {
  return redis.ttl(keys.expiryMarker(id));
}
