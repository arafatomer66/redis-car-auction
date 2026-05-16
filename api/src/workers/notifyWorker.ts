import { ackNotifyJob, takeNotifyJob } from "../redis/queue.js";
import { addNotification } from "../redis/streams.js";

// Phase 16: drains the reliable LMOVE queue and writes to per-user notification streams.
// In a real app this would also push email / FCM / WebSocket — we just chain to Streams.

export function startNotifyWorker() {
  loop().catch((err) => console.error("[notify] worker died", err));
  console.log("[notify] reliable LMOVE worker started");
}

async function loop() {
  while (true) {
    const { payload, raw } = await takeNotifyJob();
    if (!payload || !raw) continue;
    try {
      const { userId, type, auctionId, title, amount } = payload as any;
      await addNotification(userId, { type, auctionId, title, amount });
      await ackNotifyJob(raw);
    } catch (err) {
      console.error("[notify] delivery failed; leaving in processing", err);
      // Don't ack → janitor / startup reaper can recover.
    }
  }
}
