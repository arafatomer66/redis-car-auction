import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { redis } from "../config/redis.js";
import { keys } from "./keys.js";
import type { PlaceBidResult } from "./bidRepo.js";

// Phase 4 concept: SCRIPT LOAD + EVALSHA for atomic, single-round-trip bids.

const __dirname = dirname(fileURLToPath(import.meta.url));

let sha: string | null = null;

async function loadScript(): Promise<string> {
  if (sha) return sha;
  const src = await readFile(
    join(__dirname, "..", "lua", "placeBid.lua"),
    "utf8",
  );
  sha = (await redis.script("LOAD", src)) as string;
  console.log(`[lua] placeBid loaded sha=${sha.slice(0, 8)}…`);
  return sha;
}

// Anti-snipe: if a bid lands in the last ANTI_SNIPE_MS, extend the timer.
const ANTI_SNIPE_MS = 10_000;
const ANTI_SNIPE_EXTEND_SEC = 10;

export async function placeBidLua(
  auctionId: string,
  bidderId: string,
  amount: number,
): Promise<PlaceBidResult & { extended?: boolean; endsAt?: number }> {
  const scriptSha = await loadScript();
  const bidId = randomUUID();
  const ts = Date.now();

  const auctionKey = keys.auction(auctionId);
  const bidsKey = keys.bids(auctionId);
  const bidKey = keys.bid(bidId);
  const expiryKey = keys.expiryMarker(auctionId);

  let result: unknown;
  try {
    result = await redis.evalsha(
      scriptSha,
      4,
      auctionKey,
      bidsKey,
      bidKey,
      expiryKey,
      bidId,
      bidderId,
      String(amount),
      String(ts),
      String(ANTI_SNIPE_MS),
      String(ANTI_SNIPE_EXTEND_SEC),
    );
  } catch (err: any) {
    // Script was flushed (e.g. SCRIPT FLUSH) — reload and retry once.
    if (String(err?.message ?? "").includes("NOSCRIPT")) {
      sha = null;
      const fresh = await loadScript();
      result = await redis.evalsha(
        fresh,
        4,
        auctionKey,
        bidsKey,
        bidKey,
        expiryKey,
        bidId,
        bidderId,
        String(amount),
        String(ts),
        String(ANTI_SNIPE_MS),
        String(ANTI_SNIPE_EXTEND_SEC),
      );
    } else {
      throw err;
    }
  }

  const arr = result as string[];
  if (arr[0] === "err") {
    return { ok: false, reason: arr[1] as PlaceBidResult["reason"] };
  }
  return {
    ok: true,
    bidId,
    newPrice: Number(arr[1]),
    bidCount: Number(arr[2]),
    endsAt: Number(arr[3]),
    extended: arr[5] === "1",
  };
}
