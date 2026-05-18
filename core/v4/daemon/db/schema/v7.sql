-- v7 — v4.6 Phase 3b: self-improvement loop foundation.
--
-- Adds two tables that durably persist what the existing in-memory
-- TCE / `RecoveryReport` flow only ever knew transiently. Pre-v7,
-- `buildRecoveryReport()` produced a rich diagnostic object that was
-- rendered into a capability card once, then garbage-collected at
-- turn-end. Operators had no way to ask "which tool fails on me most
-- often?" — the data existed only inside one turn's memory.
--
-- After v7:
--
--   * `failure_signatures` — one row per (tool_name, failure_category,
--     args_hash) tuple. Same failure observed many times across many
--     turns collapses into one signature row whose `occurrences`
--     column increments. Operator queries like "which signatures
--     have the highest recovered/occurrences ratio?" become trivial.
--
--   * `recovery_reports` — one row per observed failure → success
--     transition. Records WHICH signature was recovered, WHAT strategy
--     worked (free-text the TCE write-through path supplies),
--     and the WHEN/WHO context for downstream operator review.
--
-- Both tables are operator-facing (queryable via `/recovery list/show`
-- in REPL). Plugin authors in v4.7+ will query them too — the data
-- transport intentionally lives in SQLite, not in a transient hook
-- payload, so plugins can join across runs/sessions/time windows.
--
-- Schema notes:
--
--   * `signature` is the canonical grouping key — `tool_name:category[:args_hash]`.
--     UNIQUE constraint guarantees one row per logical failure shape.
--   * `args_hash` is OPTIONAL — short prefix of a normalized-args SHA256.
--     When the caller can't / won't supply args, the signature collapses
--     to `tool_name:category` only and the column stays NULL.
--   * `last_recovery_report_id` is a forward reference (recovery_reports
--     doesn't exist yet at DDL parse time, but SQLite tolerates this for
--     INTEGER columns; FK enforcement on this column is best-effort).
--   * `recovery_reports.signature_id` IS a real FK — recovery rows
--     without a signature would be operationally useless.
--   * Indexes pick the two most common read paths: lookup by signature
--     (write hot path) and lookup by tool_name (operator "what fails
--     most for tool X?" query).
--
-- Retention: no automatic cleanup in v4.6. A future maintenance pass
-- can decay old signatures (`last_seen_at < now - 90d AND occurrences
-- < 3`). The recovery_reports table grows linearly with recoveries
-- observed; at fanout-cap=5 children × N turns × low recovery rate,
-- table stays well under a million rows for any realistic deployment.

CREATE TABLE IF NOT EXISTS failure_signatures (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  signature                TEXT    UNIQUE NOT NULL,
  tool_name                TEXT    NOT NULL,
  failure_category         TEXT    NOT NULL,
  args_hash                TEXT,
  first_seen_at            INTEGER NOT NULL,
  last_seen_at             INTEGER NOT NULL,
  occurrences              INTEGER NOT NULL DEFAULT 1,
  recovered_count          INTEGER NOT NULL DEFAULT 0,
  last_recovery_report_id  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_failure_signatures_signature
  ON failure_signatures(signature);

CREATE INDEX IF NOT EXISTS idx_failure_signatures_tool
  ON failure_signatures(tool_name);

CREATE TABLE IF NOT EXISTS recovery_reports (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  signature_id          INTEGER NOT NULL REFERENCES failure_signatures(id),
  run_id                INTEGER REFERENCES runs(id),
  session_id            TEXT,
  failed_attempts       INTEGER NOT NULL,
  successful_strategy   TEXT    NOT NULL,
  changed_parameters    TEXT,
  verification          TEXT,
  created_at            INTEGER NOT NULL,
  notes                 TEXT
);

CREATE INDEX IF NOT EXISTS idx_recovery_reports_signature
  ON recovery_reports(signature_id);

CREATE INDEX IF NOT EXISTS idx_recovery_reports_run
  ON recovery_reports(run_id);
