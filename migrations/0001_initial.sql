-- ============================================================================
-- CIP - STRIKE COCKPIT : CLOUDFLARE D1 INITIAL SCHEMA (migration 0001)
-- ============================================================================
-- Derived field-by-field from the application's own sanitization layer
-- (blankState(), sanitizeProspect(), sanitizeState() in index.html):
--
--   state = { settings, prospects[], events[], learnings[], strike, metadata }
--
-- Design decisions (each traceable to real application behavior):
--
--  * prospects: EVERY field of sanitizeProspect() is flattened into a real
--    SQL column (genuinely relational, directly queryable). Unknown or
--    future fields survive verbatim in extra_json, so future app versions
--    never lose data (and imports never discard information).
--
--  * events: first-class durable history records, exactly as in the app.
--    The application counts events for analytics even when the referenced
--    prospect no longer exists, and restore/import may legitimately carry
--    events whose prospect is not present - therefore events.prospect_id
--    deliberately has NO foreign key constraint. It is indexed instead.
--    Event timestamps are stored as the exact ISO strings the application
--    compares lexicographically; storing them as numbers would change
--    the app's string-comparison semantics.
--
--  * Duplicate protection: the application rejects duplicate DOMAINS at
--    add time (findDup), but accepts same-domain records arriving through
--    restore/import of hand-edited backups. To stay compatible with data
--    the application itself accepts, domain is INDEXED but NOT unique;
--    the Worker reinforces the duplicate check as a diagnostic warning.
--
--  * Single-row tables (settings, strike, app_metadata, sync_state) enforce
--    id = 1. strike membership is the app's ordered ids array; the order
--    drives the batch workflow, so it is preserved verbatim in ids_json
--    (nothing in the application ever queries members independently).
--
--  * sync_gen: lightweight optimistic-concurrency version column
--    (prevents lost updates / stale overwrites). The Worker bumps the
--    global generation in sync_state on every applied sync batch and
--    stamps written rows; clients send their last-known generation and
--    guarded upserts are skipped (and reported as conflicts) when the
--    stored row is newer than what the client based its edit on.
--
--  * Indexes (only ones with a real application query pattern):
--      prospects(domain)          duplicate-protection lookups
--      prospects(outreach_status) queue/status filtering (phase machine)
--      prospects(outreach_next_fu_date) follow-up / due queue retrieval
--      prospects(updated_at)      queue recency ordering
--      events(prospect_id)        timeline / per-prospect analytics
--      events(type, subtype)      metric counting (DELIVERED, REPLIES, ...)
--      events(timestamp)          day/week/month/year analytics ranges
--    learnings are only ever read in full at bootstrap - no index needed.
--
--  * All statements are idempotent (IF NOT EXISTS / OR IGNORE) so the file
--    is safe to paste into the D1 dashboard console more than once and is
--    reproducible on a fresh database. No destructive statements.
-- ============================================================================

CREATE TABLE IF NOT EXISTS prospects (
  id                              TEXT PRIMARY KEY,
  website                         TEXT NOT NULL DEFAULT '',
  domain                          TEXT NOT NULL DEFAULT '',
  company_name                    TEXT NOT NULL DEFAULT '',
  company_niche                   TEXT NOT NULL DEFAULT '',
  company_source                  TEXT NOT NULL DEFAULT '',
  company_ad_url                  TEXT NOT NULL DEFAULT '',
  company_ad_discovery_date       TEXT NOT NULL DEFAULT '',
  company_ad_launch_date          TEXT NOT NULL DEFAULT '',
  contact_name                    TEXT NOT NULL DEFAULT '',
  contact_role                    TEXT NOT NULL DEFAULT '',
  contact_email                   TEXT NOT NULL DEFAULT '',
  contact_linkedin                TEXT NOT NULL DEFAULT '',
  contact_phone                   TEXT NOT NULL DEFAULT '',
  testing_status                  TEXT NOT NULL DEFAULT 'not_tested',
  testing_qualification           TEXT NOT NULL DEFAULT '',
  testing_tested_at               TEXT NOT NULL DEFAULT '',
  testing_note                    TEXT NOT NULL DEFAULT '',
  strike_ad_source                TEXT NOT NULL DEFAULT '',
  strike_active_ad                TEXT NOT NULL DEFAULT '',
  strike_ad_age                   TEXT NOT NULL DEFAULT '',
  strike_visible_leak             TEXT NOT NULL DEFAULT '',
  strike_leak1                    TEXT NOT NULL DEFAULT '',
  strike_leak2                    TEXT NOT NULL DEFAULT '',
  strike_loom_url                 TEXT NOT NULL DEFAULT '',
  strike_video_status             TEXT NOT NULL DEFAULT 'not_started',
  strike_xray_started_at          TEXT,
  outreach_status                 TEXT NOT NULL DEFAULT 'NEW',
  outreach_first_date             TEXT NOT NULL DEFAULT '',
  outreach_last_date              TEXT NOT NULL DEFAULT '',
  outreach_next_fu_date           TEXT NOT NULL DEFAULT '',
  outreach_touches                INTEGER NOT NULL DEFAULT 0,
  outreach_channels               TEXT NOT NULL DEFAULT '[]',
  commercial_deal_value           REAL NOT NULL DEFAULT 0,
  commercial_won_date             TEXT NOT NULL DEFAULT '',
  economics_direct_cost           REAL NOT NULL DEFAULT 0,
  economics_research_minutes      REAL NOT NULL DEFAULT 0,
  economics_audit_minutes         REAL NOT NULL DEFAULT 0,
  economics_xray_minutes          REAL NOT NULL DEFAULT 0,
  economics_followup_minutes      REAL NOT NULL DEFAULT 0,
  notes                           TEXT NOT NULL DEFAULT '',
  created_at                      TEXT NOT NULL DEFAULT '',
  updated_at                      TEXT NOT NULL DEFAULT '',
  extra_json                      TEXT NOT NULL DEFAULT '{}',
  sync_gen                        INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_prospects_domain  ON prospects(domain);
CREATE INDEX IF NOT EXISTS idx_prospects_status  ON prospects(outreach_status);
CREATE INDEX IF NOT EXISTS idx_prospects_next_fu ON prospects(outreach_next_fu_date);
CREATE INDEX IF NOT EXISTS idx_prospects_updated ON prospects(updated_at);

-- ---------------------------------------------------------------------------
-- Durable workflow history. prospect_id may reference a prospect that is not
-- present (the application preserves such events); NO foreign key on purpose.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
  id           TEXT PRIMARY KEY,
  prospect_id  TEXT,
  type         TEXT NOT NULL DEFAULT '',
  subtype      TEXT NOT NULL DEFAULT '',
  timestamp    TEXT NOT NULL DEFAULT '',
  value        REAL,
  note         TEXT NOT NULL DEFAULT '',
  channel      TEXT NOT NULL DEFAULT '',
  ref_id       TEXT,
  sync_gen     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_events_prospect ON events(prospect_id);
CREATE INDEX IF NOT EXISTS idx_events_type     ON events(type, subtype);
CREATE INDEX IF NOT EXISTS idx_events_ts       ON events(timestamp);

CREATE TABLE IF NOT EXISTS learnings (
  id          TEXT PRIMARY KEY,
  text        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT '',
  sync_gen    INTEGER NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------------
-- Singleton rows (id is pinned to 1). Initial values equal the application's
-- blankState() defaults.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  id                   INTEGER PRIMARY KEY CHECK (id = 1),
  strike_goal          INTEGER NOT NULL DEFAULT 5,
  fu1                  INTEGER NOT NULL DEFAULT 3,
  fu2                  INTEGER NOT NULL DEFAULT 4,
  fu3                  INTEGER NOT NULL DEFAULT 7,
  currency             TEXT NOT NULL DEFAULT 'USD',
  global_tool_cost     REAL NOT NULL DEFAULT 0,
  global_outreach_cost REAL NOT NULL DEFAULT 0,
  global_other_cost    REAL NOT NULL DEFAULT 0,
  hourly_cost          REAL NOT NULL DEFAULT 0,
  extra_json           TEXT NOT NULL DEFAULT '{}',
  updated_at           TEXT NOT NULL DEFAULT '',
  sync_gen             INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS strike (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  date        TEXT NOT NULL DEFAULT '',
  locked      INTEGER NOT NULL DEFAULT 0,
  goal        INTEGER NOT NULL DEFAULT 0,
  ids_json    TEXT NOT NULL DEFAULT '[]',
  updated_at  TEXT NOT NULL DEFAULT '',
  sync_gen    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS app_metadata (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  created_at          TEXT NOT NULL DEFAULT '',
  last_backup         TEXT,
  last_backup_events  INTEGER NOT NULL DEFAULT 0,
  version             INTEGER NOT NULL DEFAULT 2,
  onboarding_complete INTEGER NOT NULL DEFAULT 0,
  extra_json          TEXT NOT NULL DEFAULT '{}',
  updated_at          TEXT NOT NULL DEFAULT '',
  sync_gen            INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sync_state (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  gen         INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL DEFAULT ''
);

INSERT OR IGNORE INTO settings (id) VALUES (1);
INSERT OR IGNORE INTO strike (id) VALUES (1);
INSERT OR IGNORE INTO app_metadata (id, version) VALUES (1, 2);
INSERT OR IGNORE INTO sync_state (id, gen) VALUES (1, 0);
