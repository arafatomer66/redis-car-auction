import { redis } from "../config/redis.js";
import { keys } from "./keys.js";

// Phase 7 concept: Streams are an append-only log.
// We use them for two purposes:
//   1) audit:bids — global immutable history of every bid (for replay / debugging)
//   2) notifications:<userId> — per-user feed of events they need to see

export async function addToAuditStream(payload: {
  auctionId: string;
  bidId: string;
  bidderId: string;
  amount: number;
}) {
  await redis.xadd(
    keys.auditStream(),
    "MAXLEN",
    "~",
    "10000", // capped at ~10k entries
    "*",
    "auctionId",
    payload.auctionId,
    "bidId",
    payload.bidId,
    "bidderId",
    payload.bidderId,
    "amount",
    String(payload.amount),
  );
}

export interface Notification {
  type: "outbid" | "won" | "lost";
  auctionId: string;
  title: string;
  amount: number;
}

export async function addNotification(userId: string, n: Notification) {
  await redis.xadd(
    keys.notifications(userId),
    "MAXLEN",
    "~",
    "200",
    "*",
    "type",
    n.type,
    "auctionId",
    n.auctionId,
    "title",
    n.title,
    "amount",
    String(n.amount),
  );
}

export async function readNotifications(userId: string, lastId = "0") {
  const result = (await redis.xrange(
    keys.notifications(userId),
    lastId === "0" ? "-" : `(${lastId}`,
    "+",
    "COUNT",
    50,
  )) as [string, string[]][];
  return result.map(([id, fields]) => {
    const obj: Record<string, string> = { id };
    for (let i = 0; i < fields.length; i += 2) obj[fields[i]] = fields[i + 1];
    return obj;
  });
}
