import { randomUUID } from "node:crypto";
import { redis } from "../config/redis.js";

// Phase 14 concept: Cache-aside with single-flight stampede protection.
//
// Without protection: 100 concurrent misses → 100 hits to the slow source.
// With protection:    100 concurrent misses → 1 hit, 99 wait on the result.
//
// Algorithm:
//   1) GET cache key. Hit → return.
//   2) Try SET NX on a lock key. Acquired → recompute, SET cache + TTL, DEL lock.
//   3) Didn't get lock → another caller is recomputing; poll for ~1s for the cache.

export interface CacheOptions {
  ttlSec: number;
  lockTtlSec?: number;
}

export async function cacheAside<T>(
  cacheKey: string,
  lockKey: string,
  compute: () => Promise<T>,
  opts: CacheOptions,
): Promise<{ value: T; source: "hit" | "miss" | "wait" }> {
  const lockTtl = opts.lockTtlSec ?? 5;

  const hit = await redis.get(cacheKey);
  if (hit !== null) return { value: JSON.parse(hit) as T, source: "hit" };

  const token = randomUUID();
  const got = await redis.set(lockKey, token, "EX", lockTtl, "NX");
  if (got === "OK") {
    try {
      const value = await compute();
      await redis.set(cacheKey, JSON.stringify(value), "EX", opts.ttlSec);
      return { value, source: "miss" };
    } finally {
      // Release only if we still own the lock (compare-and-delete via Lua).
      await redis.eval(
        `if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end`,
        1,
        lockKey,
        token,
      );
    }
  }

  // Lost the race; wait for the winner to populate the cache.
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 50));
    const v = await redis.get(cacheKey);
    if (v !== null) return { value: JSON.parse(v) as T, source: "wait" };
  }
  // Winner died or took too long — recompute ourselves.
  return { value: await compute(), source: "miss" };
}
