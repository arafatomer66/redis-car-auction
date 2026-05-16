-- Pivot to car auction: add structured vehicle columns.
ALTER TABLE auctions
  ADD COLUMN IF NOT EXISTS year         INT,
  ADD COLUMN IF NOT EXISTS make         TEXT,
  ADD COLUMN IF NOT EXISTS model        TEXT,
  ADD COLUMN IF NOT EXISTS trim         TEXT,
  ADD COLUMN IF NOT EXISTS mileage      INT,
  ADD COLUMN IF NOT EXISTS transmission TEXT,
  ADD COLUMN IF NOT EXISTS fuel         TEXT,
  ADD COLUMN IF NOT EXISTS exterior     TEXT,
  ADD COLUMN IF NOT EXISTS location     TEXT;
