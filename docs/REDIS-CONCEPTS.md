# Redis Concepts → Code Map (complete reference)

Every Redis feature this app exercises, paired with the file where it lives. Treat this as the index when you want to study a concept.

Sections: **Beginner · Intermediate · Advanced · Production · Modules**.

---

## Beginner

### Strings + INCR/DECR
**Where:** `api/src/redis/engagement.ts:18` — `INCR views:{auctionId}` atomically counts views.
**Commands:** `SET`, `GET`, `INCR`, `DECR`, `INCRBY`, `APPEND`, `GETRANGE`, `MSET`, `MGET`.

### TTL (EXPIRE vs EXPIREAT)
**Where:** `auctionRepo.ts:65` — relative `EXPIRE` on the auction hash + expiry marker.
**Where:** `engagement.ts:25` — absolute `EXPIREAT` (epoch sec at midnight UTC tomorrow).
**Commands:** `EXPIRE`, `EXPIREAT`, `PEXPIRE`, `PEXPIREAT`, `TTL`, `PERSIST`.

### Hashes
**Where:** `auctionRepo.ts:53-72` — auction state map (title, price, endsAt, …).
**Where:** `bidRepo.ts:65-71` — per-bid detail hash.
**Commands:** `HSET`, `HGET`, `HGETALL`, `HINCRBY`, `HDEL`.

### Lists (LPUSH/LTRIM/LRANGE)
**Where:** `engagement.ts:22-24` — recently-viewed feed per user (cap 20 via `LTRIM`).
**Commands:** `LPUSH`, `RPUSH`, `LRANGE`, `LTRIM`, `LREM`, `LLEN`.

### Sets
**Where:** `presence.ts` — live watchers per auction (SADD on join, SREM on leave).
**Commands:** `SADD`, `SREM`, `SCARD`, `SMEMBERS`, `SISMEMBER`.

### SCAN (vs KEYS)
**Where:** `auctionRepo.ts:82-94` — cursor iteration, never blocks Redis.
**Commands:** `SCAN`, `HSCAN`, `SSCAN`, `ZSCAN`.

### TYPE / OBJECT
**Where:** `routes/ops.ts:33-41` — `/ops/object/:key` inspects encoding, freq, idletime.
**Commands:** `TYPE`, `OBJECT ENCODING`, `OBJECT FREQ`, `OBJECT IDLETIME`.

### Pipelining
**Where:** `auctionRepo.ts:97-105`, `bidRepo.ts:107-114` — N round-trips → 1.
**Commands:** `redis.pipeline()` → `.exec()`.

---

## Intermediate

### Sorted Sets (ZSET)
**Where:** `bidRepo.ts:62` — `ZADD amount bidId` for bid history.
**Where:** `leaderboard.ts:8` — `ZINCRBY` for "hot auctions".
**Where:** `lua/rateLimit.lua` — ZSET as a sliding-window log.
**Commands:** `ZADD`, `ZINCRBY`, `ZRANGE`, `ZREVRANGE`, `ZRANGEBYSCORE`, `ZCARD`, `ZREMRANGEBYSCORE`.

### Bitmaps (SETBIT / BITCOUNT)
**Where:** `engagement.ts:30` — `SETBIT dau:YYYYMMDD offset 1` for daily-active users.
**Where:** `engagement.ts:62` — `BITCOUNT` for the DAU count.
**Commands:** `SETBIT`, `GETBIT`, `BITCOUNT`, `BITOP AND/OR/XOR`, `BITPOS`.

### BITFIELD (packed counters)
**Where:** `engagement.ts:34-43` — two `u16` slots in one key (sessions + views).
**Commands:** `BITFIELD … GET/SET/INCRBY u16 #N`, `OVERFLOW WRAP`.

### Sets as Secondary Indexes
**Where:** `index_make.ts` — `idx:make:toyota`, intersected with geo result.
**Commands:** `SADD`, `SMEMBERS`, `SINTER`, `SINTERSTORE`, `SUNION`, `SDIFF`.

### Pub/Sub + PSUBSCRIBE
**Where:** `pubsub.ts` — publish on bid + close.
**Where:** `sockets/auctionSocket.ts:23-32` — `PSUBSCRIBE ch:bid:*` and fanout to rooms.
**Commands:** `PUBLISH`, `SUBSCRIBE`, `PSUBSCRIBE`, `PUBSUB CHANNELS`, `PUBSUB NUMSUB`.

### Socket.IO Redis Adapter
**Where:** `sockets/auctionSocket.ts:18` — multi-instance fanout.

### MULTI / EXEC / WATCH
**Where:** `bidRepo.ts:31-78` — optimistic locking (legacy path, kept for comparison via `?strategy=multi`).
**Commands:** `WATCH`, `MULTI`, `EXEC`, `DISCARD`, `UNWATCH`.

### Cache-aside + Single-flight (stampede protection)
**Where:** `cache.ts` — `cacheAside()` wraps the slow compute with a `SET NX EX` lock.
**Where:** `routes/leaderboard.ts:30-41` — `/leaderboard/auctions/:id/stats` uses it. Response header `X-Cache: hit|miss|wait` proves it.

### Rate Limiting (sliding-window in Lua)
**Where:** `lua/rateLimit.lua` + `redis/rateLimit.ts`.
**Where:** `routes/bids.ts:21-28` — 5 bids per 10s per user, returns HTTP 429.

### Geo (GEOADD / GEOSEARCH)
**Where:** `geo.ts` — `GEOADD geo:cars lng lat auctionId` + `GEOSEARCH FROMLONLAT BYRADIUS km`.
**Commands:** `GEOADD`, `GEOSEARCH`, `GEODIST`, `GEOPOS`, `GEOHASH`.

### Reliable Queue (LMOVE / BLMOVE)
**Where:** `queue.ts` — atomic `BLMOVE q:notify q:notify:processing LEFT RIGHT`.
**Where:** `workers/notifyWorker.ts` — drains the queue + `LREM` ack on success.
**Why:** if the worker crashes mid-delivery, the message is still in `:processing` and can be reaped.
**Commands:** `LMOVE`, `BLMOVE`, `LPUSH`, `RPOPLPUSH` (deprecated alias), `LREM`.

### SORT (with BY/GET)
**Where:** `routes/ops.ts:55-78` — `/ops/sort/recent` sorts the recently-viewed list by external hash field (`auction:*->currentPrice`) and fetches titles via `GET`. Classic Redis server-side join.
**Commands:** `SORT key BY pattern GET pattern DESC ALPHA`.

---

## Advanced

### Lua Scripting (EVAL / EVALSHA)
**Where:** `lua/placeBid.lua` — atomic bid validate + write + anti-snipe TTL extend.
**Where:** `lua/rateLimit.lua` — atomic sliding-window check.
**Where:** `bidLua.ts` — `SCRIPT LOAD` + `EVALSHA` with `NOSCRIPT` recovery.

### Redis Functions (Redis 7+)
**Where:** `redis/functions.ts` — `FUNCTION LOAD` a library named `auctionlib` with `bid_count` and `top_bidder` functions, called via `FCALL`.
**Where:** `routes/ops.ts:80-90` — `/ops/functions/:id`.
**Why Functions over Scripts:** named, grouped into libraries, persisted across restarts, replicated and AOF-logged.

### Streams (XADD MAXLEN, XRANGE)
**Where:** `streams.ts:13-20` — audit log capped at ~10k entries.
**Where:** `streams.ts:33-45` — per-user notification feed capped at 200.

### Stream Consumer Groups
**Where:** `workers/analyticsWorker.ts` — `XGROUP CREATE`, `XREADGROUP ... BLOCK 5000`, `XACK`.
**What it builds:** hourly bid count + sum materialized into `stats:bids:hourly` hash.
**Commands:** `XGROUP CREATE`, `XREADGROUP`, `XACK`, `XAUTOCLAIM`, `XPENDING`, `XINFO GROUPS`.

### Distributed Lock (SET NX EX + Lua release)
**Where:** `locks.ts` — acquire with `SET NX EX`, release with Lua compare-and-delete.
**Used by:** `workers/expiryWorker.ts` (only one worker closes an auction).

### Keyspace Notifications
**Where:** `docker-compose.yml` — `--notify-keyspace-events Ex`.
**Where:** `workers/expiryWorker.ts:18-26` — subscribe `__keyevent@0__:expired`, auto-close.

### HyperLogLog
**Where:** `leaderboard.ts:31-37` — `PFADD unique:bidders:{id}` + `PFCOUNT`.
**Memory:** fixed ~12 KB per key, ~0.8% error, cannot enumerate.

### Three Connections (ioredis pattern)
**Where:** `config/redis.ts` — `redis` (commands), `redisSub` (subscriber), `redisPub` (Socket.IO adapter publisher), `redisBlocking` (BLMOVE/XREADGROUP). Workers that block MUST have their own connection or they freeze the API.

---

## Production / Ops

### Persistence: AOF + RDB
**Where:** `docker-compose.yml:18-26` — `--appendonly yes` plus `--save 60 100 / 300 10` for periodic RDB snapshots. AOF for durability, RDB for fast restore + offsite backup.

### Eviction Policy + maxmemory
**Where:** `docker-compose.yml:14-17` — 256 MB cap with `allkeys-lru`. Policies: `noeviction`, `allkeys-lru`, `allkeys-lfu`, `volatile-lru`, `volatile-ttl`, `volatile-random`.

### Observability — SLOWLOG / LATENCY / MEMORY
**Where:** `docker-compose.yml:28-33` — enabled SLOWLOG (>10ms) + LATENCY monitor (100ms).
**Where:** `routes/ops.ts`:
- `/ops/slowlog` — `SLOWLOG GET 20`
- `/ops/latency` — `LATENCY LATEST` + `LATENCY HISTORY event-loop`
- `/ops/memory` — `MEMORY STATS`, `MEMORY USAGE key`, `INFO memory`
- `/ops/clients` — `CLIENT LIST`

### Replication
**Where:** `docker-compose.ha.yml` profile `replica` — `redis-server --replicaof redis 6379`.
**Verify:** `INFO replication` on both sides; writes on master read on replica.

### Sentinel (HA, failover)
**Where:** `docker-compose.ha.yml` profile `sentinel` + `ops/sentinel/sentinel.conf` — 3-node quorum monitoring `mymaster`.
**Failover demo in:** `docs/HA-AND-MODULES.md`.

### Cluster Mode (hash slots, MOVED/ASK)
**Where:** `docker-compose.cluster.yml` — 6 nodes (3 masters + 3 replicas), one-shot `redis-cli --cluster create` forms 16384 slots. **Hash tags** (`{tag}` in key) colocate keys onto one slot so multi-key commands work.

### ACL
**Where:** `ops/users.acl` — example users (`bidder`, `worker`, `admin`) with command/key allowlists. Mount with `--aclfile`.

### TLS
**Where:** notes in `docs/HA-AND-MODULES.md`. `redis-server --tls-port 6380 --tls-cert-file ... --tls-key-file ... --tls-ca-cert-file ...`; ioredis takes `tls: {…}`.

### Client-side Caching (RESP3 tracking)
**Note:** documented in `docs/HA-AND-MODULES.md`. Enable per client with `CLIENT TRACKING ON` (RESP3); ioredis supports it via `client.client('TRACKING', 'on')` if you bump protocol to RESP3.

---

## Modules (via `redis/redis-stack-server`)

Run with: `docker compose -f docker-compose.yml -f docker-compose.ha.yml --profile stack up -d redis-stack` → host port `6385`.

### RedisJSON
**Where:** demo in `docs/HA-AND-MODULES.md` and verified end-to-end in this session.
**Commands:** `JSON.SET`, `JSON.GET path`, `JSON.NUMINCRBY`, `JSON.ARRAPPEND`, `JSON.DEL`.

### RediSearch
**Where:** demo in `docs/HA-AND-MODULES.md`. `FT.CREATE cars-idx ON JSON PREFIX 1 car: SCHEMA $.make AS make TAG $.price AS price NUMERIC SORTABLE`.
**Commands:** `FT.CREATE`, `FT.SEARCH`, `FT.AGGREGATE`, `FT.DROPINDEX`.

### Bonus modules available in redis-stack
- **RedisTimeSeries** — `TS.CREATE`, `TS.ADD`, `TS.RANGE` for metrics.
- **RedisBloom** — `BF.ADD`, `BF.EXISTS` for probabilistic membership.

---

## Try it yourself — recipes

```bash
# Watch every Redis command in real time
docker exec -it redis-auction-redis redis-cli MONITOR

# Watch keyspace events fire (drives auto-close)
docker exec -it redis-auction-redis redis-cli PSUBSCRIBE '__key*__:*'

# Slow commands you've issued
curl -s http://localhost:3000/ops/slowlog

# Memory breakdown of one key
curl -s "http://localhost:3000/ops/memory?key=auction:<id>"

# Inspect any key's encoding (listpack? hashtable? skiplist?)
curl -s http://localhost:3000/ops/object/auction:<id>

# Sliding-window analytics from the consumer-group worker
curl -s http://localhost:3000/ops/analytics

# Reliable queue depth (LMOVE waiting + processing)
curl -s http://localhost:3000/ops/queues

# Functions (FCALL)
curl -s http://localhost:3000/ops/functions/<auctionId>

# SORT with BY + GET (server-side join)
curl -s -H "X-User-Id: demo-bob" http://localhost:3000/ops/sort/recent
```
