-- Starling relay storage. Ciphertext, pinned member keys, and the signature
-- each point was posted with; every row carries a server timestamp (srv) so
-- the TTL sweep can expire it.
--
-- The _v2 suffix is a migration, not decoration. deploy.sh runs this file on
-- every deploy, and SQLite has no "ADD COLUMN IF NOT EXISTS", so a schema
-- change that alters existing tables cannot be expressed idempotently under
-- the old names. Fresh names plus a drop of the old ones is idempotent in
-- both directions: the second deploy creates nothing and drops nothing.
--
-- v2 changed two things: points carry sig (receivers verify signatures now,
-- rather than trusting the relay to have checked them), and member ids are
-- 32 hex chars instead of 16. Nothing is lost that was not expiring anyway;
-- every row here has a 24 hour life and members re-post within seconds.

CREATE TABLE IF NOT EXISTS members_v2 (
  channel TEXT NOT NULL,
  member  TEXT NOT NULL,
  alg     TEXT NOT NULL,
  pk      TEXT NOT NULL,
  last_ts INTEGER NOT NULL,
  srv     INTEGER NOT NULL,
  PRIMARY KEY (channel, member)
);

CREATE TABLE IF NOT EXISTS points_v2 (
  channel TEXT NOT NULL,
  member  TEXT NOT NULL,
  ts      INTEGER NOT NULL,
  srv     INTEGER NOT NULL,
  n       TEXT NOT NULL,
  c       TEXT NOT NULL,
  sig     TEXT NOT NULL,
  PRIMARY KEY (channel, member, ts)
);

CREATE INDEX IF NOT EXISTS idx_points_v2_srv ON points_v2 (srv);
CREATE INDEX IF NOT EXISTS idx_members_v2_srv ON members_v2 (srv);

DROP TABLE IF EXISTS points;
DROP TABLE IF EXISTS members;
