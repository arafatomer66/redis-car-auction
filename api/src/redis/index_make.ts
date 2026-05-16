import { redis } from "../config/redis.js";

// Phase 12 concept: Sets as a SECONDARY INDEX.
// One Set per make holds the auctionIds of cars of that make.
// SUNIONSTORE / SINTERSTORE let you combine indexes for filter queries.

const keyForMake = (make: string) => `idx:make:${make.toLowerCase()}`;
const ALL_MAKES_KEY = "idx:makes";

export async function indexMake(auctionId: string, make: string) {
  if (!make) return;
  await redis.sadd(keyForMake(make), auctionId);
  await redis.sadd(ALL_MAKES_KEY, make);
}

export async function unindexMake(auctionId: string, make: string) {
  if (!make) return;
  await redis.srem(keyForMake(make), auctionId);
}

export async function listMakes(): Promise<string[]> {
  const makes = await redis.smembers(ALL_MAKES_KEY);
  return makes.sort();
}

export async function idsForMake(make: string): Promise<string[]> {
  return redis.smembers(keyForMake(make));
}
