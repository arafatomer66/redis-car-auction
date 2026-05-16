import { Router } from "express";
import { redis } from "../config/redis.js";
import { pool } from "../config/db.js";

export const healthRouter = Router();

healthRouter.get("/", async (_req, res) => {
  const [redisOk, dbOk] = await Promise.allSettled([
    redis.ping(),
    pool.query("SELECT 1"),
  ]);

  res.json({
    redis: redisOk.status === "fulfilled" ? "ok" : "down",
    db: dbOk.status === "fulfilled" ? "ok" : "down",
    uptime: process.uptime(),
  });
});
