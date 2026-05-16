import { redisPub } from "../config/redis.js";
import { keys } from "./keys.js";

// Phase 5 concept: PUBLISH on bid → Socket.IO's redis adapter fans out to all
// connected clients across any number of API instances.

export interface BidEvent {
  bidId: string;
  bidderId: string;
  amount: number;
  bidCount: number;
  endsAt: number;
  ts: number;
}

export async function publishBid(auctionId: string, evt: BidEvent) {
  await redisPub.publish(keys.channel.bid(auctionId), JSON.stringify(evt));
}

export interface ClosedEvent {
  auctionId: string;
  winnerId: string;
  finalPrice: number;
}

export async function publishClosed(evt: ClosedEvent) {
  await redisPub.publish(
    keys.channel.closed(evt.auctionId),
    JSON.stringify(evt),
  );
}
