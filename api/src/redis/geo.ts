import { redis } from "../config/redis.js";

// Phase 12 concept: GEO sets — store members at lat/lng, query by radius.
// One GEO key for all cars; member = auctionId; coords inferred from `location`.

const GEO_KEY = "geo:cars";

// Hardcoded city → (lat, lng). Swap for a real geocoder later.
export const CITY_COORDS: Record<string, [number, number]> = {
  Dhaka: [23.8103, 90.4125],
  Chittagong: [22.3569, 91.7832],
  Sylhet: [24.8949, 91.8687],
  Khulna: [22.8456, 89.5403],
  Rajshahi: [24.3636, 88.6241],
  Barisal: [22.701, 90.3535],
  Rangpur: [25.7439, 89.2752],
  Mymensingh: [24.7471, 90.4203],
  Comilla: [23.4607, 91.1809],
  Narayanganj: [23.6238, 90.5],
};

export function coordsFor(city: string): [number, number] | null {
  return CITY_COORDS[city] ?? null;
}

export async function addCarLocation(auctionId: string, city: string) {
  const c = coordsFor(city);
  if (!c) return;
  // GEOADD key longitude latitude member
  await redis.geoadd(GEO_KEY, c[1], c[0], auctionId);
}

export async function removeCarLocation(auctionId: string) {
  await redis.zrem(GEO_KEY, auctionId);
}

export async function nearbyCarIds(
  city: string,
  radiusKm: number,
): Promise<string[]> {
  const c = coordsFor(city);
  if (!c) return [];
  // GEOSEARCH key FROMLONLAT lng lat BYRADIUS km m ASC
  const ids = (await redis.geosearch(
    GEO_KEY,
    "FROMLONLAT",
    c[1],
    c[0],
    "BYRADIUS",
    radiusKm,
    "km",
    "ASC",
  )) as string[];
  return ids;
}
