import type { Server as HttpServer } from "node:http";
import { Server as IOServer } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { redisPub, redisSub } from "../config/redis.js";
import { env } from "../config/env.js";
import { keys } from "../redis/keys.js";
import { addWatcher, countWatchers, removeWatcher } from "../redis/presence.js";
import { readNotifications } from "../redis/streams.js";

// Phase 5/6/7 wiring:
//  - Socket.IO Redis adapter so multiple API instances share rooms.
//  - On join → SADD watcher set, send room-size, subscribe to auction's pub/sub channel.
//  - On bid event from Redis pub/sub → broadcast to the room.
//  - On connect → flush any pending notifications from the user's stream.

const SUBSCRIBED = new Set<string>();

export function attachSockets(http: HttpServer) {
  const io = new IOServer(http, {
    cors: { origin: env.corsOrigin, credentials: true },
  });
  io.adapter(createAdapter(redisPub, redisSub));

  // Single subscriber connection listens for all bid/closed channels with a pattern.
  redisSub.psubscribe("ch:bid:*", "ch:closed:*").catch((err) => {
    console.error("[sockets] psubscribe failed", err);
  });

  redisSub.on("pmessage", (_pattern, channel, message) => {
    // ch:bid:<auctionId>  →  emit to room "auction:<id>" event "bid"
    if (channel.startsWith("ch:bid:")) {
      const auctionId = channel.slice("ch:bid:".length);
      io.to(`auction:${auctionId}`).emit("bid", JSON.parse(message));
    } else if (channel.startsWith("ch:closed:")) {
      const auctionId = channel.slice("ch:closed:".length);
      io.to(`auction:${auctionId}`).emit("closed", JSON.parse(message));
    }
  });

  io.on("connection", (socket) => {
    const userId = (socket.handshake.auth?.userId as string) || "demo-bob";
    socket.data.userId = userId;
    socket.data.watching = new Set<string>();

    socket.on("watch", async (auctionId: string) => {
      const room = `auction:${auctionId}`;
      await socket.join(room);
      socket.data.watching.add(auctionId);
      await addWatcher(auctionId, userId);
      const watchers = await countWatchers(auctionId);
      io.to(room).emit("presence", { auctionId, watchers });
    });

    socket.on("unwatch", async (auctionId: string) => {
      const room = `auction:${auctionId}`;
      await socket.leave(room);
      socket.data.watching.delete(auctionId);
      await removeWatcher(auctionId, userId);
      const watchers = await countWatchers(auctionId);
      io.to(room).emit("presence", { auctionId, watchers });
    });

    socket.on("notifications:pull", async (lastId: string, cb) => {
      const items = await readNotifications(userId, lastId || "0");
      cb?.({ items });
    });

    socket.on("disconnect", async () => {
      for (const auctionId of socket.data.watching as Set<string>) {
        await removeWatcher(auctionId, userId);
        const watchers = await countWatchers(auctionId);
        io.to(`auction:${auctionId}`).emit("presence", { auctionId, watchers });
      }
    });
  });

  return io;
}
