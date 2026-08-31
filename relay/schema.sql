-- Starling relay storage. Ciphertext and pinned member keys only; every row
-- carries a server timestamp (srv) so the TTL sweep can expire it.

CREATE TABLE IF NOT EXISTS members (
  channel TEXT NOT NULL,
  member  TEXT NOT NULL,
  alg     TEXT NOT NULL,
  pk      TEXT NOT NULL,
  last_ts INTEGER NOT NULL,
  srv     INTEGER NOT NULL,
  PRIMARY KEY (channel, member)
);

CREATE TABLE IF NOT EXISTS points (
  channel TEXT NOT NULL,
  member  TEXT NOT NULL,
  ts      INTEGER NOT NULL,
  srv     INTEGER NOT NULL,
  n       TEXT NOT NULL,
  c       TEXT NOT NULL,
  PRIMARY KEY (channel, member, ts)
);

CREATE INDEX IF NOT EXISTS idx_points_srv ON points (srv);
CREATE INDEX IF NOT EXISTS idx_members_srv ON members (srv);
