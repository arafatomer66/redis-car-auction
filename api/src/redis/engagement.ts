import { redis } from "../config/redis.js";
import { keys } from "./keys.js";

// Phase 13 concepts:
//  - LIST: LPUSH + LTRIM + LRANGE → recently-viewed feed per user
//  - STRING + INCR: atomic view counter per auction (no race conditions)
//  - EXPIREAT: absolute-time expiry (vs EXPIRE which is relative)
//  - BITMAP: SETBIT + BITCOUNT → daily active users in O(1) memory
//  - BITFIELD: packed multi-counter in a single key

const todayUtc = () => new Date().toISOString().slice(0, 10).replace(/-/g, "");

// --- Lists: recently viewed -----------------------------------------------

export async function recordView(userId: string, auctionId: string) {
  const key = keys.recentlyViewed(userId);
  // Atomic INCR for total views.
  await redis.incr(keys.viewCounter(auctionId));
  // LPUSH puts the newest at the head; LTRIM caps to most-recent 20.
  await redis.lpush(key, auctionId);
  await redis.ltrim(key, 0, 19);
  // Absolute expiry: midnight tomorrow UTC (EXPIREAT demo).
  const midnightTomorrow = Math.floor(Date.now() / 1000) + 60 * 60 * 24;
  await redis.expireat(key, midnightTomorrow);

  // Bitmap: today's DAU. Map userId → bit offset by stable hash.
  const offset = userBitOffset(userId);
  await redis.setbit(keys.dailyActive(todayUtc()), offset, 1);

  // BITFIELD: pack two 16-bit counters (sessions, totalViews) in one key.
  // OVERFLOW WRAP so we don't error on overflow — purely a demo.
  await redis.bitfield(
    keys.userBit(userId),
    "OVERFLOW",
    "WRAP",
    "INCRBY",
    "u16",
    "#0", // first u16 slot
    1,    // +1 session
    "INCRBY",
    "u16",
    "#1", // second u16 slot
    1,    // +1 view
  );
}

export async function recentlyViewed(userId: string): Promise<string[]> {
  return redis.lrange(keys.recentlyViewed(userId), 0, -1);
}

export async function viewCount(auctionId: string): Promise<number> {
  const v = await redis.get(keys.viewCounter(auctionId));
  return v ? Number(v) : 0;
}

export async function dailyActiveUserCount(): Promise<number> {
  return redis.bitcount(keys.dailyActive(todayUtc()));
}

export async function userPackedStats(userId: string): Promise<{ sessions: number; views: number }> {
  const r = (await redis.bitfield(
    keys.userBit(userId),
    "GET",
    "u16",
    "#0",
    "GET",
    "u16",
    "#1",
  )) as number[];
  return { sessions: r[0] ?? 0, views: r[1] ?? 0 };
}

// Stable mapping of a userId to a bit offset (cheap, deterministic).
function userBitOffset(userId: string): number {
  let h = 0;
  for (let i = 0; i < userId.length; i++) {
    h = (h * 31 + userId.charCodeAt(i)) >>> 0;
  }
  // Cap to a reasonable bitmap size (1 MB = 8M bits).
  return h % 8_000_000;
}
