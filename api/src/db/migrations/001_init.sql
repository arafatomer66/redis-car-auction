-- Cold storage: completed auctions and users for history/audit.
-- Live state lives in Redis (hashes, sorted sets, etc).

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS auctions (
  id            TEXT PRIMARY KEY,
  seller_id     TEXT NOT NULL REFERENCES users(id),
  title         TEXT NOT NULL,
  description   TEXT,
  image_url     TEXT,
  start_price   NUMERIC(12, 2) NOT NULL,
  min_increment NUMERIC(12, 2) NOT NULL DEFAULT 1,
  ends_at       TIMESTAMPTZ NOT NULL,
  status        TEXT NOT NULL DEFAULT 'live',
  winner_id     TEXT REFERENCES users(id),
  final_price   NUMERIC(12, 2),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at     TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS bids (
  id            TEXT PRIMARY KEY,
  auction_id    TEXT NOT NULL REFERENCES auctions(id),
  bidder_id     TEXT NOT NULL REFERENCES users(id),
  amount        NUMERIC(12, 2) NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bids_auction ON bids(auction_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_auctions_status ON auctions(status, ends_at);

INSERT INTO users (id, name) VALUES
  ('demo-alice', 'Alice'),
  ('demo-bob',   'Bob'),
  ('demo-carol', 'Carol')
ON CONFLICT (id) DO NOTHING;
