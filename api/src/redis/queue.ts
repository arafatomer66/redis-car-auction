import { redis, redisBlocking } from "../config/redis.js";
import { keys } from "./keys.js";

// Phase 16 concept: Reliable queue with LMOVE.
//
// The classic "reliable queue" pattern:
//   LPUSH onto the inbound list (producer side).
//   Worker: LMOVE inbound -> processing  (atomic move so a crash never loses work).
//   On success: LREM processing (or LPOP processing).
//   A janitor process can re-LPUSH anything that's been stuck in processing > N seconds.
//
// We use this for "outbid" notifications: even if the worker dies mid-delivery,
// the message stays in `processing` and is replayed.

const Q = keys.notifyQueue();
const P = keys.notifyProcessing();

export async function enqueueNotify(payload: Record<string, string | number>) {
  await redis.lpush(Q, JSON.stringify(payload));
}

// Worker: take one job atomically from Q → P (left of Q, right of P, blocking 5s).
export async function takeNotifyJob(): Promise<{
  payload: Record<string, unknown> | null;
  raw: string | null;
}> {
  // BLMOVE: block up to 5s if Q is empty.
  // Use the dedicated blocking client so we don't freeze the main connection.
  const raw = (await redisBlocking.blmove(Q, P, "LEFT", "RIGHT", 5)) as string | null;
  if (!raw) return { payload: null, raw: null };
  return { payload: JSON.parse(raw), raw };
}

export async function ackNotifyJob(raw: string) {
  // LREM count=1 element=raw  → removes the exact entry from processing.
  await redis.lrem(P, 1, raw);
}

export async function queueDepth() {
  const [waiting, processing] = await Promise.all([redis.llen(Q), redis.llen(P)]);
  return { waiting, processing };
}
