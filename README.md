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

---

## 🎯 Why this exists

Most Redis tutorials show you `SET foo bar`. That's not learning Redis — that's learning what Redis *is*. **Learning Redis means knowing when to reach for a Sorted Set vs a Stream, when Lua beats `MULTI`, why your distributed lock will deadlock without a token, how a single bad `KEYS` call brings down production.**

Every concept below has the answer to **"where would I actually use this?"** baked in — with a scenario, a CLI demo you can run, and a link to the real code.

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

Each concept has: **what · why here · 💡 worked example · CLI demo · code reference**.

---

## Beginner

### 1. Strings + INCR/DECR

**What:** The fundamental key-value pair. `INCR` atomically increments — no race conditions, even with 1000 concurrent callers.

**Why here:** Counting how many times each car was viewed.

> 💡 **Imagine:** Two visitors hit "Refresh" on a car listing at the exact same millisecond.
>
> **Without INCR** (using GET → +1 → SET): both read `5`, both write `6`. Counter is now `6` — but it *should* be `7`. **The counter undercounts forever.**
>
> **With INCR:** Redis serializes the increments internally. First caller gets `6`, second gets `7`. **No undercounting, no race, no lock needed.**

**Try it:**
```bash
redis-cli SET hello world
redis-cli GET hello                # "world"
redis-cli INCR views:car-42        # 1
redis-cli INCR views:car-42        # 2  ← guaranteed unique
redis-cli INCRBY views:car-42 10   # 12
redis-cli DECR views:car-42        # 11
```

**Code:** [`api/src/redis/engagement.ts`](api/src/redis/engagement.ts) → `recordView()`.

---

### 2. TTL — EXPIRE vs EXPIREAT

**What:** Auto-delete a key after N seconds (`EXPIRE`) or at a specific epoch timestamp (`EXPIREAT`). The single most important thing Redis does that your SQL database doesn't.

**Why here:** Auctions vanish from live state when they end. Recently-viewed list resets at midnight.

> 💡 **Imagine:** You cache the result of a slow query under `cache:results`. Without TTL, your cache grows forever and serves stale data eventually. With `EX 60`, the key auto-vanishes after 60 seconds — the next request recomputes fresh data. **No cleanup job. No staleness. The database does the chore for you.**
>
> `EXPIREAT` is "delete *at* this exact moment" — perfect for "all session tokens expire at 9 PM tonight" or "the daily-recommendation list resets at midnight UTC."

**Try it:**
```bash
redis-cli SET cache:hot "data" EX 10        # vanishes in 10s
redis-cli TTL cache:hot                     # 9
redis-cli TTL cache:hot                     # 5
redis-cli GET cache:hot                     # nil (after 10s)

# Absolute expiry — die at exactly this epoch second
redis-cli SET session:abc "..." EXAT 1893456000
redis-cli PERSIST session:abc               # cancel the expiry — key lives forever now
```

**Code:** [`auctionRepo.ts`](api/src/redis/auctionRepo.ts) (EXPIRE), [`engagement.ts`](api/src/redis/engagement.ts) (EXPIREAT).

---

### 3. Hashes

**What:** A key holding a flat map of field→value. Atomic per-field updates, no JSON parsing on writes.

**Why here:** Auction state — title, current price, timer, status — lives as fields in one hash.

> 💡 **Imagine:** You're tracking 12 fields per car (price, mileage, status, owner, ...).
>
> **Without hashes** (store JSON in a string):
> ```
> Read entire JSON → JSON.parse → mutate price → JSON.stringify → SET
> ```
> Two users editing simultaneously = lost write. And you transferred 2 KB just to bump a number.
>
> **With a hash:**
> ```
> HSET car:1 price 19000
> ```
> One field, atomic, 20 bytes on the wire. The other 11 fields untouched.

**Try it:**
```bash
redis-cli HSET auction:1 title "2022 Tesla Model 3" price 42000 status live
redis-cli HGET auction:1 price                 # "42000"
redis-cli HINCRBY auction:1 bidCount 1         # 1 — atomic increment of one field
redis-cli HINCRBY auction:1 bidCount 1         # 2
redis-cli HGETALL auction:1                    # whole map back
redis-cli HKEYS auction:1                      # just the field names
redis-cli HDEL auction:1 status                # remove one field
```

**Code:** [`auctionRepo.ts`](api/src/redis/auctionRepo.ts).

---

### 4. Lists — LPUSH / LTRIM / LRANGE

**What:** Linked list. Cheap append at head/tail, range reads, atomic trim. The substrate for queues and feeds.

**Why here:** "Recently viewed cars" per user — newest at head, capped at 20.

> 💡 **Imagine:** Your user just opened the 21st car page. You want their "recently viewed" list to stay at exactly 20 entries.
>
> **Without LTRIM:** `LRANGE 0 -1` (read all 21), count, decide to remove the tail, `RPOP`. Three commands, race conditions.
>
> **With LTRIM:** `LPUSH recent:bob car-X` then `LTRIM recent:bob 0 19`. Two commands, atomic. **The trim is a no-op when the list is < 20, so it's also free in the common case.**

**Try it:**
```bash
redis-cli LPUSH recent:bob car-7 car-3 car-9   # all pushed; newest is car-9
redis-cli LRANGE recent:bob 0 -1               # ["car-9","car-3","car-7"]
redis-cli LPUSH recent:bob car-1
redis-cli LTRIM recent:bob 0 1                 # keep only first 2 → ["car-1","car-9"]
redis-cli LLEN recent:bob                      # 2
redis-cli LREM recent:bob 1 "car-9"            # remove first 1 occurrence
```

**Code:** [`engagement.ts`](api/src/redis/engagement.ts).

---

### 5. Sets

**What:** Unordered, unique members. O(1) add, remove, membership-test, and size.

**Why here:** Who is currently watching this auction. SADD on socket connect, SREM on disconnect, SCARD for the "23 watching" badge.

> 💡 **Imagine:** Alice opens an auction in 3 browser tabs. She's still **one** watcher.
>
> **Without a Set:** you'd track watchers in a list, then dedupe on every read. With 10,000 watchers that becomes expensive.
>
> **With a Set:** `SADD watchers:auction-1 alice` runs 3 times → the set still has 1 member. `SCARD` gives you the count in O(1) regardless of size. Uniqueness is **free**.

**Try it:**
```bash
redis-cli SADD watchers:auction-1 alice bob carol
redis-cli SADD watchers:auction-1 alice         # already there — no-op
redis-cli SCARD watchers:auction-1              # 3
redis-cli SISMEMBER watchers:auction-1 bob      # 1 (truthy)
redis-cli SISMEMBER watchers:auction-1 dave     # 0
redis-cli SMEMBERS watchers:auction-1           # ["alice","bob","carol"]
redis-cli SREM watchers:auction-1 bob          # 1 (removed)

# Boolean math on sets
redis-cli SADD set:online   alice bob carol dave
redis-cli SADD set:premium  bob carol
redis-cli SINTER set:online set:premium         # ["bob","carol"]  — online AND premium
redis-cli SDIFF set:online set:premium          # ["alice","dave"] — online AND NOT premium
```

**Code:** [`presence.ts`](api/src/redis/presence.ts).

---

### 6. SCAN (never use KEYS in production)

**What:** Cursor-based iteration over the keyspace. Non-blocking, safe on giant datasets. `KEYS pattern` is O(n) and **blocks Redis for the entire scan**.

**Why here:** Listing all auction IDs without freezing the server.

> 💡 **Imagine:** You have 5 million keys. Someone runs `KEYS *` in a console. Redis is now single-threaded-busy for **30+ seconds**. Every other client times out. The whole site goes down. *This is a real production incident at major companies.*
>
> **With SCAN:** Redis returns ~100 keys plus a cursor. You call again with that cursor. Loop until cursor returns 0. Each call takes microseconds. **Other clients never notice.**

**Try it:**
```bash
# Seed a bunch
for i in $(seq 1 1000); do redis-cli SET "user:$i" x > /dev/null; done

# DANGEROUS — blocks Redis
# redis-cli KEYS 'user:*'

# SAFE — cursor loop
redis-cli SCAN 0 MATCH 'user:*' COUNT 100
# → ["256", ["user:1","user:2",...]]  cursor=256
redis-cli SCAN 256 MATCH 'user:*' COUNT 100
# → ["512", [...]]
# keep going until cursor == "0"
```

**Code:** [`auctionRepo.ts`](api/src/redis/auctionRepo.ts) `listAuctionIds()` — proper cursor loop.

---

### 7. TYPE / OBJECT — knowing what's actually in your key

**What:** Inspect a key's data type, internal encoding, access frequency, and idle time. Essential when debugging "why is this key huge?" or "why is my LFU eviction picking the wrong keys?".

> 💡 **Imagine:** Your hash with 100 fields uses 4 KB. You add a 101st field and suddenly it uses 60 KB. Why?
>
> Redis switches encoding when a structure crosses a threshold: small hashes use `listpack` (compact, O(n) lookup); large ones flip to `hashtable` (more memory, O(1) lookup). `OBJECT ENCODING` tells you which one you have. Tuning `hash-max-listpack-entries` in `redis.conf` controls when the flip happens.

**Try it:**
```bash
redis-cli HSET myhash a 1 b 2 c 3
redis-cli TYPE myhash                # hash
redis-cli OBJECT ENCODING myhash     # listpack (small) — switches to hashtable if you grow it
redis-cli OBJECT FREQ myhash         # access frequency (requires LFU policy)
redis-cli OBJECT IDLETIME myhash     # seconds since last access
redis-cli MEMORY USAGE myhash        # bytes this key occupies
```

**Code:** [`routes/ops.ts`](api/src/routes/ops.ts) → `GET /ops/object/:key`.

---

### 8. Pipelining

**What:** Batch N commands into 1 network round-trip. Cuts latency by 10–100×.

**Why here:** Listing 100 auctions = 100 `HGETALL` calls. Without pipelining that's 100 round-trips ≈ 100 ms in a data center. With pipelining: 1 round-trip ≈ 1 ms.

> 💡 **Imagine:** You're 1ms RTT from Redis (LAN). 100 sequential HGETALLs = 100ms total wait. Now imagine you're 50ms RTT (cross-region). That's **5 seconds** for a page render. Pipelining collapses it back to ~51ms.
>
> The commands still execute one-by-one on the server — pipelining only batches the *network*. It is **not** a transaction.

**Try it:**
```js
// JavaScript with ioredis — pipeline
const pipe = redis.pipeline();
for (let i = 1; i <= 100; i++) pipe.hgetall(`auction:${i}`);
const results = await pipe.exec();   // single round-trip
```

```bash
# CLI demo — try with and without --pipe
seq 1 1000 | xargs -I{} echo "SET k{} v{}" | redis-cli --pipe
# → All 1000 SETs over 1 connection, ~10x faster than 1000 separate commands
```

**Code:** [`auctionRepo.ts`](api/src/redis/auctionRepo.ts) `listAuctions()`, [`bidRepo.ts`](api/src/redis/bidRepo.ts).

---

## Intermediate

### 9. Sorted Sets (ZSET)

**What:** Set where each member has a numeric score. Ranged queries in O(log n). The Swiss-army knife of Redis.

**Why here:** Bid history per auction (score = amount), "hottest auctions" leaderboard, sliding-window rate limiter.

> 💡 **Imagine:** A game leaderboard with 1 million players. "Show top 10" must be instant. "Find player Bob's rank" must be instant. "Add 50 points to Bob" must be instant.
>
> **With ZSET:** `ZADD lb 8500 bob` (insert/update score), `ZREVRANGE lb 0 9` (top 10), `ZRANK lb bob` (Bob's position) — all O(log n). The same structure handles bid history, time-bucket queries, top-N rankings, range queries, and even sliding-window rate limiting.

**Try it:**
```bash
redis-cli ZADD bids:auction-1 18000 bid-a 19000 bid-b 17000 bid-c
redis-cli ZREVRANGE bids:auction-1 0 -1 WITHSCORES   # high → low
# 1) "bid-b" 2) "19000" 3) "bid-a" 4) "18000" 5) "bid-c" 6) "17000"

redis-cli ZRANGEBYSCORE bids:auction-1 18000 +inf   # bids ≥ 18000
redis-cli ZINCRBY hot:auctions 1 auction-1          # bump activity score by 1
redis-cli ZRANK bids:auction-1 bid-b                # position (0-indexed, low → high)
redis-cli ZREVRANK bids:auction-1 bid-b             # 0 — top!
redis-cli ZCARD bids:auction-1                      # cardinality (3)
```

**Code:** [`bidRepo.ts`](api/src/redis/bidRepo.ts), [`leaderboard.ts`](api/src/redis/leaderboard.ts).

---

### 10. Bitmaps — SETBIT / BITCOUNT

**What:** Treat a string as a bit array. Set the N-th bit. Count set bits. Memory is *insanely* small.

**Why here:** Daily Active Users. Map each user to a bit offset; flip their bit when they show up.

> 💡 **Imagine:** You want to track DAU across 10 million users. Naive options:
>
> - **Postgres** `SELECT COUNT(DISTINCT user_id) FROM activity_log WHERE day = today` — slow on a billion-row table
> - **Set** of user IDs — ~80 bytes × 10M = 800 MB per day
> - **HyperLogLog** — 12 KB but only approximate
>
> **Bitmap:** 10M bits = 1.25 MB. Exact. O(1) per write. `BITCOUNT` returns DAU in single-digit milliseconds. Want "users active both yesterday AND today"? `BITOP AND` two bitmaps — done.

**Try it:**
```bash
# User 100 is active today
redis-cli SETBIT dau:20260516 100 1
redis-cli SETBIT dau:20260516 250 1
redis-cli SETBIT dau:20260516 100 1   # already 1 — no-op, still counts as 1 user

redis-cli BITCOUNT dau:20260516        # 2
redis-cli GETBIT dau:20260516 100      # 1
redis-cli GETBIT dau:20260516 999      # 0

# "Returning users" — active yesterday AND today
redis-cli BITOP AND dau:both dau:20260515 dau:20260516
redis-cli BITCOUNT dau:both
```

**Code:** [`engagement.ts`](api/src/redis/engagement.ts).

---

### 11. BITFIELD — packed counters

**What:** Multiple typed counters inside one key, with explicit overflow semantics. Memory-efficient when you have lots of small per-user counters.

> 💡 **Imagine:** You want per-user `(sessions, page_views, clicks)` counters for 100M users. Three separate `INCR` keys per user = 300M keys, each with ~50 bytes of overhead = **15 GB**.
>
> **With BITFIELD:** pack three `u16` counters in one key. 6 bytes per user. **600 MB total — a 25× memory saving.** And `OVERFLOW WRAP/SAT/FAIL` lets you control what happens at the boundary.

**Try it:**
```bash
# Two unsigned 16-bit slots in one key, both atomically +1
redis-cli BITFIELD user:bob \
  INCRBY u16 \#0 1 \
  INCRBY u16 \#1 5
# → [1, 5]

redis-cli BITFIELD user:bob \
  INCRBY u16 \#0 1 \
  INCRBY u16 \#1 5
# → [2, 10]

# Read them back
redis-cli BITFIELD user:bob GET u16 \#0 GET u16 \#1
# → [2, 10]

# Overflow handling
redis-cli BITFIELD c OVERFLOW SAT INCRBY u8 0 250
redis-cli BITFIELD c OVERFLOW SAT INCRBY u8 0 100   # would overflow → saturates at 255
```

**Code:** [`engagement.ts`](api/src/redis/engagement.ts) `userPackedStats()`.

---

### 12. Sets as secondary indexes

**What:** When your store has no query engine, build your own indexes. One Set per indexed value. Combine with `SINTER`/`SUNION` for boolean queries.

**Why here:** Filter cars by make. `idx:make:toyota` holds all Toyota auction IDs. Intersect with the Geo result for "Toyotas near Dhaka."

> 💡 **Imagine:** Your app needs "show me all blue Toyota Corollas in Dhaka." Three filter dimensions, no SQL `WHERE`.
>
> **Build three sets:** `idx:color:blue`, `idx:model:corolla`, `idx:city:dhaka`. **Intersect with `SINTERSTORE result idx:color:blue idx:model:corolla idx:city:dhaka`** — the result is exactly the matching car IDs. Combine with `SUNION` for OR queries, `SDIFF` for NOT queries. **You just built a query engine out of Sets.**

**Try it:**
```bash
redis-cli SADD idx:make:toyota auction-1 auction-7
redis-cli SADD idx:make:honda  auction-2 auction-9
redis-cli SADD idx:color:red   auction-1 auction-2

# "Red Toyota" — intersect two indexes
redis-cli SINTER idx:make:toyota idx:color:red   # ["auction-1"]

# Store the result for paginated reads
redis-cli SINTERSTORE filtered idx:make:toyota idx:color:red
redis-cli SMEMBERS filtered
```

**Code:** [`index_make.ts`](api/src/redis/index_make.ts).

---

### 13. Pub/Sub + PSUBSCRIBE

**What:** Fire-and-forget messaging. Publishers don't know about subscribers; messages aren't stored. Use for *live ephemeral* fanout.

**Why here:** Server publishes `ch:bid:{auctionId}` on every bid; Socket.IO's Redis adapter fans it out to every connected browser tab.

> 💡 **Imagine:** 500 people are watching the same auction. Bob bids $20k. You want all 500 browsers to see the new bid within 100ms.
>
> **HTTP polling:** every browser polls `GET /auction/X` every 2s. 500 × 0.5 RPS = 250 req/sec to your API. Updates lag up to 2s.
>
> **With Pub/Sub:** server `PUBLISH ch:bid:X "{amount:20000}"`. All 500 connected sockets get the push within milliseconds. **Zero polling.** And `PSUBSCRIBE 'ch:bid:*'` lets one subscriber watch all auctions at once.

**Try it (open two terminals):**
```bash
# Terminal A — listener
redis-cli PSUBSCRIBE 'ch:bid:*'

# Terminal B — publisher
redis-cli PUBLISH ch:bid:auction-1 '{"amount":19000,"bidder":"bob"}'
redis-cli PUBLISH ch:bid:auction-2 '{"amount":50000,"bidder":"alice"}'

# Terminal A sees both messages instantly
```

```bash
# How many subscribers on a channel?
redis-cli PUBSUB NUMSUB ch:bid:auction-1
# Which channels are active?
redis-cli PUBSUB CHANNELS '*'
```

**Code:** [`pubsub.ts`](api/src/redis/pubsub.ts), [`sockets/auctionSocket.ts`](api/src/sockets/auctionSocket.ts).

---

### 14. Socket.IO Redis adapter

**What:** Lets Socket.IO scale across N Node processes. Without it, browser A connected to server instance 1 never hears events from instance 2.

> 💡 **Imagine:** Your API runs 4 Node processes behind a load balancer. Alice's socket connects to process 1. Bob's connects to process 3. Bob bids. The server-side `io.to(roomX).emit('bid')` only reaches sockets on process 3 — Alice misses the update.
>
> **With the Redis adapter:** every `emit` is also `PUBLISH`'d to Redis. All 4 processes are subscribed. All 4 re-emit to their local sockets. Alice and Bob both see the bid. **You just made Socket.IO horizontally scalable in 2 lines.**

**Setup:**
```ts
import { createAdapter } from "@socket.io/redis-adapter";
io.adapter(createAdapter(redisPub, redisSub));
```

**Code:** [`sockets/auctionSocket.ts`](api/src/sockets/auctionSocket.ts).

---

### 15. MULTI / EXEC / WATCH — optimistic locking

**What:** Group commands into a transaction. `WATCH key` — if anyone modifies that key before `EXEC`, the transaction returns `null` and you retry.

**Why here:** Original "place bid" implementation, kept for comparison vs the Lua version. Try with `POST /auctions/:id/bids?strategy=multi`.

> 💡 **Imagine:** Two users bid on the same auction within 1ms. Both read `currentPrice = 18000`. Both compute `newPrice = 18250`. Both write `HSET ... price 18250`. **One bid is silently lost** — the second bidder thinks they outbid the first, but they didn't.
>
> **With WATCH:** caller A `WATCH`es the auction hash, reads it, queues writes, `EXEC`s. Caller B does the same in parallel. Whichever finishes first wins. The loser's `EXEC` returns `nil` because the watched key changed — they retry with the fresh state. **Eventually consistent, never silently wrong.**

**Try it:**
```bash
redis-cli HSET auction:1 price 18000

# Session A:
redis-cli WATCH auction:1
redis-cli MULTI
redis-cli HINCRBY auction:1 price 250
redis-cli HINCRBY auction:1 bidCount 1
# (don't EXEC yet)

# Session B (in another terminal) writes to auction:1
redis-cli HSET auction:1 price 99999

# Session A:
redis-cli EXEC           # returns (nil) — the watched key changed — retry!
```

**Code:** [`bidRepo.ts`](api/src/redis/bidRepo.ts) `placeBidMulti()`.

---

### 16. Cache-aside + Single-flight (stampede protection)

**What:** The classic cache pattern. **Without single-flight**, 1000 concurrent misses → 1000 hits to your slow source. **With it**, exactly 1 caller recomputes, 999 wait on the result.

**Why here:** "Stats for this auction" endpoint. Cached for 10s. Concurrent misses share the work.

> 💡 **Imagine:** Your popular blog post's view counter is cached. The cache expires. Within the next 50ms, 1000 visitors hit the page. 1000 simultaneous cache misses. **All 1000 query your slow Postgres at once. Postgres pegs at 100% CPU. Your site dies.** This is called a "cache stampede" or "thundering herd."
>
> **With single-flight:** first caller atomically grabs a lock (`SET lock:stats NX EX 5`). 999 others see the lock is taken; they poll for the cache key to appear. Lock holder computes, writes the cache, releases the lock. Everyone reads the cache. **Postgres got 1 query instead of 1000.**

**Try it:**
```bash
# First call — cache miss, computes
curl -i http://localhost:3000/leaderboard/auctions/<id>/stats
# < X-Cache: miss

# Second call within 10s — cache hit
curl -i http://localhost:3000/leaderboard/auctions/<id>/stats
# < X-Cache: hit

# Concurrent calls (start them at the same time)
for i in 1 2 3 4 5; do
  curl -s -o /dev/null -w "X-Cache: %header{X-Cache}\n" \
    http://localhost:3000/leaderboard/auctions/<id>/stats &
done
# Result: 1 × miss + 4 × wait — only one caller actually recomputed
```

**Code:** [`cache.ts`](api/src/redis/cache.ts), used by [`routes/leaderboard.ts`](api/src/routes/leaderboard.ts).

---

### 17. Rate limiting (Lua sliding-window)

**What:** Atomic sliding-window log via a single Lua script. Adds `now()` to a sorted set, prunes anything older than the window, rejects if over the limit.

**Why here:** 5 bids per 10 seconds per user. Try bid #6? `HTTP 429`.

> 💡 **Imagine:** You sell tickets. A bot fires 1000 requests per second to snipe inventory. You add a rate limiter: 10 requests / minute.
>
> **Naive rate limit in app code:** `GET counter → check → INCR`. Two concurrent requests can both read "9 of 10" and both insert — you've shipped a limiter that lets through 11. **Useless.**
>
> **Lua sliding-window:** the whole "trim old + count + insert" runs atomically on the Redis server. Two concurrent requests serialize. The limit is *exactly* 10. Bots get exactly the limit they're supposed to get.

**Try it:**
```bash
# 5 bids/10s/user
for i in 1 2 3 4 5 6 7; do
  curl -s -X POST http://localhost:3000/auctions/<id>/bids \
    -H "X-User-Id: demo-bob" -H "Content-Type: application/json" \
    -d "{\"amount\": $((20000 + i*100))}"
  echo
done
# 1: {"ok":true,...}
# 2: {"ok":true,...}
# 3: {"ok":true,...}
# 4: {"ok":true,...}
# 5: {"ok":true,...}
# 6: {"ok":false,"reason":"rate_limited","count":5,"limit":5}
# 7: {"ok":false,"reason":"rate_limited","count":5,"limit":5}
```

**Code:** [`lua/rateLimit.lua`](api/src/lua/rateLimit.lua), [`redis/rateLimit.ts`](api/src/redis/rateLimit.ts).

---

### 18. Geo — GEOADD / GEOSEARCH

**What:** Sorted set under the hood; members are placed at lat/lng. Query by radius in O(log n).

**Why here:** Filter cars within X km of a city.

> 💡 **Imagine:** You're building Uber. "Show me drivers within 2 km of the rider." With a naive SQL query you'd `SELECT … WHERE lat BETWEEN ... AND lng BETWEEN ...` — a rectangle, not a circle, and slow at scale.
>
> **With GEOSEARCH:** Redis encodes each member's lat/lng as a `geohash` integer score, then uses sorted-set range queries to find members in a true circular radius. Returns sorted by distance. Microsecond latency for tens of millions of points.

**Try it:**
```bash
redis-cli GEOADD geo:drivers 90.4125 23.8103 driver-1   # Dhaka
redis-cli GEOADD geo:drivers 91.7832 22.3569 driver-2   # Chittagong
redis-cli GEOADD geo:drivers 90.4500 23.8200 driver-3   # near Dhaka

redis-cli GEOSEARCH geo:drivers \
  FROMLONLAT 90.4125 23.8103 \
  BYRADIUS 10 km \
  ASC WITHCOORD WITHDIST COUNT 5
# driver-1 (0 km), driver-3 (5 km)  — driver-2 in Chittagong excluded

redis-cli GEODIST geo:drivers driver-1 driver-2 km   # ~245
redis-cli GEOPOS geo:drivers driver-1                # exact coords
```

**Code:** [`geo.ts`](api/src/redis/geo.ts).

---

### 19. Reliable queue — LMOVE / BLMOVE

**What:** Atomic "take one job from inbound → processing list" pattern. If your worker crashes mid-delivery, the job stays in `:processing` and a janitor reaper can replay it.

**Why here:** Outbid notifications. Worker dies mid-send? Message is recoverable.

> 💡 **Imagine:** You have a queue of email-sending jobs. Worker does `LPOP queue`, gets a job, then crashes before the email sends. **The job is lost forever.**
>
> **With LMOVE:** worker does `LMOVE queue processing` (atomic move). Sends the email. On success: `LREM processing` to ack. If the worker crashes between LMOVE and send, the job sits in `processing` until a reaper notices it's stale (say, > 60s old) and moves it back. **Zero message loss, exactly-once-ish delivery.**

**Try it:**
```bash
redis-cli LPUSH q:notify '{"type":"outbid","user":"bob"}'
redis-cli LPUSH q:notify '{"type":"outbid","user":"alice"}'

# Worker takes one
redis-cli BLMOVE q:notify q:notify:processing LEFT RIGHT 5
# → '{"type":"outbid","user":"alice"}'
redis-cli LRANGE q:notify:processing 0 -1
# → ["{\"type\":\"outbid\",\"user\":\"alice\"}"]

# Pretend the worker crashed here — the message stays in :processing
# A reaper would move it back: LMOVE q:notify:processing q:notify RIGHT LEFT

# Success path — ack
redis-cli LREM q:notify:processing 1 '{"type":"outbid","user":"alice"}'
```

**Code:** [`queue.ts`](api/src/redis/queue.ts), [`workers/notifyWorker.ts`](api/src/workers/notifyWorker.ts).

---

### 20. SORT — with BY/GET (server-side join)

**What:** Sort a list/set, optionally fetch fields from *other* keys via `BY` and `GET`. One of Redis's oldest and most underused commands.

> 💡 **Imagine:** You have `recent:bob = [car-7, car-3, car-9]` and three hashes `car:7`, `car:3`, `car:9` each with `currentPrice` and `title`. You want "Bob's recent cars, sorted by price descending, with titles."
>
> **Without SORT:** `LRANGE` to fetch IDs, `HGETALL` for each (or pipeline), sort in app code. Multiple round-trips, lots of code.
>
> **With SORT:** one command does it all *on the server*. **It's a server-side JOIN that predates SQL by decades.**

**Try it:**
```bash
redis-cli RPUSH recent:bob car-7 car-3 car-9
redis-cli HSET car:7 price 18000 title "Toyota Corolla"
redis-cli HSET car:3 price 42000 title "Tesla Model 3"
redis-cli HSET car:9 price 9500  title "Suzuki Alto"

redis-cli SORT recent:bob \
  BY "car:*->price" \
  GET "car:*->title" \
  GET "car:*->price" \
  GET "#" \
  DESC ALPHA
# Returns interleaved [title, price, id, title, price, id, ...]
# 1) "Tesla Model 3"   2) "42000" 3) "car-3"
# 4) "Toyota Corolla"  5) "18000" 6) "car-7"
# 7) "Suzuki Alto"     8) "9500"  9) "car-9"
```

**Code:** [`routes/ops.ts`](api/src/routes/ops.ts) → `GET /ops/sort/recent`.

---

## Advanced

### 21. Lua scripting — EVAL / EVALSHA

**What:** Run a Lua script atomically on the Redis server. The whole script executes as one command — no interleaving possible.

**Why here:** `placeBid.lua` validates the bid, writes it, updates auction state, and extends the timer if anti-snipe fires — all atomically, in one round-trip.

> 💡 **Imagine:** Your bid logic is: read price, check it's higher than current + minIncrement, write new price + new top bidder + extend TTL if last 10s. **Five separate Redis commands.**
>
> **With MULTI/WATCH:** can do this with optimistic locking, but you retry on conflict — under load you retry a lot.
>
> **With Lua:** the whole 5-command sequence runs as one indivisible operation. Other clients are physically blocked from interleaving. **The "anti-snipe TTL extension" is a perfect example — you must know the bid was valid *before* extending the TTL. Lua makes that one atomic decision.**

**Try it:**
```bash
# Load once
SHA=$(redis-cli SCRIPT LOAD "
local current = tonumber(redis.call('HGET', KEYS[1], 'price')) or 0
local bid = tonumber(ARGV[1])
if bid <= current then return {0, 'too_low', current} end
redis.call('HSET', KEYS[1], 'price', bid)
return {1, 'ok', bid}
")

redis-cli HSET auction:1 price 18000
redis-cli EVALSHA $SHA 1 auction:1 17000   # [0, "too_low", 18000]
redis-cli EVALSHA $SHA 1 auction:1 19000   # [1, "ok", 19000]
```

**Code:** [`lua/placeBid.lua`](api/src/lua/placeBid.lua), [`bidLua.ts`](api/src/redis/bidLua.ts) (handles `NOSCRIPT` cache-miss recovery).

---

### 22. Redis Functions (Redis 7+)

**What:** A library of *named* server-side functions. Persists across restarts (scripts don't). Replicated. AOF-logged. The modern replacement for `SCRIPT LOAD`.

> 💡 **Imagine:** You have 10 different Lua scripts. With `EVAL`/`EVALSHA` you store each one's SHA on every client, reload them after `SCRIPT FLUSH`, version them ad-hoc.
>
> **With Functions:** you `FUNCTION LOAD` a *library* once. All scripts inside become callable by name (`FCALL bid_count …`). The library persists across restarts. It's versioned (`REPLACE` flag). It replicates to replicas. **It's the difference between "a bag of scripts" and "a real server-side API."**

**Try it:**
```bash
redis-cli FUNCTION LOAD REPLACE "#!lua name=mylib
redis.register_function('greet', function(keys, args)
  return 'Hello ' .. (args[1] or 'world')
end)
"

redis-cli FCALL greet 0 Alice   # "Hello Alice"
redis-cli FUNCTION LIST          # see all loaded libraries
redis-cli FUNCTION DUMP          # serialize all libs (for backup)
```

**Code:** [`redis/functions.ts`](api/src/redis/functions.ts) — exposed at `GET /ops/functions/:id`.

---

### 23. Streams — XADD / XRANGE

**What:** Append-only log with millisecond IDs. Capped via `MAXLEN ~ N` (the `~` means "approximate, fast"). Think Kafka, but inside Redis.

**Why here:** Audit log of every bid + per-user notification feed.

> 💡 **Imagine:** You need an append-only log of every event, with replay, consumer groups, capped size, and microsecond IDs that double as timestamps. You could install Kafka (+Zookeeper, +monitoring, +ops headaches).
>
> **Or:** `XADD audit '*' user bob amount 19000` — done. No new infrastructure. Capped to your memory budget with `MAXLEN ~ 10000`. Iterable forward and backward (`XRANGE` / `XREVRANGE`). Reads scale to consumer groups (next section).

**Try it:**
```bash
redis-cli XADD audit:bids MAXLEN \~ 10000 '*' user bob amount 19000
# → "1700000000000-0"  ← the ID (ms epoch + sequence)
redis-cli XADD audit:bids '*' user alice amount 20000

redis-cli XLEN audit:bids                    # 2
redis-cli XRANGE audit:bids - + COUNT 5      # all entries
redis-cli XREVRANGE audit:bids + - COUNT 1   # most recent only
redis-cli XINFO STREAM audit:bids            # detailed info

# Trim explicitly
redis-cli XTRIM audit:bids MAXLEN 1
```

**Code:** [`streams.ts`](api/src/redis/streams.ts).

---

### 24. Stream Consumer Groups

**What:** Multiple workers cooperatively consume a stream. Each message goes to exactly one worker. Unacked messages can be reclaimed if a worker dies. **The real "Redis as Kafka" pattern.**

**Why here:** `analyticsWorker` reads `audit:bids` via `XREADGROUP`, materializes hourly bid count + sum into a hash, then `XACK`s.

> 💡 **Imagine:** A stream of payment events. You want 3 workers processing in parallel, but each event must be handled by exactly one. And if a worker dies mid-processing, the message must be replayable by another worker.
>
> **With XREADGROUP:** create a group, each worker has a unique consumer name, each call returns messages "addressed to me." After processing, `XACK` to mark done. If you crash without ack'ing, the message stays in *Pending* — another worker can `XAUTOCLAIM` it after a timeout. **At-least-once delivery, with backpressure, across N workers.**

**Try it:**
```bash
# Create the group (only once per stream)
redis-cli XGROUP CREATE audit:bids analytics 0 MKSTREAM

# Two workers consume cooperatively
redis-cli XREADGROUP GROUP analytics worker-1 COUNT 10 BLOCK 5000 STREAMS audit:bids '>'
redis-cli XREADGROUP GROUP analytics worker-2 COUNT 10 BLOCK 5000 STREAMS audit:bids '>'

# Acknowledge messages
redis-cli XACK audit:bids analytics 1700000000000-0

# Inspect
redis-cli XPENDING audit:bids analytics              # what's in-flight, by consumer
redis-cli XINFO GROUPS audit:bids                    # group state
redis-cli XAUTOCLAIM audit:bids analytics worker-1 60000 0-0   # reclaim stale messages
```

**Code:** [`workers/analyticsWorker.ts`](api/src/workers/analyticsWorker.ts).

---

### 25. Distributed locks (SET NX EX + Lua release)

**What:** Cross-process mutex. `SET key token NX EX ttl` only succeeds if the key didn't exist. Release with a Lua compare-and-delete so only the owner can release.

**Why here:** Only one worker should close any given auction, even when many workers receive the keyspace expired event.

> 💡 **Imagine:** 3 worker processes all subscribe to the "auction expired" event. The expiry fires. All 3 race to write "winner = Carol" and send the email. Carol gets the email **3 times**.
>
> **With a distributed lock:** all 3 try `SET lock:close:auctionX <my-uuid> NX EX 10`. Only one succeeds. The other two see `nil` and back off. The winner does the work, then atomically releases via Lua compare-and-delete (so a slow worker doesn't accidentally release a lock it lost to TTL).
>
> ⚠️ **For multi-master Redis you need the Redlock algorithm** — this implementation is correct for single-master.

**Try it:**
```bash
TOKEN=$(uuidgen)
redis-cli SET lock:close:auction-1 $TOKEN EX 10 NX
# → OK   ← acquired

# Another caller tries
redis-cli SET lock:close:auction-1 other-token EX 10 NX
# → (nil) ← denied

# Safe release — only delete if I'm still the owner
redis-cli EVAL "
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
else
  return 0
end
" 1 lock:close:auction-1 $TOKEN
# → 1   ← released by owner
```

**Code:** [`locks.ts`](api/src/redis/locks.ts).

---

### 26. Keyspace notifications

**What:** Redis publishes events when keys are touched (`SET`, `DEL`, `EXPIRED`, …). Must be enabled with `notify-keyspace-events Ex` (E = events, x = expired).

**Why here:** Auctions auto-close when their TTL runs out. The expiry worker subscribes to `__keyevent@0__:expired` and triggers the close logic.

> 💡 **Imagine:** You want to send a "your session expired" email exactly when the session key vanishes. **Without keyspace notifications:** you'd poll every second for missing keys — wasteful and laggy.
>
> **With keyspace notifications:** subscribe to `__keyevent@0__:expired`. Redis pushes you the key name the moment the TTL fires. Your handler runs within milliseconds. **This is how "auto-close after X minutes" features get built.**

**Try it:**
```bash
redis-cli CONFIG SET notify-keyspace-events Ex

# Terminal A — listen
redis-cli PSUBSCRIBE '__key*__:*'

# Terminal B — set a key with TTL
redis-cli SET willdie "x" EX 3
# Wait 3s...

# Terminal A sees: pmessage __keyevent@0__:expired __keyevent@0__:expired "willdie"
```

**Code:** [`workers/expiryWorker.ts`](api/src/workers/expiryWorker.ts).

---

### 27. HyperLogLog

**What:** Probabilistic structure for unique-count. Fixed ~12 KB memory, ~0.8% error, **cannot enumerate members**. Brilliant for "unique visitors today" on a billion-event firehose.

> 💡 **Imagine:** You want "unique IP addresses that visited today" on a site with 100 million daily hits.
>
> **Set of IPs:** 100M × ~20 bytes = **2 GB of RAM per day**.
>
> **HyperLogLog:** ~12 KB *forever*, with ~0.8% error. You give up the ability to list the IPs (only count them), and you give up exact accuracy. In exchange you get a **170,000× memory reduction**. For unique-count metrics, that's a no-brainer.

**Try it:**
```bash
redis-cli PFADD unique:bidders:auction-1 bob alice carol bob bob
redis-cli PFCOUNT unique:bidders:auction-1            # 3 (bob deduped automatically)

# Merge multiple HLLs (e.g. day-level → week-level)
redis-cli PFADD day:mon bob alice
redis-cli PFADD day:tue alice dave eve
redis-cli PFMERGE week day:mon day:tue
redis-cli PFCOUNT week                                # ~4 (bob/alice/dave/eve)
redis-cli MEMORY USAGE week                           # ~12 KB
```

**Code:** [`leaderboard.ts`](api/src/redis/leaderboard.ts).

---

### 28. Three connections — the ioredis pattern

**What:** A Redis client in `SUBSCRIBE` mode can't run other commands. A client blocking on `BLMOVE` or `XREADGROUP BLOCK` holds the connection for seconds. **You need separate connections** or your app freezes.

> 💡 **Imagine:** You have one Redis client. You call `BLMOVE q queue:processing LEFT RIGHT 5` to wait for a job. The queue is empty for 4 seconds. **During those 4 seconds, every other `redis.get(...)` from your app queues behind it.** Your API freezes. Your `/health` endpoint stops responding. PagerDuty wakes you up.
>
> **Fix:** dedicated client for blocking commands. Same Redis server, separate TCP socket. The main client stays free to serve `GET`/`SET`/`HGET` requests at full speed.

**Pattern:**
```ts
export const redis         = new Redis(url);     // normal commands
export const redisSub      = redis.duplicate();  // SUBSCRIBE / keyspace events
export const redisPub      = redis.duplicate();  // Socket.IO adapter publisher
export const redisBlocking = redis.duplicate();  // BLMOVE / XREADGROUP BLOCK / BRPOP
```

**Code:** [`config/redis.ts`](api/src/config/redis.ts).

---

## Production / Ops

### 29. Persistence — AOF + RDB

**AOF** (Append-Only File): every write logged for durability.
**RDB** (Redis DB snapshots): periodic point-in-time snapshots, great for backups and fast restart.

> 💡 **Imagine:** Your Redis process crashes. With **AOF only**, replay the log on restart — could take minutes for a large dataset. With **RDB only**, restore the last snapshot — fast, but you lose every write since the snapshot. With **both**, fast restore from RDB + replay just the tail of the AOF.
>
> Rule of thumb: **run both in production**. RDB for backups + fast cold start, AOF for "lose at most 1 second" durability.

**Try it:**
```bash
redis-server --appendonly yes --save "60 100" --save "300 10"
# "60 100"  = snapshot if ≥100 writes in 60s
# "300 10"  = snapshot if ≥10  writes in 5min

redis-cli LASTSAVE              # epoch of last successful RDB
redis-cli BGSAVE                # trigger snapshot now (background)
redis-cli BGREWRITEAOF          # compact the AOF (background)
redis-cli INFO persistence      # see RDB / AOF status
```

**Config:** [`docker-compose.yml`](docker-compose.yml).

---

### 30. Eviction policy + maxmemory

When `maxmemory` is hit, Redis evicts per the policy. Pick wrong and your cache becomes a slow database.

> 💡 **Imagine:** Your Redis is the cache for a popular product page. You set `maxmemory 1gb` but forget to set the policy. Default = `noeviction`. Cache fills up. Next write returns **OOM error**. Your site falls over because your *cache* is full. 🤦
>
> **Fix:** set the policy to match your usage. Cache? → `allkeys-lru` (evict least-recently used from any key). Hot-key workload? → `allkeys-lfu` (least-frequently-used). Sessions with TTL? → `volatile-ttl` (evict the soonest-to-expire).

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
redis-cli INFO memory | grep -E "used_memory_human|maxmemory_policy"
```

**Config:** [`docker-compose.yml`](docker-compose.yml).

---

### 31. Observability — SLOWLOG / LATENCY / MEMORY / CLIENT

> 💡 **Imagine:** Your Redis was fine, now it's slow. Customers complain. You SSH in.
>
> - `SLOWLOG GET 10` → "oh, someone ran `KEYS *` and it took 8 seconds." Mystery solved.
> - `LATENCY HISTORY event-loop` → "Redis stalled twice in the last minute" — investigate `BGSAVE` timing.
> - `MEMORY USAGE bighashkey` → "this one hash is 200 MB."
> - `CLIENT LIST` → "client at 10.0.0.5 has been idle 3600s holding a `WATCH`."
> - `CLIENT KILL ID 42` → goodbye.

**Try it:**
```bash
# Commands slower than slowlog-log-slower-than microseconds
redis-cli SLOWLOG GET 10
redis-cli SLOWLOG LEN
redis-cli SLOWLOG RESET

# Internal latency events
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

> 💡 **Imagine:** Your master Redis dies. Without a replica, the cache is cold for minutes — site brownout while it warms back up. **With** a replica, promote it instantly; restart the dead node later as the new replica.
>
> Also: route read-only queries to replicas to scale read throughput. One master takes writes; N replicas serve reads. **Read throughput scales linearly.**

**Try it (this repo):**
```bash
docker compose -f docker-compose.yml -f docker-compose.ha.yml --profile replica up -d

docker exec redis-auction-redis    redis-cli INFO replication | grep ^role
# role:master  connected_slaves:1

docker exec redis-auction-redis    redis-cli SET demo hello
docker exec redis-auction-replica  redis-cli GET demo
# → "hello"   ← replicated within milliseconds
```

**Config:** [`docker-compose.ha.yml`](docker-compose.ha.yml) profile `replica`.

---

### 33. Sentinel (HA + automatic failover)

> 💡 **Imagine:** It's 3 AM and the master dies. Without Sentinel, a human must wake up, promote the replica, update the app config, redeploy. Site is down for 10+ minutes.
>
> **With Sentinel:** 3+ Sentinel processes constantly health-check the master. When ≥ quorum agree it's down, they elect a new master from the replicas automatically. Clients ask Sentinel "who's the master right now?" and reconnect. **Mean time to recovery: ~10 seconds. No humans involved.**

**Failover demo:**
```bash
docker compose -f docker-compose.yml -f docker-compose.ha.yml --profile sentinel up -d
docker exec redis-auction-sentinel-1 redis-cli -p 26379 sentinel masters

# Force a failover
docker pause redis-auction-redis
# Watch sentinels declare master down (after `down-after-milliseconds` 5000ms)
docker logs -f redis-auction-sentinel-1
# When you unpause, it rejoins as a replica
docker unpause redis-auction-redis
```

**Config:** [`docker-compose.ha.yml`](docker-compose.ha.yml) + [`ops/sentinel/sentinel.conf`](ops/sentinel/sentinel.conf).

---

### 34. Cluster mode (hash slots, MOVED/ASK)

> 💡 **Imagine:** Your dataset outgrows a single machine — 200 GB. One Redis can't hold it. **Cluster** shards the keyspace across N masters using 16,384 hash slots. Each master owns a range of slots. Add a node → some slots are migrated to it. Add replicas for HA per master.
>
> **Hash tags** (the `{tag}` syntax in your key) force keys with the same tag into the same slot — so multi-key ops (`MGET`, `MULTI`, Lua with multiple keys) keep working. Without tags, related keys would scatter across nodes and multi-key commands would fail with `CROSSSLOT`.

**Try it:**
```bash
docker compose -f docker-compose.cluster.yml up -d

# One-time: form the cluster
docker exec -it cl-node-1 redis-cli --cluster create \
  cl-node-1:6379 cl-node-2:6379 cl-node-3:6379 \
  cl-node-4:6379 cl-node-5:6379 cl-node-6:6379 \
  --cluster-replicas 1 --cluster-yes

docker exec -it cl-node-1 redis-cli CLUSTER NODES
docker exec -it cl-node-1 redis-cli CLUSTER SLOTS

# Connect in cluster mode (-c follows MOVED redirects automatically)
docker exec -it cl-node-1 redis-cli -c -p 6379
> SET foo bar                       # might redirect to another node
> SET {user:123}:profile "..."      # hash tag pins to one slot
> SET {user:123}:cart "..."         # same slot → multi-key ops work
> MGET {user:123}:profile {user:123}:cart
```

**Config:** [`docker-compose.cluster.yml`](docker-compose.cluster.yml).

---

### 35. ACL — fine-grained users + permissions

> 💡 **Imagine:** Your "bidder" service account accidentally runs `FLUSHALL`. Production data — gone. **With ACL**, that user wouldn't have had `FLUSHALL` permission. Crisis prevented.

**Example ACL file:**
```
user bidder on >password ~auction:* ~bids:* +get +hgetall +zadd +publish
user worker on >password ~* +@all -@dangerous
user admin  on >password ~* &* +@all
```

```bash
redis-cli -a password --user bidder
> SET auction:1 "ok"     # OK — matches ~auction:*
> FLUSHDB
(error) NOPERM this user has no permissions to access this command
> KEYS *
(error) NOPERM …
```

**Config:** [`ops/users.acl`](ops/users.acl).

---

### 36. TLS — encryption in transit

> 💡 **Imagine:** Your Redis listens on port 6379 over the public internet (or even a shared cloud VPC). Every command, including `AUTH password`, is **plaintext on the wire**. Anyone sniffing your network sees passwords and data.
>
> **With TLS:** clients connect via TLS-encrypted port, present a CA-signed cert. Eavesdroppers see nothing. Standard practice for production Redis.

**Setup:**
```bash
redis-server \
  --tls-port 6380 --port 0 \
  --tls-cert-file ./cert.pem \
  --tls-key-file ./key.pem \
  --tls-ca-cert-file ./ca.pem
```

```js
// ioredis side
new Redis({ tls: { ca: fs.readFileSync('ca.pem') } });
```

Walkthrough in [`docs/HA-AND-MODULES.md`](docs/HA-AND-MODULES.md).

---

## Modules (RedisJSON + RediSearch)

The base image is `redis:7-alpine` (no modules). To play with modules, run the `redis-stack` profile (binds to host port `6385`):

```bash
docker compose -f docker-compose.yml -f docker-compose.ha.yml --profile stack up -d redis-stack
docker exec -it redis-auction-stack redis-cli -p 6379
```

### 37. RedisJSON

> 💡 **Imagine:** Your car has nested data — `{specs: {engine: {...}, exterior: {...}}, tags: [...]}`. With a hash you'd flatten everything; with a STRING+JSON you'd parse the whole blob to read one field.
>
> **With RedisJSON:** `JSON.GET car:1 $.specs.engine.horsepower` — pluck one nested value. `JSON.NUMINCRBY car:1 $.price 250` — atomic update of a nested field. **It's MongoDB-style document storage at Redis speed.**

```bash
> JSON.SET car:1 $ '{"year":2022,"make":"Toyota","model":"Corolla","price":18000,"tags":["hybrid","family"]}'
> JSON.GET car:1 $.make                # ["Toyota"]
> JSON.GET car:1 $.tags                # [["hybrid","family"]]
> JSON.NUMINCRBY car:1 $.price 250     # [18250]
> JSON.ARRAPPEND car:1 $.tags '"electric"'
> JSON.DEL car:1 $.tags[0]
> JSON.OBJKEYS car:1 $                 # ["year","make","model","price","tags"]
```

---

### 38. RediSearch

> 💡 **Imagine:** You need full-text search across car titles, faceted filters on make + price range, sortable results. **Without RediSearch:** install Elasticsearch (and JVM, and ingest pipeline, and sync layer between Redis and ES). **With RediSearch:** one command to define an index, one to query.

```bash
# Define an index over RedisJSON documents
> FT.CREATE cars-idx ON JSON PREFIX 1 car: SCHEMA
    $.make AS make TAG
    $.model AS model TEXT
    $.price AS price NUMERIC SORTABLE

# Full-text + filter + sort
> FT.SEARCH cars-idx '@make:{Toyota}' SORTBY price DESC
> FT.SEARCH cars-idx 'Civic' RETURN 2 make price
> FT.SEARCH cars-idx '@price:[15000 25000]'    # price range
> FT.AGGREGATE cars-idx '*' GROUPBY 1 @make REDUCE COUNT 0 AS count
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
| Fill maxmemory with junk keys | `allkeys-lru` eviction kicks in — watch which keys go first |

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
| `POST` | `/auctions/:id/bids` | 3, 4, 14, 17 |
| `GET` | `/auctions/:id/bids` | 3 |
| `GET` | `/leaderboard/hot` | 9 |
| `GET` | `/leaderboard/auctions/:id/stats` (cache-aside) | 9, 14 |
| `GET` | `/ops/slowlog` | 31 |
| `GET` | `/ops/latency` | 31 |
| `GET` | `/ops/memory?key=...` | 31 |
| `GET` | `/ops/object/:key` | 7 |
| `GET` | `/ops/clients` | 31 |
| `GET` | `/ops/sort/recent` (SORT BY/GET) | 20 |
| `GET` | `/ops/queues` (LLEN) | 19 |
| `GET` | `/ops/analytics` (consumer group output) | 24 |
| `GET` | `/ops/functions/:id` (FCALL) | 22 |

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
│   └── src/
│       ├── config/redis.ts         # ← 4 separate connections
│       ├── redis/                  # All Redis logic, isolated per concept
│       │   ├── keys.ts             # ← single source of truth for key naming
│       │   ├── auctionRepo.ts      # Hashes + TTL + SCAN + pipeline
│       │   ├── bidRepo.ts          # ZSET + MULTI/WATCH
│       │   ├── bidLua.ts           # Lua atomic bid
│       │   ├── cache.ts            # Cache-aside + single-flight
│       │   ├── engagement.ts       # Lists + INCR + Bitmaps + BITFIELD + EXPIREAT
│       │   ├── functions.ts        # Redis Functions library
│       │   ├── geo.ts              # GEOADD + GEOSEARCH
│       │   ├── index_make.ts       # Sets as secondary indexes
│       │   ├── leaderboard.ts      # ZSET + HyperLogLog
│       │   ├── locks.ts            # SET NX EX + Lua release
│       │   ├── presence.ts         # Sets
│       │   ├── pubsub.ts
│       │   ├── queue.ts            # LMOVE reliable queue
│       │   ├── rateLimit.ts        # Lua sliding-window
│       │   └── streams.ts          # XADD + XRANGE
│       ├── lua/{placeBid,rateLimit}.lua
│       ├── workers/
│       │   ├── expiryWorker.ts     # keyspace notif + lock
│       │   ├── analyticsWorker.ts  # XGROUP + XREADGROUP + XACK
│       │   └── notifyWorker.ts     # BLMOVE drain + ACK
│       ├── routes/{auctions,bids,leaderboard,ops,health}.ts
│       └── sockets/auctionSocket.ts
│
├── web/                            # Angular 20 (standalone, signals)
│   └── src/app/
│       ├── core/{api,socket}.service.ts
│       └── features/{auction-list,auction-detail,create-auction}/
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
