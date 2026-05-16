import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { redis } from "../config/redis.js";
import { keys } from "./keys.js";

// Phase 14 concept: Sliding-window rate limit via Lua.
// Atomicity is critical — without Lua, two clients can both read "9 of 10"
// and both insert, ending up at 11.

const __dirname = dirname(fileURLToPath(import.meta.url));
let sha: string | null = null;

async function loadScript() {
  if (sha) return sha;
  const src = await readFile(
    join(__dirname, "..", "lua", "rateLimit.lua"),
    "utf8",
  );
  sha = (await redis.script("LOAD", src)) as string;
  return sha;
}

// Default: 5 bids per 10 seconds per user.
const WINDOW_MS = 10_000;
const LIMIT = 5;

export async function checkBidRateLimit(userId: string): Promise<{
  allowed: boolean;
  count: number;
  limit: number;
}> {
  const s = await loadScript();
  const res = (await redis.evalsha(
    s,
    1,
    keys.rateLimit(userId),
    String(Date.now()),
    String(WINDOW_MS),
    String(LIMIT),
  )) as [number, number, number];
  return { allowed: res[0] === 1, count: res[1], limit: res[2] };
}
