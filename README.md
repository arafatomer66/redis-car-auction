# 🚗 Redis Car Auction — Learn Every Redis Concept by Building a Real App

[![Redis 7](https://img.shields.io/badge/Redis-7-DC382D?logo=redis&logoColor=white)](https://redis.io)
[![Node 20](https://img.shields.io/badge/Node-20-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![Angular 20](https://img.shields.io/badge/Angular-20-DD0031?logo=angular&logoColor=white)](https://angular.dev)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A real-time car-bidding web app that exists for one reason: **to teach every meaningful Redis concept, from beginner to advanced, by using it in the critical path of a real product.** Not toy snippets — actual production-shaped code you can read, run, and break.

**If you spend a weekend with this repo, you'll walk away knowing Redis.**

---

## 📑 Table of Contents

- [Quick start](#-quick-start)
- [Why this exists](#-why-this-exists)
- [Architecture](#-architecture)
- [The full concept tour](#-the-full-concept-tour) ← *the meat*
  - [Beginner](#beginner)
  - [Intermediate](#intermediate)
  - [Advanced](#advanced)
  - [Production / Ops](#production--ops)
  - [Modules](#modules-redisjson--redisearch)
- [Production topologies (replication, sentinel, cluster)](#-production-topologies)
- [API endpoint reference](#-api-endpoint-reference)
- [How to break it (chaos checklist)](#-how-to-break-it-chaos-checklist)
- [Project layout](#-project-layout)
- [Stretch ideas](#-stretch-ideas)

---

## 🚀 Quick start

**Prereqs:** Docker Desktop, Node 20+, npm.

```bash
git clone https://github.com/arafatomer66/redis-car-auction.git
cd redis-car-auction

# 1. Boot Redis + Postgres (alt ports 6383 / 5436 to avoid conflicts with local installs)
docker compose up -d

# 2. API
cd api
cp .env.example .env
npm install
npm run migrate
npm run dev               # http://localhost:3000

# 3. Web
cd ../web
npm install
npm start                 # http://localhost:4200
```

Open <http://localhost:4200>. Switch users (Alice/Bob/Carol) from the top-right dropdown. Open the same auction in two tabs and watch live bids fly.

**Health check:**
```bash
curl http://localhost:3000/health
# { "redis": "ok", "db": "ok", "uptime": 1.23 }
```

---

## 🎯 Why this exists

Most Redis tutorials show you `SET foo bar`. That's not learning Redis — that's learning what Redis *is*. **Learning Redis means knowing when to reach for a Sorted Set vs a Stream, when Lua beats `MULTI`, why your distributed lock will deadlock without a token, how a single bad `KEYS` call brings down production.**

This repo teaches you those things by building an actual app where every Redis feature serves a real purpose:
- A leaderboard ⇒ Sorted Set
- "23 people watching" ⇒ Sets
- Atomic bid validation ⇒ Lua script
- Anti-snipe timer extension ⇒ TTL manipulation in Lua
- Auto-close when timer hits zero ⇒ Keyspace notifications + distributed lock
- Live updates to all watchers ⇒ Pub/Sub + Socket.IO Redis adapter
- "Outbid" notifications surviving a worker crash ⇒ Reliable queue with `LMOVE`
- Hourly analytics ⇒ Stream consumer groups
- "Cars near Dhaka within 200 km" ⇒ Geo
- Rate-limited bidding ⇒ Lua sliding window
- Hot-key caching that survives stampedes ⇒ Cache-aside + single-flight

Every concept has the answer to **"where would I actually use this?"** baked in.

---

## 🏗️ Architecture

```
        ┌─────────────────┐
        │  Angular SPA    │  Socket.IO for live updates
        │  (signals)      │  HTTP for REST
        └────────┬────────┘
                 │
        ┌────────▼────────┐
        │  Express + TS   │  ──► Redis (live state, locks, queues, streams, pub/sub, geo, ...)
        │                 │  ──► Postgres (cold storage / audit / history)
        └─┬──┬──┬─────────┘
          │  │  │
          │  │  └─► Expiry Worker     (keyspace notification → close auction)
          │  └────► Analytics Worker  (XREADGROUP on audit:bids → hourly stats)
          └───────► Notify Worker     (BLMOVE on q:notify → per-user XADD)
```

**Why both Redis and Postgres?**
- **Redis** holds anything that needs to be hot and reactive: live bid price, watcher count, leaderboards, ephemeral state, locks, queues, real-time fanout.
- **Postgres** is the permanent record: who created the auction, who won, audit history. The kind of thing the auditor would ask for in 3 years.

Detailed sequence diagrams (bid flow, auto-close, presence) live in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

# 📘 The Full Concept Tour

Each concept has: **what it is · why we use it here · CLI example · code reference**.

---

## Beginner

### 1. Strings + INCR/DECR

**What:** The fundamental key-value pair. `INCR` atomically increments — no race conditions, even with 1000 concurrent callers.

**Why here:** Counting how many times each car was viewed.

```bash
redis-cli SET hello world
redis-cli GET hello
redis-cli INCR views:car-42      # 1
redis-cli INCR views:car-42      # 2 — atomic, never returns the same number twice
```

**Code:** [`api/src/redis/engagement.ts`](api/src/redis/engagement.ts) — `recordView()` calls `INCR views:{auctionId}` every time someone opens an auction page.

---

### 2. TTL — EXPIRE vs EXPIREAT

**What:** Auto-delete a key after N seconds (`EXPIRE`) or at a specific epoch timestamp (`EXPIREAT`). The single most important thing Redis does that your SQL database doesn't.

**Why here:**
- Auctions expire → `EXPIRE auction:{id} 600`
- The recently-viewed list resets at midnight → `EXPIREAT` to tomorrow's epoch

```bash
redis-cli SET cache:hot "data" EX 10        # vanishes in 10s
redis-cli TTL cache:hot                      # 9
redis-cli EXPIREAT mykey 1893456000          # absolute (epoch sec)
redis-cli PERSIST mykey                      # cancel the expiry
```

**Code:** [`auctionRepo.ts`](api/src/redis/auctionRepo.ts) (`EXPIRE`), [`engagement.ts`](api/src/redis/engagement.ts) (`EXPIREAT`).

---

### 3. Hashes

**What:** A key holding a flat map of field→value. Atomic per-field updates, no JSON parsing.

**Why here:** Auction state — title, current price, timer, status — lives as fields in one hash.

```bash
redis-cli HSET auction:1 title "Tesla" price 42000 status live
redis-cli HGET auction:1 price                 # 42000
redis-cli HINCRBY auction:1 bidCount 1         # atomic +1
redis-cli HGETALL auction:1
```

**Code:** [`auctionRepo.ts`](api/src/redis/auctionRepo.ts).

---

### 4. Lists — LPUSH / LTRIM / LRANGE

**What:** Linked list. Cheap append at head/tail, range reads, atomic trim. The Redis substrate for queues and feeds.

**Why here:** "Recently viewed cars" per user — newest at head, capped at 20.

```bash
redis-cli LPUSH recent:bob car-7 car-3 car-9   # newest first
redis-cli LTRIM recent:bob 0 19                # cap to 20
redis-cli LRANGE recent:bob 0 -1               # all
```

**Code:** [`engagement.ts`](api/src/redis/engagement.ts).

---

### 5. Sets

**What:** Unordered unique members. O(1) add/remove/membership-test/size.

**Why here:** Who is currently watching this auction. SADD on socket connect, SREM on disconnect, SCARD for the "23 watching" badge.

```bash
redis-cli SADD watchers:auction-1 alice bob carol
redis-cli SCARD watchers:auction-1            # 3
redis-cli SISMEMBER watchers:auction-1 bob    # 1
redis-cli SREM watchers:auction-1 bob
```

**Code:** [`presence.ts`](api/src/redis/presence.ts).

---

### 6. SCAN (never use KEYS in production)

**What:** Cursor-based iteration over the keyspace. Non-blocking, safe on giant datasets. `KEYS pattern` is O(n) and blocks Redis for the entire scan — it has taken down production at major companies.

```bash
redis-cli SCAN 0 MATCH "auction:*" COUNT 100
# returns: [next-cursor, [key1, key2, ...]]
# keep calling with the new cursor until it returns 0
```

**Code:** [`auctionRepo.ts`](api/src/redis/auctionRepo.ts) `listAuctionIds()` — proper cursor loop.

---

### 7. TYPE / OBJECT — knowing what's in your key

```bash
redis-cli TYPE auction:1                       # hash
redis-cli OBJECT ENCODING auction:1            # listpack (small) or hashtable (large)
redis-cli OBJECT FREQ auction:1                # access frequency (LFU)
redis-cli OBJECT IDLETIME auction:1            # seconds since last access
```

**Code:** [`routes/ops.ts`](api/src/routes/ops.ts) `/ops/object/:key`.

---

### 8. Pipelining

**What:** Batch N commands into 1 network round-trip. Cuts latency by 10–100×.

```js
const pipe = redis.pipeline();
ids.forEach((id) => pipe.hgetall(`auction:${id}`));
const results = await pipe.exec();   // single round-trip
```

**Code:** [`auctionRepo.ts`](api/src/redis/auctionRepo.ts) `listAuctions()`, [`bidRepo.ts`](api/src/redis/bidRepo.ts).

---

## Intermediate

### 9. Sorted Sets (ZSET)

**What:** Set where each member has a numeric score. Ranged queries in O(log n). The Swiss-army knife of Redis.

**Why here:** Bid history per auction (score = bid amount), "hottest auctions" leaderboard, sliding-window rate limiter.

```bash
redis-cli ZADD bids:auction-1 18000 bid-a 19000 bid-b 17000 bid-c
redis-cli ZREVRANGE bids:auction-1 0 -1 WITHSCORES   # high → low
redis-cli ZINCRBY hot:auctions 1 auction-1           # bump activity
redis-cli ZRANGEBYSCORE bids:auction-1 18000 +inf    # ≥ 18000
```

**Code:** [`bidRepo.ts`](api/src/redis/bidRepo.ts), [`leaderboard.ts`](api/src/redis/leaderboard.ts).

---

### 10. Bitmaps — SETBIT / BITCOUNT

**What:** Treat a string as a bit array. Set the N-th bit. Count set bits. ~1 MB stores 8 million flags.

**Why here:** Daily Active Users — `SETBIT dau:20260516 userBit 1` for every active user. `BITCOUNT` gives you DAU in microseconds with constant memory.

```bash
redis-cli SETBIT dau:20260516 100 1
redis-cli SETBIT dau:20260516 250 1
redis-cli SETBIT dau:20260516 100 1
redis-cli BITCOUNT dau:20260516              # 2 (deduped automatically)
redis-cli BITOP AND active:both dau:today dau:yesterday   # set intersection on bits
```

**Code:** [`engagement.ts`](api/src/redis/engagement.ts).

---

### 11. BITFIELD — packed counters

**What:** Multiple typed counters in one key with `OVERFLOW` semantics. Storage-efficient when you have lots of small per-user counters.

```bash
# Two unsigned 16-bit counters in one key
redis-cli BITFIELD user:bob INCRBY u16 \#0 1 INCRBY u16 \#1 5
redis-cli BITFIELD user:bob GET u16 \#0 GET u16 \#1
```

**Code:** [`engagement.ts`](api/src/redis/engagement.ts) `userPackedStats()`.

---

### 12. Sets as secondary indexes

**What:** When your store has no query engine, build your own indexes. One Set per indexed value. Combine with `SINTER`/`SUNION` for boolean queries.

**Why here:** Filter cars by make. `idx:make:toyota` holds all Toyota auction IDs. Intersect with the Geo result for "Toyotas near Dhaka."

```bash
redis-cli SADD idx:make:toyota auction-1 auction-7
redis-cli SADD idx:make:honda  auction-2 auction-9
redis-cli SADD idx:makes Toyota Honda                # for dropdown
redis-cli SMEMBERS idx:make:toyota
redis-cli SINTERSTORE result idx:make:toyota geo:result   # AND of two filters
```

**Code:** [`index_make.ts`](api/src/redis/index_make.ts).

---

### 13. Pub/Sub + PSUBSCRIBE

**What:** Fire-and-forget messaging. Publishers don't know about subscribers; messages aren't stored. Use for *live ephemeral* fanout.

**Why here:** Server publishes `ch:bid:{auctionId}` on every bid; Socket.IO's Redis adapter fans it out to every connected browser tab via WebSocket.

```bash
# Terminal A
redis-cli PSUBSCRIBE 'ch:bid:*'
# Terminal B
redis-cli PUBLISH ch:bid:auction-1 '{"amount":19000,"bidder":"bob"}'
```

**Code:** [`pubsub.ts`](api/src/redis/pubsub.ts), [`sockets/auctionSocket.ts`](api/src/sockets/auctionSocket.ts).

---

### 14. Socket.IO Redis adapter

**What:** Lets Socket.IO scale across N Node processes by using Redis Pub/Sub to broadcast `io.to(room).emit(...)` calls. Without it, browser A connected to API instance 1 never hears emits from instance 2.

```ts
import { createAdapter } from "@socket.io/redis-adapter";
io.adapter(createAdapter(redisPub, redisSub));
```

**Code:** [`sockets/auctionSocket.ts`](api/src/sockets/auctionSocket.ts).

---

### 15. MULTI / EXEC / WATCH — optimistic locking

**What:** Group commands into a transaction. `WATCH key` — if anyone modifies that key before `EXEC`, the transaction returns `null` and you retry.

**Why here:** Original "place bid" implementation, kept for comparison vs the Lua version. Try it with `POST /auctions/:id/bids?strategy=multi`.

```bash
redis-cli WATCH auction:1
redis-cli MULTI
redis-cli HINCRBY auction:1 price 100
redis-cli HINCRBY auction:1 bidCount 1
redis-cli EXEC          # returns nil if anyone else touched auction:1
```

**Code:** [`bidRepo.ts`](api/src/redis/bidRepo.ts) `placeBidMulti()`.

---

### 16. Cache-aside + Single-flight (stampede protection)

**What:** The classic cache pattern. **Without single-flight**, 1000 concurrent cache misses → 1000 hits to your slow source. **With it**, exactly 1 caller recomputes, 999 wait on the result.

**Why here:** "Stats for this auction" endpoint. Cached for 10s. First call → miss, computes, writes cache. Concurrent calls → wait. Within 10s → hit.

Response header `X-Cache: hit | miss | wait` proves which path you took.

```bash
curl -i http://localhost:3000/leaderboard/auctions/<id>/stats
# X-Cache: miss   ← computed
curl -i http://localhost:3000/leaderboard/auctions/<id>/stats
# X-Cache: hit    ← from cache
```

**Code:** [`cache.ts`](api/src/redis/cache.ts), used by [`routes/leaderboard.ts`](api/src/routes/leaderboard.ts).

---

### 17. Rate limiting (Lua sliding-window)

**What:** Atomic sliding-window log via a single Lua script. Adds `now()` to a sorted set, trims anything older than the window, and rejects if over the limit.

**Why here:** 5 bids per 10 seconds per user. Tried bid #6? `HTTP 429`.

```bash
for i in 1 2 3 4 5 6 7; do
  curl -s -X POST http://localhost:3000/auctions/<id>/bids \
    -H "X-User-Id: demo-bob" -H "Content-Type: application/json" \
    -d "{\"amount\": $((20000 + i*100))}"
done
# first 5 succeed, last 2 → {"ok":false,"reason":"rate_limited"}
```

**Code:** [`lua/rateLimit.lua`](api/src/lua/rateLimit.lua), [`redis/rateLimit.ts`](api/src/redis/rateLimit.ts).

---

### 18. Geo — GEOADD / GEOSEARCH

**What:** Sorted set under the hood; members are placed at lat/lng. Query by radius in O(log n).

**Why here:** Filter cars within X km of a city.

```bash
redis-cli GEOADD geo:cars 90.4125 23.8103 auction-1   # Dhaka
redis-cli GEOADD geo:cars 91.7832 22.3569 auction-2   # Chittagong
redis-cli GEOSEARCH geo:cars FROMLONLAT 90.4125 23.8103 BYRADIUS 300 km ASC
redis-cli GEODIST geo:cars auction-1 auction-2 km
```

**Code:** [`geo.ts`](api/src/redis/geo.ts).

---

### 19. Reliable queue — LMOVE / BLMOVE

**What:** Atomic "take one job from inbound → processing list" pattern. If your worker crashes mid-delivery, the job stays in `:processing` and a janitor reaper can replay it. **The standard reliable-queue pattern.**

**Why here:** Outbid notifications. If the notify worker dies mid-send, the message is recoverable.

```bash
redis-cli LPUSH q:notify '{"type":"outbid","user":"bob"}'
redis-cli BLMOVE q:notify q:notify:processing LEFT RIGHT 5   # atomically grab one
# ... do the work ...
redis-cli LREM q:notify:processing 1 '<original json>'        # ack on success
```

**Code:** [`queue.ts`](api/src/redis/queue.ts), [`workers/notifyWorker.ts`](api/src/workers/notifyWorker.ts).

---

### 20. SORT — with BY/GET (server-side join)

**What:** Sort a list/set, optionally fetch fields from *other* keys via `BY` and `GET`. One of Redis's oldest and most underused commands.

**Why here:** Sort the recently-viewed list by each car's current price, fetch titles in the same call.

```bash
redis-cli SORT recent:bob \
  BY "auction:*->currentPrice" \
  GET "auction:*->title" \
  GET "auction:*->currentPrice" \
  GET "#" \
  DESC ALPHA
```

**Code:** [`routes/ops.ts`](api/src/routes/ops.ts) `/ops/sort/recent`.

---

## Advanced

### 21. Lua scripting — EVAL / EVALSHA

**What:** Run a Lua script atomically on the Redis server. The whole script executes as one command — no interleaving possible. The right tool when `MULTI` isn't enough (you need conditional logic + writes based on reads).

**Why here:** `placeBid.lua` validates the bid, writes it, updates auction state, and extends the timer if anti-snipe fires — all atomically, in one round-trip.

```bash
# Load once, get a SHA
SHA=$(redis-cli SCRIPT LOAD "return redis.call('GET', KEYS[1])")
redis-cli EVALSHA $SHA 1 mykey
```

**Code:** [`lua/placeBid.lua`](api/src/lua/placeBid.lua), [`bidLua.ts`](api/src/redis/bidLua.ts) (handles `NOSCRIPT` cache flushes).

---

### 22. Redis Functions (Redis 7+)

**What:** A library of *named* server-side functions. Persists across restarts (scripts don't). Replicated. AOF-logged. The modern replacement for `SCRIPT LOAD`.

**Why here:** Two named accessors (`bid_count`, `top_bidder`) loaded once at boot, callable via `FCALL` from any client.

```bash
redis-cli FUNCTION LOAD "$(cat library.lua)"
redis-cli FCALL bid_count 1 auction:abc
redis-cli FCALL top_bidder 1 auction:abc
redis-cli FUNCTION LIST
```

**Code:** [`redis/functions.ts`](api/src/redis/functions.ts), exposed at `/ops/functions/:id`.

---

### 23. Streams — XADD / XRANGE

**What:** Append-only log with millisecond IDs. Capped by `MAXLEN ~ N` (the `~` means "approximate, fast"). Think Kafka, but inside Redis.

**Why here:** Audit log of every bid + per-user notification feed.

```bash
redis-cli XADD audit:bids MAXLEN \~ 10000 '*' user bob amount 19000
redis-cli XLEN audit:bids
redis-cli XRANGE audit:bids - + COUNT 5
```

**Code:** [`streams.ts`](api/src/redis/streams.ts).

---

### 24. Stream Consumer Groups

**What:** Multiple workers cooperatively consume a stream. Each message goes to exactly one worker. Unacked messages can be reclaimed if a worker dies. **This is the real "Redis as Kafka" pattern.**

**Why here:** `analyticsWorker` reads `audit:bids` via `XREADGROUP`, materializes hourly bid count + sum into a hash, then `XACK`s.

```bash
redis-cli XGROUP CREATE audit:bids analytics 0 MKSTREAM
redis-cli XREADGROUP GROUP analytics worker-1 COUNT 10 BLOCK 5000 STREAMS audit:bids '>'
redis-cli XACK audit:bids analytics 1700000000000-0
redis-cli XPENDING audit:bids analytics             # what's still in-flight
redis-cli XAUTOCLAIM audit:bids analytics worker-1 60000 0   # reclaim from dead workers
```

**Code:** [`workers/analyticsWorker.ts`](api/src/workers/analyticsWorker.ts).

---

### 25. Distributed locks (SET NX EX + Lua release)

**What:** Cross-process mutex. `SET key token NX EX ttl` only succeeds if the key didn't exist. Release with a Lua compare-and-delete so only the owner can release.

**Why here:** Only one worker should close any given auction, even when many workers receive the keyspace expired event.

```bash
TOKEN=$(uuidgen)
redis-cli SET lock:close:auction-1 $TOKEN EX 10 NX        # → OK or nil
# ... critical section ...
redis-cli EVAL "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end" 1 lock:close:auction-1 $TOKEN
```

**Code:** [`locks.ts`](api/src/redis/locks.ts).

⚠️ **For multi-master Redis, you need the Redlock algorithm** — this implementation is correct for single-master.

---

### 26. Keyspace notifications

**What:** Redis can publish events when keys are touched (`SET`, `DEL`, `EXPIRED`, …). Must be enabled with `notify-keyspace-events Ex` (E = events, x = expired).

**Why here:** Auctions auto-close when their TTL runs out. The expiry worker subscribes to `__keyevent@0__:expired` and triggers the close logic.

```bash
redis-cli CONFIG SET notify-keyspace-events Ex
redis-cli PSUBSCRIBE '__key*__:*'
# in another shell:
redis-cli SET willdie "x" EX 5   # 5s later you'll see the expired event
```

**Code:** [`workers/expiryWorker.ts`](api/src/workers/expiryWorker.ts).

---

### 27. HyperLogLog

**What:** Probabilistic structure for unique-count. Fixed ~12 KB memory, ~0.8% error, **cannot enumerate members**. Brilliant for "unique visitors today" on a billion-event firehose.

**Why here:** Count unique bidders per auction without storing the set of bidders.

```bash
redis-cli PFADD unique:bidders:auction-1 bob alice carol bob bob
redis-cli PFCOUNT unique:bidders:auction-1            # 3 (bob deduped)
redis-cli PFMERGE total:bidders unique:auction-1 unique:auction-2
```

**Code:** [`leaderboard.ts`](api/src/redis/leaderboard.ts).

---

### 28. Three connections — the ioredis pattern

**What:** A Redis client in `SUBSCRIBE` mode can't run other commands. A client blocking on `BLMOVE` or `XREADGROUP BLOCK` holds the connection for seconds. **You need separate connections** or your app freezes.

```ts
export const redis         = new Redis(url);   // normal commands
export const redisSub      = redis.duplicate(); // SUBSCRIBE / keyspace events
export const redisPub      = redis.duplicate(); // Socket.IO adapter publisher
export const redisBlocking = redis.duplicate(); // BLMOVE / XREADGROUP BLOCK
```

**Code:** [`config/redis.ts`](api/src/config/redis.ts).

---

## Production / Ops

### 29. Persistence — AOF + RDB

**AOF** (Append-Only File): every write logged for durability.
**RDB** (Redis DB snapshots): periodic point-in-time snapshots, great for backups and fast restart.

Run both. AOF gives you "lose at most 1 second"; RDB gives you fast cold start.

```bash
redis-server --appendonly yes --save "60 100" --save "300 10"
# "60 100" = snapshot if ≥100 writes in 60s
# "300 10" = snapshot if ≥10 writes in 5min
redis-cli LASTSAVE          # epoch of last successful RDB
redis-cli BGSAVE            # trigger snapshot
redis-cli BGREWRITEAOF      # compact the AOF
```

**Config:** [`docker-compose.yml`](docker-compose.yml).

---

### 30. Eviction policy + maxmemory

When `maxmemory` is hit, Redis evicts per the policy. Pick wrong and your cache becomes a slow database.

| Policy | Behavior |
|---|---|
| `noeviction` | Refuse writes (default; **dangerous** for caches) |
| `allkeys-lru` | Evict least-recently-used from any keyspace |
| `allkeys-lfu` | Evict least-frequently-used |
| `volatile-lru` | LRU but only on keys with TTL |
| `volatile-ttl` | Evict closest-to-expiry first |

```bash
redis-cli CONFIG SET maxmemory 256mb
redis-cli CONFIG SET maxmemory-policy allkeys-lru
```

**Config:** [`docker-compose.yml`](docker-compose.yml).

---

### 31. Observability — SLOWLOG / LATENCY / MEMORY / CLIENT

```bash
# Commands that took > slowlog-log-slower-than microseconds
redis-cli SLOWLOG GET 10

# Internal latency events Redis observed
redis-cli LATENCY LATEST
redis-cli LATENCY HISTORY event-loop

# Memory accounting
redis-cli MEMORY STATS
redis-cli MEMORY USAGE auction:abc SAMPLES 0
redis-cli INFO memory

# Who's connected
redis-cli CLIENT LIST
redis-cli CLIENT KILL ID 42
```

All available as HTTP endpoints in [`routes/ops.ts`](api/src/routes/ops.ts):
```bash
curl http://localhost:3000/ops/slowlog
curl http://localhost:3000/ops/latency
curl "http://localhost:3000/ops/memory?key=auction:abc"
curl http://localhost:3000/ops/object/auction:abc
curl http://localhost:3000/ops/clients
```

---

### 32. Replication (master / replica)

```bash
docker compose -f docker-compose.yml -f docker-compose.ha.yml --profile replica up -d

docker exec redis-auction-redis    redis-cli INFO replication | grep ^role
# role:master  connected_slaves:1

docker exec redis-auction-redis    redis-cli SET demo hello
docker exec redis-auction-replica  redis-cli GET demo       # → "hello"
```

**Config:** [`docker-compose.ha.yml`](docker-compose.ha.yml) profile `replica`.

---

### 33. Sentinel (HA + automatic failover)

```bash
docker compose -f docker-compose.yml -f docker-compose.ha.yml --profile sentinel up -d
docker exec redis-auction-sentinel-1 redis-cli -p 26379 sentinel masters

# Failover demo
docker pause redis-auction-redis
# Watch sentinels declare master down, elect new master from the replica
docker logs -f redis-auction-sentinel-1
docker unpause redis-auction-redis     # the old master comes back as replica
```

**Config:** [`docker-compose.ha.yml`](docker-compose.ha.yml) + [`ops/sentinel/sentinel.conf`](ops/sentinel/sentinel.conf).

---

### 34. Cluster mode (hash slots, MOVED/ASK)

```bash
docker compose -f docker-compose.cluster.yml up -d

# Form the cluster (one time)
docker exec -it cl-node-1 redis-cli --cluster create \
  cl-node-1:6379 cl-node-2:6379 cl-node-3:6379 \
  cl-node-4:6379 cl-node-5:6379 cl-node-6:6379 \
  --cluster-replicas 1 --cluster-yes

docker exec -it cl-node-1 redis-cli CLUSTER NODES
docker exec -it cl-node-1 redis-cli CLUSTER SLOTS

# Connect in cluster mode (-c follows MOVED redirects automatically)
docker exec -it cl-node-1 redis-cli -c -p 6379
> SET {user:123}:profile "..."     # the {user:123} hash tag pins to one slot
> SET {user:123}:cart "..."         # same slot → multi-key ops work
```

**Hash tags** (`{tag}` in the key) force keys to land in the same slot so multi-key commands (`MGET`, `MULTI`, Lua with multiple keys) work.

**Config:** [`docker-compose.cluster.yml`](docker-compose.cluster.yml).

---

### 35. ACL

```
user bidder on >password ~auction:* ~bids:* +get +hgetall +zadd +publish
user worker on >password ~* +@all -@dangerous
user admin  on >password ~* &* +@all
```

```bash
redis-cli -a password --user bidder
> FLUSHDB
(error) NOPERM this user has no permissions to access this command
```

**Config:** [`ops/users.acl`](ops/users.acl).

---

### 36. TLS

```bash
redis-server \
  --tls-port 6380 --port 0 \
  --tls-cert-file ./cert.pem \
  --tls-key-file ./key.pem \
  --tls-ca-cert-file ./ca.pem
```

ioredis side: `new Redis({ tls: { ca: fs.readFileSync('ca.pem') } })`. Full walkthrough in [`docs/HA-AND-MODULES.md`](docs/HA-AND-MODULES.md).

---

## Modules (RedisJSON + RediSearch)

The base image is `redis:7-alpine` (no modules). To play with modules, run the `redis-stack` profile (binds to host port `6385`):

```bash
docker compose -f docker-compose.yml -f docker-compose.ha.yml --profile stack up -d redis-stack
docker exec -it redis-auction-stack redis-cli -p 6379
```

### 37. RedisJSON

```bash
> JSON.SET car:1 $ '{"year":2022,"make":"Toyota","model":"Corolla","price":18000}'
> JSON.GET car:1 $.make                # ["Toyota"]
> JSON.NUMINCRBY car:1 $.price 250     # [18250]
> JSON.ARRAPPEND car:1 $.tags '"hybrid"'
> JSON.DEL car:1 $.tags
```

### 38. RediSearch

```bash
> FT.CREATE cars-idx ON JSON PREFIX 1 car: SCHEMA
    $.make AS make TAG
    $.model AS model TEXT
    $.price AS price NUMERIC SORTABLE

> FT.SEARCH cars-idx '@make:{Toyota}' SORTBY price DESC
> FT.SEARCH cars-idx 'Civic' RETURN 2 make price
> FT.AGGREGATE cars-idx '*' GROUPBY 1 @make REDUCE COUNT 0 AS n
```

Full recipes in [`docs/HA-AND-MODULES.md`](docs/HA-AND-MODULES.md).

---

# 🧪 How to Break It (Chaos Checklist)

Best way to learn Redis is to make it fail.

| Try | What you'll learn |
|---|---|
| Bid from 7 tabs in 5s | Sliding-window rate limit kicks in (HTTP 429) |
| Bid in last 10s of timer | Anti-snipe extends by 10s (Lua atomic) |
| Open same auction in 3 tabs as different users | Live presence counter ticks (Sets) |
| Kill the API mid-auction (`docker stop` then start) | State recovers from Redis — no bids lost |
| `docker pause redis-auction-redis` mid-bid | API errors immediately; live updates stop |
| `redis-cli MONITOR` while bidding | See every Lua/Pub/Sub/XADD call in real time |
| `docker pause redis-auction-redis` after sentinel up | Failover to replica within ~5s |
| `redis-cli DEBUG SLEEP 5` | All subsequent commands queue; `SLOWLOG` captures it |
| Fill maxmemory (`DEBUG OBJECT … freq high; SET massive`) | `allkeys-lru` eviction kicks in |

---

# 🔌 API Endpoint Reference

| Method | Path | Phase |
|---|---|---|
| `GET` | `/health` | 1 |
| `POST` | `/auctions` | 2 |
| `GET` | `/auctions?city=Dhaka&radiusKm=200&make=Toyota` | 2, 12 |
| `GET` | `/auctions/:id` (also `INCR views`) | 2, 13 |
| `GET` | `/auctions/me/recent` (LRANGE) | 13 |
| `GET` | `/auctions/me/stats` (BITFIELD GET) | 13 |
| `GET` | `/auctions/meta/cities` | 12 |
| `GET` | `/auctions/meta/makes` (SMEMBERS) | 12 |
| `GET` | `/auctions/meta/engagement` (BITCOUNT DAU) | 13 |
| `POST` | `/auctions/:id/bids` | 3, 4, 14 |
| `GET` | `/auctions/:id/bids` | 3 |
| `GET` | `/leaderboard/hot` | 9 |
| `GET` | `/leaderboard/auctions/:id/stats` (cache-aside) | 9, 14 |
| `GET` | `/ops/slowlog` | 20 |
| `GET` | `/ops/latency` | 20 |
| `GET` | `/ops/memory?key=...` | 20 |
| `GET` | `/ops/object/:key` | 20 |
| `GET` | `/ops/clients` | 20 |
| `GET` | `/ops/sort/recent` (SORT BY/GET) | 20 |
| `GET` | `/ops/queues` (LLEN) | 16 |
| `GET` | `/ops/analytics` (consumer group output) | 15 |
| `GET` | `/ops/functions/:id` (FCALL) | 17 |

Socket.IO events (client → server): `watch`, `unwatch`, `notifications:pull`.
Socket.IO events (server → client): `bid`, `closed`, `presence`.

---

# 📁 Project layout

```
redis-car-auction/
├── docker-compose.yml              # base: Redis + Postgres (AOF + RDB + SLOWLOG + LATENCY)
├── docker-compose.ha.yml           # profiles: replica, sentinel, stack (modules)
├── docker-compose.cluster.yml      # 6-node cluster
│
├── ops/
│   ├── sentinel/sentinel.conf
│   ├── cluster/redis-cluster.conf
│   └── users.acl                   # example ACL
│
├── api/                            # Express + TypeScript
│   ├── src/
│   │   ├── index.ts                # boot + workers + socket.io
│   │   ├── config/
│   │   │   ├── env.ts
│   │   │   ├── redis.ts            # 4 separate connections
│   │   │   └── db.ts
│   │   ├── redis/                  # All Redis logic, isolated per concept
│   │   │   ├── keys.ts             # ← single source of truth for key naming
│   │   │   ├── auctionRepo.ts      # Hashes + TTL + SCAN + pipeline
│   │   │   ├── bidRepo.ts          # ZSET + MULTI/WATCH
│   │   │   ├── bidLua.ts           # Lua atomic bid
│   │   │   ├── cache.ts            # Cache-aside + single-flight
│   │   │   ├── engagement.ts       # Lists + INCR + Bitmaps + BITFIELD + EXPIREAT
│   │   │   ├── functions.ts        # Redis Functions library
│   │   │   ├── geo.ts              # GEOADD + GEOSEARCH
│   │   │   ├── index_make.ts       # Sets as secondary indexes
│   │   │   ├── leaderboard.ts      # ZSET + HyperLogLog
│   │   │   ├── locks.ts            # SET NX EX + Lua release
│   │   │   ├── presence.ts         # Sets
│   │   │   ├── pubsub.ts
│   │   │   ├── queue.ts            # LMOVE reliable queue
│   │   │   ├── rateLimit.ts        # Lua sliding-window
│   │   │   └── streams.ts          # XADD + XRANGE
│   │   ├── lua/
│   │   │   ├── placeBid.lua
│   │   │   └── rateLimit.lua
│   │   ├── workers/
│   │   │   ├── expiryWorker.ts     # keyspace notif + lock
│   │   │   ├── analyticsWorker.ts  # XGROUP + XREADGROUP + XACK
│   │   │   └── notifyWorker.ts     # BLMOVE drain + ACK
│   │   ├── routes/
│   │   │   ├── auctions.ts
│   │   │   ├── bids.ts             # rate-limited + Lua atomic
│   │   │   ├── leaderboard.ts      # cache-aside
│   │   │   ├── ops.ts              # observability
│   │   │   └── health.ts
│   │   ├── sockets/auctionSocket.ts
│   │   └── db/migrations/
│   ├── package.json
│   └── tsconfig.json
│
├── web/                            # Angular 20 (standalone, signals)
│   └── src/app/
│       ├── core/
│       │   ├── api.service.ts
│       │   └── socket.service.ts
│       └── features/
│           ├── auction-list/       # filter chips (city + make)
│           ├── auction-detail/     # live bidding screen
│           └── create-auction/     # car listing form
│
└── docs/
    ├── REDIS-CONCEPTS.md           # Every concept → file:line index
    ├── ARCHITECTURE.md             # Mermaid sequence diagrams
    ├── LEARNING-PATH.md            # Phase-by-phase checklist
    └── HA-AND-MODULES.md           # Replica / Sentinel / Cluster / ACL / TLS / Modules recipes
```

---

# 🚀 Stretch ideas

If you finish everything here and want more:

- **Redlock** — multi-master version of the distributed lock
- **Client-side caching** (RESP3 `CLIENT TRACKING`) — invalidations pushed by Redis
- **Prometheus exporter + Grafana** — wire up `redis_exporter` and import the official dashboard
- **`XAUTOCLAIM`** — extend the analytics worker to reclaim messages from dead consumers
- **Geo radius UI on a real map** — Leaflet + the GEOSEARCH endpoint
- **Image uploads** — store image bytes in Postgres / S3, URL in the auction hash
- **Real auth** — JWT, Argon2 passwords, OAuth — kept out of this repo to stay focused on Redis

---

## License

MIT — fork it, learn from it, ship your own.

---

**Built to teach. Read the code, run the chaos drills, break it on purpose.**
**The repo *is* the curriculum.**
