-- A tier, streak or team group that the clock will not pay by itself (a failed row or a re-issue chain) while it is still underpaid: an admin has to look. One row per group, removed when the group is whole.
CREATE TABLE IF NOT EXISTS period_block (
  company_id TEXT NOT NULL, person_id TEXT NOT NULL, group_key TEXT NOT NULL, kind TEXT NOT NULL, period_key TEXT,
  entitled INTEGER NOT NULL, paid INTEGER NOT NULL, since INTEGER NOT NULL,
  PRIMARY KEY (person_id, group_key)
);
