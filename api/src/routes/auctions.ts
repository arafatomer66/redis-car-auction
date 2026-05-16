import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { pool } from "../config/db.js";
import {
  createAuction,
  getAuction,
  getTTL,
  listAuctions,
} from "../redis/auctionRepo.js";
import { addCarLocation, nearbyCarIds, CITY_COORDS } from "../redis/geo.js";
import { indexMake, listMakes, idsForMake } from "../redis/index_make.js";
import {
  recordView,
  recentlyViewed,
  viewCount,
  dailyActiveUserCount,
  userPackedStats,
} from "../redis/engagement.js";

export const auctionsRouter = Router();

const createSchema = z.object({
  year: z.number().int().min(1900).max(2030),
  make: z.string().min(1).max(40),
  model: z.string().min(1).max(60),
  trim: z.string().max(60).optional().default(""),
  mileage: z.number().int().min(0).max(2_000_000),
  transmission: z.enum(["auto", "manual", "cvt", "dct", "other"]).default("auto"),
  fuel: z.enum(["petrol", "diesel", "hybrid", "ev", "lpg", "cng"]).default("petrol"),
  exterior: z.string().max(40).optional().default(""),
  location: z.string().max(80).optional().default(""),
  description: z.string().max(2000).optional().default(""),
  imageUrl: z.union([z.string().url(), z.literal("")]).optional().default(""),
  startPrice: z.number().positive(),
  minIncrement: z.number().positive().default(100),
  durationSec: z.number().int().min(10).max(60 * 60 * 24),
});

auctionsRouter.post("/", async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const sellerId = (req.headers["x-user-id"] as string) || "demo-alice";
  const id = randomUUID();
  const endsAt = Date.now() + parsed.data.durationSec * 1000;
  const d = parsed.data;
  const title = [d.year, d.make, d.model, d.trim].filter(Boolean).join(" ").trim();

  await pool.query(
    `INSERT INTO auctions
       (id, seller_id, title, description, image_url, start_price, min_increment, ends_at,
        year, make, model, trim, mileage, transmission, fuel, exterior, location)
     VALUES ($1,$2,$3,$4,$5,$6,$7, to_timestamp($8 / 1000.0),
             $9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [
      id,
      sellerId,
      title,
      d.description,
      d.imageUrl,
      d.startPrice,
      d.minIncrement,
      endsAt,
      d.year,
      d.make,
      d.model,
      d.trim,
      d.mileage,
      d.transmission,
      d.fuel,
      d.exterior,
      d.location,
    ],
  );

  // Phase 12: register in geo set + make secondary index.
  if (d.location) await addCarLocation(id, d.location);
  await indexMake(id, d.make);

  await createAuction({
    id,
    title,
    description: d.description,
    imageUrl: d.imageUrl,
    sellerId,
    startPrice: d.startPrice,
    currentPrice: d.startPrice,
    minIncrement: d.minIncrement,
    endsAt,
    status: "live",
    topBidderId: "",
    bidCount: 0,
    year: d.year,
    make: d.make,
    model: d.model,
    trim: d.trim,
    mileage: d.mileage,
    transmission: d.transmission,
    fuel: d.fuel,
    exterior: d.exterior,
    location: d.location,
  });

  res.status(201).json({ id, endsAt, title });
});

auctionsRouter.get("/", async (req, res) => {
  const city = (req.query.city as string) || "";
  const radius = Number(req.query.radiusKm ?? 200);
  const make = (req.query.make as string) || "";

  if (city || make) {
    // Build a filtered id list using Redis indexes.
    let idSet: Set<string> | null = null;
    if (city) {
      idSet = new Set(await nearbyCarIds(city, radius));
    }
    if (make) {
      const makeIds = new Set(await idsForMake(make));
      idSet = idSet ? new Set([...idSet].filter((i) => makeIds.has(i))) : makeIds;
    }
    const items = await listAuctions();
    res.json({
      items: items.filter((a) => idSet!.has(a.id)),
      filter: { city, radius, make },
    });
    return;
  }

  const items = await listAuctions();
  res.json({ items });
});

auctionsRouter.get("/meta/cities", (_req, res) => {
  res.json({ items: Object.keys(CITY_COORDS).sort() });
});

auctionsRouter.get("/meta/makes", async (_req, res) => {
  const items = await listMakes();
  res.json({ items });
});

auctionsRouter.get("/:id", async (req, res) => {
  const auction = await getAuction(req.params.id);
  if (!auction) return res.status(404).json({ error: "not found" });
  const ttl = await getTTL(req.params.id);
  // Phase 13: record this view (INCR + LPUSH + SETBIT + BITFIELD).
  const userId = (req.headers["x-user-id"] as string) || "anon";
  recordView(userId, req.params.id).catch(() => {});
  const views = await viewCount(req.params.id);
  res.json({ ...auction, ttl, views });
});

auctionsRouter.get("/me/recent", async (req, res) => {
  const userId = (req.headers["x-user-id"] as string) || "anon";
  const ids = await recentlyViewed(userId);
  res.json({ items: ids });
});

auctionsRouter.get("/meta/engagement", async (_req, res) => {
  const dau = await dailyActiveUserCount();
  res.json({ dailyActiveUsers: dau });
});

auctionsRouter.get("/me/stats", async (req, res) => {
  const userId = (req.headers["x-user-id"] as string) || "anon";
  const packed = await userPackedStats(userId);
  res.json(packed);
});
