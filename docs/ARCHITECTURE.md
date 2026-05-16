# Architecture

## High-level

```mermaid
flowchart LR
  subgraph Browser
    A[Angular SPA]
  end

  A -->|REST| API[Express API]
  A <-->|Socket.IO| API

  API <-->|commands| R[(Redis 7)]
  API <-->|SQL| P[(Postgres 16)]

  W[Expiry Worker] -.subscribes.-> R
  W -->|SQL writes| P
```

Live state (auctions, bids, watchers, leaderboards, notifications) lives in **Redis**.
Permanent record (history, audit) lives in **Postgres**.

## Place a bid (Phase 4: Lua atomic)

```mermaid
sequenceDiagram
  participant U as Angular
  participant API as Express
  participant R as Redis
  participant SUB as Socket.IO room

  U->>API: POST /auctions/{id}/bids {amount}
  API->>R: EVALSHA placeBid.lua
  Note over R: validate + ZADD + HSET<br/>+ extend TTL (anti-snipe)
  R-->>API: {ok, newPrice, bidCount, endsAt, extended}
  API->>R: PUBLISH ch:bid:{id} {evt}
  API->>R: XADD audit:bids ...
  API->>R: XADD notifications:{outbidUser} ...
  API->>R: ZINCRBY hot:auctions {id}
  API->>R: PFADD unique:bidders:{id} {bidderId}
  R-->>SUB: pub/sub message (via Socket.IO adapter)
  SUB-->>U: socket.emit('bid', evt)  ← every watcher
  API-->>U: 201 {ok, ...}
```

## Auto-close on expiry (Phase 8)

```mermaid
sequenceDiagram
  participant R as Redis
  participant W as Expiry Worker
  participant P as Postgres
  participant SUB as Socket.IO

  Note over R: TTL on expire:auction:{id} hits zero
  R--xW: __keyevent@0__:expired = "expire:auction:{id}"
  W->>R: SET lock:close:{id} {token} NX EX 10
  alt lock acquired
    W->>R: HGETALL auction:{id}
    W->>R: HSET status=closed
    W->>P: UPDATE auctions SET status, winner, final_price
    W->>R: PUBLISH ch:closed:{id} {winner, price}
    W->>R: XADD notifications:{winner} type=won ...
    W->>R: DEL lock:close:{id} (Lua compare-and-delete)
    R-->>SUB: ch:closed fanout
  else lock NOT acquired
    Note over W: another worker is handling it; skip
  end
```

## Presence (Phase 6)

```mermaid
sequenceDiagram
  participant U as Angular
  participant S as Socket.IO
  participant R as Redis

  U->>S: socket.emit('watch', auctionId)
  S->>R: SADD watchers:{id} {userId}
  S->>R: SCARD watchers:{id}
  S->>S: io.to('auction:{id}').emit('presence', {watchers})
  Note over U: when tab closes
  U--xS: disconnect
  S->>R: SREM watchers:{id} {userId}
  S->>S: emit 'presence' update
```
