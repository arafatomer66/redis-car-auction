// Centralized Redis key schema — the single source of truth for key naming.
// Keeping this in one place avoids typos and makes it easy to audit storage.

export const keys = {
  // Hash — auction state (title, currentPrice, endsAt, sellerId, status)
  auction: (id: string) => `auction:${id}`,

  // Sorted Set — bids for an auction, score = bid amount, member = bidId
  bids: (auctionId: string) => `bids:${auctionId}`,

  // Hash — per-bid detail (bidderId, amount, ts) keyed by bidId
  bid: (bidId: string) => `bid:${bidId}`,

  // Set — userIds currently watching an auction
  watchers: (auctionId: string) => `watchers:${auctionId}`,

  // Sorted Set — global "hottest auctions" by activity score
  hotAuctions: () => `hot:auctions`,

  // HyperLogLog — unique bidders per auction
  uniqueBidders: (auctionId: string) => `unique:bidders:${auctionId}`,

  // Stream — append-only audit log of every bid placed
  auditStream: () => `audit:bids`,

  // Stream — per-user notification feed (outbid, won, etc.)
  notifications: (userId: string) => `notifications:${userId}`,

  // String — distributed lock for closing an auction
  closeLock: (auctionId: string) => `lock:close:${auctionId}`,

  // String — mirror of auction TTL so keyspace notification can identify it
  // (we listen on __keyevent@0__:expired and parse the key)
  expiryMarker: (auctionId: string) => `expire:auction:${auctionId}`,

  // Pub/Sub channels
  channel: {
    bid: (auctionId: string) => `ch:bid:${auctionId}`,
    closed: (auctionId: string) => `ch:closed:${auctionId}`,
  },

  // Phase 13 — engagement
  recentlyViewed: (userId: string) => `recent:${userId}`,          // LIST
  viewCounter: (auctionId: string) => `views:${auctionId}`,         // STRING (INCR)
  dailyActive: (yyyymmdd: string) => `dau:${yyyymmdd}`,             // BITMAP
  userBit: (userId: string) => `userbit:${userId}`,                 // STRING for BITFIELD demo

  // Phase 14 — cache + rate limit
  cacheStats: (auctionId: string) => `cache:stats:${auctionId}`,
  cacheStatsLock: (auctionId: string) => `cache:lock:stats:${auctionId}`,
  rateLimit: (userId: string) => `rl:bids:${userId}`,

  // Phase 16 — reliable queue
  notifyQueue: () => `q:notify`,                                    // LIST
  notifyProcessing: () => `q:notify:processing`,                    // LIST (LMOVE target)
} as const;
