import Redis from "ioredis";
import { env } from "./env.js";

export const redis = new Redis(env.redisUrl, {
  maxRetriesPerRequest: 3,
  lazyConnect: false,
});

redis.on("connect", () => console.log("[redis] connected"));
redis.on("error", (err) => console.error("[redis] error", err.message));

// Separate connection for Pub/Sub subscribers (ioredis requires this).
export const redisSub = redis.duplicate();
export const redisPub = redis.duplicate();
redisSub.on("error", (err) => console.error("[redis:sub] error", err.message));
redisPub.on("error", (err) => console.error("[redis:pub] error", err.message));

// Blocking workers (BLMOVE, XREADGROUP BLOCK) hold a connection for seconds at a time.
// They MUST have their own clients so the main one can keep serving requests.
export const redisBlocking = redis.duplicate();
redisBlocking.on("error", (err) =>
  console.error("[redis:blocking] error", err.message),
);
