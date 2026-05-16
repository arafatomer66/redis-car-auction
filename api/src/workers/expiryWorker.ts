import { randomUUID } from "node:crypto";
import { redisSub, redis } from "../config/redis.js";
import { pool } from "../config/db.js";
import { keys } from "../redis/keys.js";
import { getAuction } from "../redis/auctionRepo.js";
import { acquireCloseLock, releaseCloseLock } from "../redis/locks.js";
import { publishClosed } from "../redis/pubsub.js";
import { addNotification } from "../redis/streams.js";

// Phase 8 concept: Keyspace notifications + distributed lock.
//
// When `expire:auction:<id>` TTL expires, Redis fires
// `__keyevent@0__:expired` with the key name as the message.
// Any worker may receive it; the lock ensures only ONE closes the auction.

const EXPIRED_CHANNEL = "__keyevent@0__:expired";

export function startExpiryWorker() {
  redisSub.subscribe(EXPIRED_CHANNEL).catch((err) => {
    console.error("[expiry] subscribe failed", err);
  });

  redisSub.on("message", async (channel, key) => {
    if (channel !== EXPIRED_CHANNEL) return;
    if (!key.startsWith("expire:auction:")) return;
    const auctionId = key.slice("expire:auction:".length);
    await closeAuction(auctionId);
  });

  console.log("[expiry] worker armed on keyspace expired events");
}

async function closeAuction(auctionId: string) {
  const token = randomUUID();
  const got = await acquireCloseLock(auctionId, token, 10);
  if (!got) {
    console.log(`[expiry] ${auctionId} already being closed by another worker`);
    return;
  }
  try {
    const state = await getAuction(auctionId);
    if (!state || state.status !== "live") return;

    const winnerId = state.topBidderId || null;
    const finalPrice = state.currentPrice;

    // Flip status in Redis (keep the hash a bit longer so the UI can read it).
    await redis.hset(keys.auction(auctionId), {
      status: "closed",
    });
    await redis.expire(keys.auction(auctionId), 60 * 60); // keep closed state 1h

    // Persist closing to Postgres.
    await pool.query(
      `UPDATE auctions
          SET status='closed',
              winner_id=$1,
              final_price=$2,
              closed_at=now()
        WHERE id=$3`,
      [winnerId, finalPrice, auctionId],
    );

    await publishClosed({
      auctionId,
      winnerId: winnerId ?? "",
      finalPrice,
    });

    if (winnerId) {
      await addNotification(winnerId, {
        type: "won",
        auctionId,
        title: state.title,
        amount: finalPrice,
      });
    }
    console.log(
      `[expiry] closed ${auctionId} → winner=${winnerId ?? "none"} price=${finalPrice}`,
    );
  } catch (err) {
    console.error(`[expiry] close failed ${auctionId}`, err);
  } finally {
    await releaseCloseLock(auctionId, token);
  }
}
