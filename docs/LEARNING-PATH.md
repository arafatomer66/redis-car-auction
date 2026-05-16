# Learning Path: Beginner → Advanced Redis

Each phase corresponds to a real feature in this repo. Read the listed file, then experiment in `redis-cli MONITOR` while triggering the feature in the UI.

## ✅ Phase 1 — Bootstrap
- `api/src/config/redis.ts`, `api/src/routes/health.ts`
- `PING`, `SELECT 1`

## ✅ Phase 2 — Hashes + TTL + SCAN + Pipelining
- `api/src/redis/auctionRepo.ts`

## ✅ Phase 3 — Sorted Sets + MULTI/EXEC/WATCH
- `api/src/redis/bidRepo.ts` (`placeBidMulti`)

## ✅ Phase 4 — Lua scripting (atomic bids)
- `api/src/lua/placeBid.lua` + `api/src/redis/bidLua.ts`

## ✅ Phase 5 — Pub/Sub + Socket.IO Redis adapter
- `api/src/redis/pubsub.ts` + `api/src/sockets/auctionSocket.ts`

## ✅ Phase 6 — Sets (live presence)
- `api/src/redis/presence.ts`

## ✅ Phase 7 — Streams (audit log + per-user notifications)
- `api/src/redis/streams.ts`

## ✅ Phase 8 — Keyspace notifications + distributed locks
- `api/src/workers/expiryWorker.ts` + `api/src/redis/locks.ts`

## ✅ Phase 9 — Leaderboards + HyperLogLog
- `api/src/redis/leaderboard.ts`

## ✅ Phase 12 — Geo + Sets-as-secondary-index
- `api/src/redis/geo.ts` — `GEOADD` / `GEOSEARCH BYRADIUS`
- `api/src/redis/index_make.ts` — per-make Sets, intersected with geo

## ✅ Phase 13 — Engagement (Lists + INCR + Bitmaps + BITFIELD + EXPIREAT)
- `api/src/redis/engagement.ts`

## ✅ Phase 14 — Cache-aside + stampede protection + rate limiting
- `api/src/redis/cache.ts` (single-flight)
- `api/src/lua/rateLimit.lua` (sliding-window in Lua)

## ✅ Phase 15 — Stream consumer groups
- `api/src/workers/analyticsWorker.ts` — `XGROUP CREATE` / `XREADGROUP` / `XACK`

## ✅ Phase 16 — Reliable queue (LMOVE / BLMOVE)
- `api/src/redis/queue.ts` + `api/src/workers/notifyWorker.ts`

## ✅ Phase 17 — Redis Functions (Redis 7+)
- `api/src/redis/functions.ts` — `FUNCTION LOAD` + `FCALL`

## ✅ Phase 18 — Production HA (replication, sentinel, cluster, ACL, TLS)
- `docker-compose.ha.yml` (profiles `replica`, `sentinel`, `stack`)
- `docker-compose.cluster.yml` (6-node cluster)
- `ops/sentinel/sentinel.conf`, `ops/users.acl`
- `docs/HA-AND-MODULES.md`

## ✅ Phase 19 — Modules (RedisJSON + RediSearch)
- `redis/redis-stack-server` via the `stack` profile on host port 6385
- `docs/HA-AND-MODULES.md` — `JSON.SET`, `FT.CREATE`, `FT.SEARCH` recipes

## ✅ Phase 20 — Observability + SORT + RDB
- `docker-compose.yml` — RDB save schedule, SLOWLOG, LATENCY monitor
- `api/src/routes/ops.ts` — `/ops/slowlog`, `/ops/latency`, `/ops/memory`, `/ops/object/:key`, `/ops/clients`, `/ops/sort/recent`, `/ops/queues`, `/ops/analytics`, `/ops/functions/:id`

---

## Complete coverage

Every meaningful Redis concept, from beginner data types to production HA topologies, now exists in this repo as runnable code or runnable docker-compose. See `docs/REDIS-CONCEPTS.md` for the full file:line map.

The only honest gap is **client-side caching** (RESP3 tracking) — ioredis supports it but the demo is left to `docs/HA-AND-MODULES.md` since it requires bumping to RESP3 globally.
