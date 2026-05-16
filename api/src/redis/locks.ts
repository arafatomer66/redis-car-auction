import { redis } from "../config/redis.js";
import { keys } from "./keys.js";

// Phase 8 concept: Distributed lock via SET key value NX EX <ttl>.
// Value is a unique token so only the owner can release (atomic compare-and-delete via Lua).

const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
`;

export async function acquireCloseLock(
  auctionId: string,
  token: string,
  ttlSec = 10,
): Promise<boolean> {
  const ok = await redis.set(
    keys.closeLock(auctionId),
    token,
    "EX",
    ttlSec,
    "NX",
  );
  return ok === "OK";
}

export async function releaseCloseLock(auctionId: string, token: string) {
  await redis.eval(RELEASE_SCRIPT, 1, keys.closeLock(auctionId), token);
}
