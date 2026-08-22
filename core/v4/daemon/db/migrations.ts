/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/daemon/db/migrations.ts — v4.5 Phase 1: schema migration runner.
 *
 * Version-tracked. Idempotent. Each migration is a string of DDL
 * statements (CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS)
 * wrapped in a transaction. The runner reads the current version
 * from `schema_version` and applies every migration with a higher
 * version number.
 *
 * Phase 1 ships v1 (`v1.sql`). Future phases append migrations:
 *
 *   const MIGRATIONS: ReadonlyArray<Migration> = [
 *     { version: 1, name: 'phase 1 — daemon foundation', sql: V1_SQL },
 *     { version: 2, name: 'phase 2 — file watcher trigger', sql: V2_SQL },
 *     ...
 *   ];
 */

import type Database from 'better-sqlite3';

// Embedded v1 schema. Source of truth lives at
// `core/v4/daemon/db/schema/v1.sql` — kept in sync via the
// `tests/v4/daemon/db/migrations.test.ts` snapshot check.
const V1_SQL = `
CREATE TABLE IF NOT EXISTS schema_version (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  version         INTEGER NOT NULL,
  applied_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS daemon_instances (
  instance_id     TEXT PRIMARY KEY,
  pid             INTEGER NOT NULL,
  hostname        TEXT NOT NULL,
  started_at      INTEGER NOT NULL,
  last_heartbeat  INTEGER NOT NULL,
  shutdown_at     INTEGER,
  shutdown_reason TEXT,
  exit_code       INTEGER,
  version         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_daemon_instances_alive
  ON daemon_instances(shutdown_at) WHERE shutdown_at IS NULL;

CREATE TABLE IF NOT EXISTS runs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger_event_id INTEGER,
  session_id       TEXT NOT NULL,
  instance_id      TEXT NOT NULL,
  status           TEXT NOT NULL,
  finish_reason    TEXT,
  started_at       INTEGER NOT NULL,
  completed_at     INTEGER,
  resume_pending   INTEGER NOT NULL DEFAULT 0,
  resume_reason    TEXT,
  FOREIGN KEY (instance_id) REFERENCES daemon_instances(instance_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id, started_at);
CREATE INDEX IF NOT EXISTS idx_runs_active
  ON runs(status) WHERE status IN ('queued','running');

CREATE TABLE IF NOT EXISTS trigger_events (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  source            TEXT NOT NULL,
  source_key        TEXT NOT NULL,
  idempotency_key   TEXT,
  payload_json      TEXT NOT NULL,
  status            TEXT NOT NULL,
  attempts          INTEGER NOT NULL DEFAULT 0,
  claim_owner       TEXT,
  claim_expires_at  INTEGER,
  last_error        TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  completed_at      INTEGER,
  run_id            INTEGER,
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_trigger_events_idem
  ON trigger_events(source, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_trigger_events_pending
  ON trigger_events(status, created_at) WHERE status IN ('pending','claimed');
CREATE INDEX IF NOT EXISTS idx_trigger_events_claim_expiry
  ON trigger_events(claim_expires_at) WHERE status = 'claimed';

CREATE TABLE IF NOT EXISTS run_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      INTEGER NOT NULL,
  ts          INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  payload     TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_run_events_run ON run_events(run_id, ts);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  scope           TEXT NOT NULL,
  key             TEXT NOT NULL,
  fingerprint     TEXT,
  response_json   TEXT NOT NULL,
  status_code     INTEGER NOT NULL DEFAULT 200,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  PRIMARY KEY (scope, key)
);
CREATE INDEX IF NOT EXISTS idx_idem_expiry ON idempotency_keys(expires_at);

CREATE TABLE IF NOT EXISTS crash_reports (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id         TEXT NOT NULL,
  detected_at         INTEGER NOT NULL,
  prev_started_at     INTEGER,
  prev_last_heartbeat INTEGER,
  prev_pid            INTEGER,
  affected_sessions   TEXT NOT NULL,
  ps_snapshot         TEXT,
  details             TEXT NOT NULL,
  FOREIGN KEY (instance_id) REFERENCES daemon_instances(instance_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS restart_failure_counts (
  session_id      TEXT PRIMARY KEY,
  count           INTEGER NOT NULL,
  last_failure    INTEGER NOT NULL,
  auto_suspended  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS triggers (
  id              TEXT PRIMARY KEY,
  source          TEXT NOT NULL,
  name            TEXT NOT NULL,
  spec_json       TEXT NOT NULL,
  enabled         INTEGER NOT NULL DEFAULT 1,
  fire_rate_limit INTEGER,
  prompt_template TEXT,
  deliver_only    INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_triggers_source_enabled ON triggers(source, enabled);
`;

// v4.5 Phase 2 — file_observations table. Source of truth lives at
// `core/v4/daemon/db/schema/v2.sql`; kept in sync via the migrations
// test snapshot check.
const V2_SQL = `
CREATE TABLE IF NOT EXISTS file_observations (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  watcher_id          TEXT    NOT NULL,
  abs_path            TEXT    NOT NULL,
  file_key            TEXT    NOT NULL DEFAULT '',
  size                INTEGER,
  mtime_ms            INTEGER NOT NULL,
  content_hash        TEXT,
  last_event_type     TEXT,
  last_seen_at        INTEGER NOT NULL,
  last_processed_at   INTEGER,
  last_event_id       INTEGER,
  last_status         TEXT    NOT NULL DEFAULT 'pending',
  coalesced_count     INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (watcher_id)   REFERENCES triggers(id)        ON DELETE CASCADE,
  FOREIGN KEY (last_event_id) REFERENCES trigger_events(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_file_obs_watcher_path
  ON file_observations(watcher_id, abs_path);
CREATE INDEX IF NOT EXISTS idx_file_obs_last_seen
  ON file_observations(last_seen_at);
CREATE INDEX IF NOT EXISTS idx_file_obs_pending
  ON file_observations(watcher_id, last_status) WHERE last_status = 'pending';
`;

export interface Migration {
  version: number;
  name:    string;
  sql?:    string;
  apply?:  (db: Database.Database) => void;
}

// v4.5 Phase 3 — webhook_deliveries log.
const V3_SQL = `
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  route_id            TEXT    NOT NULL,
  delivery_id         TEXT,
  signature_verified  INTEGER NOT NULL,
  status_code         INTEGER NOT NULL,
  response_body       TEXT,
  client_ip           TEXT,
  headers_json        TEXT,
  body_hash           TEXT    NOT NULL,
  received_at         INTEGER NOT NULL,
  processed_at        INTEGER,
  trigger_event_id    INTEGER,
  FOREIGN KEY (route_id)         REFERENCES triggers(id)        ON DELETE CASCADE,
  FOREIGN KEY (trigger_event_id) REFERENCES trigger_events(id)  ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_route_time
  ON webhook_deliveries(route_id, received_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_deliveries_delivery
  ON webhook_deliveries(route_id, delivery_id) WHERE delivery_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_received
  ON webhook_deliveries(received_at);
`;

// v4.5 Phase 4a — email_seen forensic table.
const V4_SQL = `
CREATE TABLE IF NOT EXISTS email_seen (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  route_id            TEXT    NOT NULL,
  mailbox             TEXT    NOT NULL,
  uid_validity        INTEGER NOT NULL,
  uid                 INTEGER NOT NULL,
  message_id          TEXT,
  from_address        TEXT,
  subject             TEXT,
  received_at         INTEGER NOT NULL,
  processed_at        INTEGER,
  trigger_event_id    INTEGER,
  status              TEXT    NOT NULL,
  FOREIGN KEY (route_id)         REFERENCES triggers(id)        ON DELETE CASCADE,
  FOREIGN KEY (trigger_event_id) REFERENCES trigger_events(id)  ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_seen_route_uid
  ON email_seen(route_id, uid_validity, uid);
CREATE INDEX IF NOT EXISTS idx_email_seen_received
  ON email_seen(received_at);
CREATE INDEX IF NOT EXISTS idx_email_seen_message_id
  ON email_seen(message_id) WHERE message_id IS NOT NULL;
`;

// v4.5 Phase 5b — scheduled_workflows table (cron migration from JSON
// to SQLite). One-shot data migration from `cron_jobs.json` runs from
// the daemon bootstrap after this schema applies, not from inside the
// DDL transaction itself — keeps schema-only migrations idempotent.
const V5_SQL = `
CREATE TABLE IF NOT EXISTS scheduled_workflows (
  id                  TEXT    PRIMARY KEY,
  name                TEXT    NOT NULL,
  schedule_expression TEXT    NOT NULL,
  timezone            TEXT    NOT NULL DEFAULT 'UTC',
  enabled             INTEGER NOT NULL DEFAULT 1,
  payload_json        TEXT    NOT NULL,
  prompt_template     TEXT,
  deliver_only        INTEGER NOT NULL DEFAULT 0,
  misfire_policy      TEXT    NOT NULL DEFAULT 'skip_stale',
  fire_rate_limit     INTEGER,
  catch_up_limit      INTEGER,
  grace_ms            INTEGER,
  last_fired_at       INTEGER,
  next_fire_at        INTEGER,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scheduled_workflows_next_fire
  ON scheduled_workflows(next_fire_at) WHERE enabled = 1;
CREATE INDEX IF NOT EXISTS idx_scheduled_workflows_enabled
  ON scheduled_workflows(enabled);
`;

// Embedded v6 schema. Source of truth lives at
// `core/v4/daemon/db/schema/v6.sql` (matching v1-v4 convention).
// Kept in sync via the `tests/v4/daemon/db/migrations-v6.test.ts`
// snapshot check.
const V6_SQL = `
ALTER TABLE runs ADD COLUMN spawned_from_run_id     INTEGER;
ALTER TABLE runs ADD COLUMN spawned_from_session_id TEXT;

CREATE INDEX IF NOT EXISTS idx_runs_spawned_from
  ON runs(spawned_from_run_id)
  WHERE spawned_from_run_id IS NOT NULL;
`;

// Embedded v7 schema. Source of truth at
// `core/v4/daemon/db/schema/v7.sql` (same convention). Kept in
// sync via `tests/v4/daemon/db/migrations-v7.test.ts`.
//
// v4.6 Phase 3b: self-improvement loop foundation — adds two
// tables for durable cross-session failure tracking:
//   * `failure_signatures` — one row per (tool, category, args_hash);
//     `occurrences` increments on every observed failure, so the
//     operator can `SELECT … ORDER BY occurrences DESC` to find the
//     most-stubborn failure shapes.
//   * `recovery_reports` — one row per observed failure → success
//     transition; carries the strategy that worked + verification +
//     free-text notes for operator review.
const V7_SQL = `
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
`;

// v4.9.0 Slice 4 — daemon_incarnations table. Source of truth lives at
// `core/v4/daemon/db/schema/v8.sql`; kept in sync via the migrations
// test snapshot check. Distinct from the v1 `daemon_instances` table
// (which keeps its random-UUID instance_id intact for existing
// `evaluateBootState` / `reclaimStuckRuns` consumers); v8 introduces
// the persistent daemon identity + per-boot incarnation correlation.
const V8_SQL = `
CREATE TABLE IF NOT EXISTS daemon_incarnations (
  incarnation_id  TEXT    PRIMARY KEY,
  daemon_id       TEXT    NOT NULL,
  pid             INTEGER NOT NULL,
  started_at      TEXT    NOT NULL,
  ended_at        TEXT,
  exit_reason     TEXT,
  exit_code       INTEGER,
  aiden_version   TEXT,
  node_version    TEXT
);
CREATE INDEX IF NOT EXISTS idx_incarnations_daemon
  ON daemon_incarnations(daemon_id, started_at DESC);
`;

// v4.9.0 Slice 5 — durable run queue. Source of truth lives at
// `core/v4/daemon/db/schema/v9.sql`; kept in sync via the migrations
// test snapshot check.
const V9_SQL = `
CREATE TABLE IF NOT EXISTS run_attempts (
  attempt_id     TEXT    PRIMARY KEY,
  run_id         INTEGER NOT NULL,
  attempt_number INTEGER NOT NULL,
  incarnation_id TEXT    NOT NULL,
  started_at     TEXT    NOT NULL,
  ended_at       TEXT,
  status         TEXT    NOT NULL,
  finish_reason  TEXT,
  error_class    TEXT,
  error_message  TEXT,
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_run_attempts_run
  ON run_attempts(run_id, attempt_number);
CREATE INDEX IF NOT EXISTS idx_run_attempts_incarnation
  ON run_attempts(incarnation_id);

CREATE TABLE IF NOT EXISTS spans (
  span_id        TEXT    PRIMARY KEY,
  trace_id       TEXT    NOT NULL,
  parent_span_id TEXT,
  run_id         INTEGER,
  attempt_id     TEXT,
  incarnation_id TEXT    NOT NULL,
  kind           TEXT    NOT NULL,
  name           TEXT    NOT NULL,
  started_at     TEXT    NOT NULL,
  ended_at       TEXT,
  status         TEXT,
  attrs_json     TEXT,
  error_class    TEXT,
  error_message  TEXT
);
CREATE INDEX IF NOT EXISTS idx_spans_trace  ON spans(trace_id, started_at);
CREATE INDEX IF NOT EXISTS idx_spans_run    ON spans(run_id, started_at);
CREATE INDEX IF NOT EXISTS idx_spans_parent ON spans(parent_span_id);

CREATE TABLE IF NOT EXISTS run_idempotency_keys (
  namespace        TEXT    NOT NULL,
  key              TEXT    NOT NULL,
  fingerprint      TEXT    NOT NULL,
  run_id           INTEGER,
  trigger_event_id INTEGER,
  span_id          TEXT,
  status           TEXT    NOT NULL,
  created_at       TEXT    NOT NULL,
  expires_at       TEXT,
  result_ref       TEXT,
  PRIMARY KEY (namespace, key)
);
CREATE INDEX IF NOT EXISTS idx_idempotency_expires
  ON run_idempotency_keys(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_idempotency_run
  ON run_idempotency_keys(run_id) WHERE run_id IS NOT NULL;
`;

// v4.9.0 Slice 7 — external trace adoption. Adds `external_trace_id`
// to `spans` + `runs` for W3C traceparent adoption alongside Aiden's
// typed `trc_<uuidv7>`. Source of truth: `db/schema/v10.sql`.
const V10_SQL = `
ALTER TABLE spans ADD COLUMN external_trace_id TEXT;
ALTER TABLE runs  ADD COLUMN external_trace_id TEXT;
CREATE INDEX IF NOT EXISTS idx_spans_external_trace
  ON spans(external_trace_id) WHERE external_trace_id IS NOT NULL;
`;

// v4.9.0 Slice 12a — Hook system tables. Source of truth lives at
// `core/v4/daemon/db/schema/v11.sql`.
const V11_SQL = `
CREATE TABLE IF NOT EXISTS hooks (
  hook_id        TEXT    PRIMARY KEY,
  name           TEXT    NOT NULL,
  version        TEXT,
  source         TEXT    NOT NULL,
  runtime        TEXT    NOT NULL,
  manifest_path  TEXT    NOT NULL,
  code_hash      TEXT    NOT NULL,
  enabled        INTEGER NOT NULL DEFAULT 0,
  trust_state    TEXT    NOT NULL,
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL,
  UNIQUE(manifest_path)
);
CREATE TABLE IF NOT EXISTS hook_subscriptions (
  subscription_id TEXT    PRIMARY KEY,
  hook_id         TEXT    NOT NULL REFERENCES hooks(hook_id) ON DELETE CASCADE,
  event           TEXT    NOT NULL,
  matcher_json    TEXT,
  authority       TEXT    NOT NULL,
  mode            TEXT    NOT NULL,
  priority        INTEGER NOT NULL DEFAULT 0,
  timeout_ms      INTEGER NOT NULL,
  on_error        TEXT    NOT NULL,
  on_timeout      TEXT    NOT NULL,
  enabled         INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_hook_subscriptions_event ON hook_subscriptions(event, enabled);
CREATE TABLE IF NOT EXISTS hook_capability_grants (
  grant_id     TEXT    PRIMARY KEY,
  hook_id      TEXT    NOT NULL REFERENCES hooks(hook_id) ON DELETE CASCADE,
  capability   TEXT    NOT NULL,
  scope_json   TEXT    NOT NULL,
  granted_by   TEXT,
  granted_at   TEXT    NOT NULL,
  revoked_at   TEXT
);
CREATE TABLE IF NOT EXISTS hook_executions (
  hook_execution_id TEXT    PRIMARY KEY,
  hook_id           TEXT    NOT NULL REFERENCES hooks(hook_id),
  subscription_id   TEXT    REFERENCES hook_subscriptions(subscription_id),
  event             TEXT    NOT NULL,
  run_id            TEXT,
  trace_id          TEXT,
  span_id           TEXT,
  parent_span_id    TEXT,
  tool_call_id      TEXT,
  status            TEXT    NOT NULL,
  decision          TEXT,
  elapsed_ms        INTEGER NOT NULL,
  cpu_ms            INTEGER,
  max_rss_kb        INTEGER,
  exit_code         INTEGER,
  payload_hash      TEXT,
  response_hash     TEXT,
  stdout_preview    TEXT,
  stderr_preview    TEXT,
  error_kind        TEXT,
  error_message     TEXT,
  started_at        TEXT    NOT NULL,
  finished_at       TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hook_executions_run   ON hook_executions(run_id, started_at);
CREATE INDEX IF NOT EXISTS idx_hook_executions_hook  ON hook_executions(hook_id, started_at);
CREATE INDEX IF NOT EXISTS idx_hook_executions_event ON hook_executions(event, started_at);
`;

// v4.9.0 Slice 12b — auto-disable rail. Just an ADD COLUMN; full
// rationale lives in `core/v4/daemon/db/schema/v12.sql`.
const V12_SQL = `
ALTER TABLE hooks ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;
`;

// v4.10 Slice 10.2b — run_events richer schema. The original 5-field
// shape (id, run_id, ts, kind, payload) was too thin for the queries
// v4.10's trace_query + /trace recent need: filter-by-category,
// filter-by-name, filter-by-tool_call_id, scope-by-session, and
// parent-child event linking. Adds 16 columns + 7 new indexes
// (existing idx_run_events_run on (run_id, ts) already covers one
// of the target query paths and stays as-is).
//
// Backfill strategy:
//   - seq           : copy from id (legacy rows get a monotonic per-
//                     process counter; new rows write a true per-run
//                     counter via emitEventRich)
//   - category      : 'legacy' (the rich-emission code path tags
//                     new rows via core/v4/daemon/eventCategories.ts)
//   - session_id    : JOIN backfill from parent runs row
//   - other columns : NULL — caller fills via emitEventRich; legacy
//                     emitEvent path provides only the legacy subset
//
// Payload semantics change: existing emitEvent hard-sliced to 4096
// bytes without a flag; the rich path now writes original byte count
// to payload_bytes and sets payload_truncated=1 when clipped. Legacy
// callers continue working unchanged.
//
// Drops payload's NOT NULL constraint (payload becomes optional in
// the new shape so summary-only events can omit it). SQLite does
// not support DROP NOT NULL via ALTER, so we leave the existing
// constraint — new emissions always pass at least `{}` JSON or
// fail validation upstream.
const V13_SQL = `
ALTER TABLE run_events ADD COLUMN session_id        TEXT;
ALTER TABLE run_events ADD COLUMN turn_id           TEXT;
ALTER TABLE run_events ADD COLUMN seq               INTEGER NOT NULL DEFAULT 0;
ALTER TABLE run_events ADD COLUMN category          TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE run_events ADD COLUMN name              TEXT;
ALTER TABLE run_events ADD COLUMN tool_call_id      TEXT;
ALTER TABLE run_events ADD COLUMN parent_event_id   INTEGER REFERENCES run_events(id);
ALTER TABLE run_events ADD COLUMN status            TEXT;
ALTER TABLE run_events ADD COLUMN duration_ms       INTEGER;
ALTER TABLE run_events ADD COLUMN summary           TEXT;
ALTER TABLE run_events ADD COLUMN payload_truncated INTEGER NOT NULL DEFAULT 0;
ALTER TABLE run_events ADD COLUMN payload_bytes     INTEGER;
ALTER TABLE run_events ADD COLUMN payload_ref       TEXT;
ALTER TABLE run_events ADD COLUMN visibility        TEXT NOT NULL DEFAULT 'model';
ALTER TABLE run_events ADD COLUMN source            TEXT;
ALTER TABLE run_events ADD COLUMN schema_version    INTEGER NOT NULL DEFAULT 1;

UPDATE run_events SET seq = id WHERE seq = 0;

UPDATE run_events
   SET session_id = (
     SELECT session_id FROM runs WHERE runs.id = run_events.run_id
   )
 WHERE session_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_run_events_run_seq        ON run_events(run_id, seq);
CREATE INDEX IF NOT EXISTS idx_run_events_run_kind_seq   ON run_events(run_id, kind, seq);
CREATE INDEX IF NOT EXISTS idx_run_events_kind_ts        ON run_events(kind, ts);
CREATE INDEX IF NOT EXISTS idx_run_events_category_ts    ON run_events(category, ts);
CREATE INDEX IF NOT EXISTS idx_run_events_tool_call      ON run_events(tool_call_id);
CREATE INDEX IF NOT EXISTS idx_run_events_parent         ON run_events(parent_event_id);
CREATE INDEX IF NOT EXISTS idx_run_events_session_ts     ON run_events(session_id, ts);
`;

// v4.10 Slice 10.8 — durable Task-lite kernel. Sits ABOVE the existing
// `runs` table conceptually: one Task may span many turn-runs via the
// `trace_ids` JSON array (which back-references `run_events.id` from
// Slice 10.2b). Auto-created by `chatSession.runAgentTurn` per user
// message; status lifecycle covers active → completed/failed/cancelled.
// Lightweight by design — `claim_lock`, `worker_pid`, `last_heartbeat_at`
// from the heavier full-Task-kernel ledger pattern (deferred to a
// v4.11 daemon-path slice) are deliberately absent here. REPL is
// single-process, doesn't need worker-coordination state.
//
// Forward-compat fields land NOW so v4.11 doesn't need a second
// table-add migration:
//   - parent_task_id  : sub-task linkage (no UI this slice)
//   - artifact_ids    : back-reference into a future artifact registry
//   - channel_id      : 'repl' hard-coded today; Telegram/etc later
const V14_SQL = `
CREATE TABLE IF NOT EXISTS tasks (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  goal            TEXT NOT NULL,
  status          TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  channel_id      TEXT,
  session_id      TEXT NOT NULL,
  parent_task_id  TEXT,
  trace_ids       TEXT NOT NULL DEFAULT '[]',
  artifact_ids    TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS idx_tasks_session_created
  ON tasks(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_status
  ON tasks(status, created_at DESC);
`;

// v4.11 — artifact registry with provenance. Records files Aiden produces
// (file_write/patch/move/copy + skill writes) with a traceable link back to
// the originating turn (run_id), task (task_id → goal), tool, and action.
// Captured automatically from the per-turn toolCallTrace in chatSession;
// only verifier-ok writes are registered. Mirrors the `tasks` shape; the
// reserved `tasks.artifact_ids` JSON array back-references rows here.
const V15_SQL = `
CREATE TABLE IF NOT EXISTS artifacts (
  id              TEXT PRIMARY KEY,
  path            TEXT NOT NULL,
  kind            TEXT NOT NULL,
  tool            TEXT NOT NULL,
  action          TEXT NOT NULL,
  run_id          INTEGER,
  task_id         TEXT,
  session_id      TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  bytes           INTEGER,
  preview         TEXT
);

CREATE INDEX IF NOT EXISTS idx_artifacts_session_created
  ON artifacts(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_artifacts_task
  ON artifacts(task_id, created_at DESC);
`;

// v4.13 Pillar 1 Gap 1 — verify-before-done. `evidence` holds the
// versioned JSON envelope written when the turn-end gate decides the
// task's terminal status (core/v4/taskVerification.ts: verdict + per-claim
// evidence handles + failures). Nullable: rows predating the gate, and
// rows finalized on non-`stop` finishes, simply have no envelope. The
// envelope is the seed of the full job-card — Gap 3 extends it (and adds
// sibling columns) rather than reshaping. New status values
// (pending_verification / completed_unverified / verification_failed)
// need no schema change — `status` is unconstrained TEXT by design.
const V16_SQL = `
ALTER TABLE tasks ADD COLUMN evidence TEXT;
`;

// v4.13 Pillar 1 Gap 3 — complete the job-card. Additive columns making
// the task row the durable, evidence-backed record of what a task is and
// what it did — everything a future resume (Gap 4) needs, reconstructable
// without trusting prose:
//   constraints   (nullable JSON) — user-stated limits at creation. No
//                 producer exists today (free-text constraints are not
//                 captured anywhere); the column is the seam.
//   files_touched (JSON array)    — deduped paths from mutating, verifier-
//                 evidenced tool executions; append-per-turn.
//   side_effects  (JSON array)    — mutating executions beyond files
//                 ({tool, target, verified, evidence?}).
//   failure_state (nullable JSON) — last structured give-up/verification
//                 failure ({class, whatWasTried: retry ledger, whenAt}).
//   permissions   (nullable JSON) — approval mode in force when the task
//                 ran (the Pillar-2 seam: record now, enforce later).
const V17_SQL = `
ALTER TABLE tasks ADD COLUMN constraints   TEXT;
ALTER TABLE tasks ADD COLUMN files_touched TEXT NOT NULL DEFAULT '[]';
ALTER TABLE tasks ADD COLUMN side_effects  TEXT NOT NULL DEFAULT '[]';
ALTER TABLE tasks ADD COLUMN failure_state TEXT;
ALTER TABLE tasks ADD COLUMN permissions   TEXT;
`;

// v4.13 Pillar 1 Gap 4 — durable resume that re-drives.
//   runs.task_id       — links a daemon run to its durable task row (the
//                        job-card), so the resume sweep can revalidate the
//                        world from evidence instead of prose. NULL for
//                        rows predating the link (those are honestly
//                        unresumable — no card, no revalidation).
//   tasks.resume_count — per-TASK resume attempts spent; the wake-loop
//                        cap (default 2) reads this. Turn-level budgets
//                        (Gap 2) reset per attempt; this one never does.
const V18_SQL = `
ALTER TABLE runs  ADD COLUMN task_id      TEXT;
ALTER TABLE tasks ADD COLUMN resume_count INTEGER NOT NULL DEFAULT 0;
`;

// v4.12.1 Pillar 1 — side-effect idempotency ledger. Durable, per-task
// record of EXTERNAL-irreversible sends (channel deliveries, outbound
// webhook/email) so a crash-then-resume never re-fires a send that already
// left the machine. One row per logical send, keyed deterministically from
// (task_id + step-ordinal + args_hash) — the same logical send always maps
// to the same `key`, even though a channel DeliveryReceipt carries no
// provider id. Lifecycle: an `attempting` row is written BEFORE the send;
// promoted to `confirmed` with the receipt AFTER it returns. On resume:
//   confirmed  → skip (idempotent replay) — the send already happened.
//   attempting → crash mid-send; NEVER blind re-fire — verify a receipt if
//                one exists, else surface to the user (needs-confirmation).
// The (task_id, step) index backs the ambiguity guard: a confirmed row at
// the same ordinal but a DIFFERENT args_hash (the re-driven model phrased
// the send differently) is treated as needs-confirmation, not a fresh send.
// Local file mutations do NOT land here — they are covered by verify +
// the batch-staleness guard and are safe to re-drive.
const V19_SQL = `
CREATE TABLE IF NOT EXISTS side_effect_ledger (
  key           TEXT    PRIMARY KEY,
  task_id       TEXT,
  step          INTEGER NOT NULL,
  tool          TEXT    NOT NULL,
  args_hash     TEXT    NOT NULL,
  target        TEXT,
  status        TEXT    NOT NULL,
  receipt       TEXT,
  attempted_at  INTEGER NOT NULL,
  confirmed_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_side_effect_ledger_task
  ON side_effect_ledger(task_id, step);
`;

function tableColumns(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name),
  );
}

function addMissingColumns(
  db: Database.Database,
  table: string,
  definitions: ReadonlyArray<readonly [name: string, definition: string]>,
): void {
  const existing = tableColumns(db, table);
  for (const [name, definition] of definitions) {
    if (existing.has(name)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    existing.add(name);
  }
}

/** Promote the existing task/run/event records into the durable Job engine. */
function applyV20(db: Database.Database): void {
  addMissingColumns(db, 'tasks', [
    ['state_version',          'INTEGER NOT NULL DEFAULT 0'],
    ['active_attempt_id',      'TEXT'],
    ['root_job_id',            'TEXT'],
    ['idempotency_namespace',  'TEXT'],
    ['idempotency_key',        'TEXT'],
    ['request_fingerprint',    'TEXT'],
    ['entry_point',            'TEXT'],
    ['source',                 'TEXT'],
    ['workspace_id',           'TEXT'],
    ['principal_id',           'TEXT'],
    ['terminal_at',            'INTEGER'],
    ['terminal_outcome',       'TEXT'],
    ['finish_reason',          'TEXT'],
    ['recovery_state',         "TEXT NOT NULL DEFAULT 'none'"],
    ['crash_count',            'INTEGER NOT NULL DEFAULT 0'],
    ['next_event_sequence',    'INTEGER NOT NULL DEFAULT 1'],
    ['policy_snapshot_id',     'TEXT'],
  ]);

  addMissingColumns(db, 'runs', [
    ['attempt_id',             'TEXT'],
    ['attempt_number',         'INTEGER NOT NULL DEFAULT 1'],
    ['generation',             'INTEGER NOT NULL DEFAULT 1'],
    ['state_version',          'INTEGER NOT NULL DEFAULT 0'],
    ['lease_id',               'TEXT'],
    ['lease_owner',            'TEXT'],
    ['lease_expires_at',       'INTEGER'],
    ['lease_heartbeat_at',     'INTEGER'],
    ['fence_token',            'TEXT'],
    ['recovery_of_attempt_id', 'TEXT'],
    ['trigger_reason',         'TEXT'],
    ['provider_route_snapshot','TEXT'],
    ['budget_snapshot',        'TEXT'],
    ['ended_at',               'INTEGER'],
    ['next_event_sequence',    'INTEGER NOT NULL DEFAULT 1'],
  ]);

  addMissingColumns(db, 'run_events', [
    ['job_id',          'TEXT'],
    ['attempt_id',      'TEXT'],
    ['job_sequence',    'INTEGER'],
    ['producer',        'TEXT'],
    ['generation',      'INTEGER'],
    ['causation_id',    'TEXT'],
    ['correlation_id',  'TEXT'],
    ['idempotency_key', 'TEXT'],
  ]);

  addMissingColumns(db, 'side_effect_ledger', [
    ['job_id',       'TEXT'],
    ['attempt_id',   'TEXT'],
    ['generation',   'INTEGER'],
    ['tool_call_id', 'TEXT'],
    ['effect_state', "TEXT NOT NULL DEFAULT 'none'"],
  ]);

  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_calls (
      tool_call_id           TEXT PRIMARY KEY,
      job_id                 TEXT NOT NULL,
      attempt_id             TEXT NOT NULL,
      generation             INTEGER NOT NULL,
      model_call_id          TEXT,
      tool_name              TEXT NOT NULL,
      normalized_args_digest TEXT NOT NULL,
      risk_tier              TEXT NOT NULL,
      mutates                INTEGER NOT NULL,
      state                  TEXT NOT NULL,
      started_at             INTEGER,
      ended_at               INTEGER,
      result_ref             TEXT,
      side_effect_id         TEXT,
      verification_ref       TEXT,
      created_at             INTEGER NOT NULL,
      updated_at             INTEGER NOT NULL,
      FOREIGN KEY (job_id) REFERENCES tasks(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_tool_calls_job
      ON tool_calls(job_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_tool_calls_attempt
      ON tool_calls(attempt_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_tool_calls_state
      ON tool_calls(state, updated_at);
  `);

  db.exec(`
    UPDATE runs
       SET attempt_id = 'attempt_legacy_' || id
     WHERE attempt_id IS NULL OR attempt_id = '';

    WITH numbered AS (
      SELECT id,
             CASE
               WHEN task_id IS NULL THEN 1
               ELSE ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY id)
             END AS ordinal
        FROM runs
    )
    UPDATE runs
       SET attempt_number = (SELECT ordinal FROM numbered WHERE numbered.id = runs.id);

    UPDATE runs
       SET ended_at = completed_at
     WHERE ended_at IS NULL AND completed_at IS NOT NULL;

    UPDATE runs
       SET next_event_sequence = COALESCE(
         (SELECT MAX(e.seq) + 1 FROM run_events e WHERE e.run_id = runs.id),
         1
       );

    WITH RECURSIVE roots(id, root_id) AS (
      SELECT t.id, t.id
        FROM tasks t
       WHERE t.parent_task_id IS NULL
          OR NOT EXISTS (SELECT 1 FROM tasks parent WHERE parent.id = t.parent_task_id)
      UNION ALL
      SELECT child.id, roots.root_id
        FROM tasks child
        JOIN roots ON child.parent_task_id = roots.id
    )
    UPDATE tasks
       SET root_job_id = COALESCE(
         (SELECT root_id FROM roots WHERE roots.id = tasks.id),
         id
       )
     WHERE root_job_id IS NULL OR root_job_id = '';

    UPDATE tasks
       SET active_attempt_id = (
         SELECT r.attempt_id
           FROM runs r
          WHERE r.task_id = tasks.id
            AND r.status IN ('queued', 'running', 'active', 'waiting')
          ORDER BY r.id DESC
          LIMIT 1
       )
     WHERE active_attempt_id IS NULL;

    UPDATE run_events
       SET job_id = (SELECT r.task_id FROM runs r WHERE r.id = run_events.run_id),
           attempt_id = (SELECT r.attempt_id FROM runs r WHERE r.id = run_events.run_id),
           generation = COALESCE(
             (SELECT r.generation FROM runs r WHERE r.id = run_events.run_id),
             1
           )
     WHERE job_id IS NULL OR attempt_id IS NULL OR generation IS NULL;

    WITH ranked AS (
      SELECT id,
             ROW_NUMBER() OVER (PARTITION BY job_id ORDER BY id) AS ordinal
        FROM run_events
       WHERE job_id IS NOT NULL
    )
    UPDATE run_events
       SET job_sequence = (SELECT ordinal FROM ranked WHERE ranked.id = run_events.id)
     WHERE job_id IS NOT NULL;

    UPDATE tasks
       SET next_event_sequence = COALESCE(
         (SELECT MAX(e.job_sequence) + 1 FROM run_events e WHERE e.job_id = tasks.id),
         1
       );

    UPDATE side_effect_ledger
       SET job_id = COALESCE(job_id, task_id),
           effect_state = CASE status
             WHEN 'attempting' THEN 'started'
             WHEN 'confirmed' THEN 'committed'
             ELSE effect_state
           END;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_idempotency
      ON tasks(idempotency_namespace, idempotency_key)
      WHERE idempotency_namespace IS NOT NULL AND idempotency_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_tasks_root_job
      ON tasks(root_job_id, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_attempt_id
      ON runs(attempt_id);
    CREATE INDEX IF NOT EXISTS idx_runs_job_attempt
      ON runs(task_id, attempt_number);
    CREATE INDEX IF NOT EXISTS idx_runs_lease_expiry
      ON runs(lease_expires_at)
      WHERE lease_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_run_events_job_sequence
      ON run_events(job_id, job_sequence)
      WHERE job_id IS NOT NULL AND job_sequence IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_run_events_job_idempotency
      ON run_events(job_id, idempotency_key)
      WHERE job_id IS NOT NULL AND idempotency_key IS NOT NULL;
  `);
}

/** Add the durable Phase 4 input, control, policy, and approval authorities. */
function applyV21(db: Database.Database): void {
  addMissingColumns(db, 'tasks', [
    ['next_input_sequence', 'INTEGER NOT NULL DEFAULT 1'],
  ]);

  db.exec(`
    CREATE TABLE IF NOT EXISTS durable_inputs (
      input_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      target_attempt_id TEXT,
      target_generation INTEGER,
      session_id TEXT NOT NULL,
      channel_id TEXT,
      source TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      kind TEXT NOT NULL,
      content TEXT,
      content_ref TEXT,
      content_hash TEXT NOT NULL,
      state TEXT NOT NULL,
      idempotency_namespace TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      claimed_by_attempt_id TEXT,
      claimed_generation INTEGER,
      claimed_at INTEGER,
      consumed_at INTEGER,
      supersedes_input_id TEXT,
      expires_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (job_id) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (supersedes_input_id) REFERENCES durable_inputs(input_id) ON DELETE SET NULL,
      UNIQUE (job_id, sequence),
      UNIQUE (idempotency_namespace, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS idx_durable_inputs_pending
      ON durable_inputs(job_id, state, sequence);
    CREATE INDEX IF NOT EXISTS idx_durable_inputs_session
      ON durable_inputs(session_id, state, created_at);

    CREATE TABLE IF NOT EXISTS steering_commands (
      steering_id TEXT PRIMARY KEY,
      input_id TEXT NOT NULL UNIQUE,
      job_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      target_scope TEXT NOT NULL,
      action TEXT NOT NULL,
      payload TEXT,
      state TEXT NOT NULL,
      safe_boundary_sequence INTEGER,
      invalidates_plan_digest TEXT,
      applied_at INTEGER,
      rejection_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (input_id) REFERENCES durable_inputs(input_id) ON DELETE CASCADE,
      FOREIGN KEY (job_id) REFERENCES tasks(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_steering_pending
      ON steering_commands(job_id, attempt_id, generation, state, created_at);

    CREATE TABLE IF NOT EXISTS job_control_commands (
      control_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      attempt_id TEXT,
      generation INTEGER,
      kind TEXT NOT NULL,
      source TEXT NOT NULL,
      reason TEXT,
      state TEXT NOT NULL,
      idempotency_namespace TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      applied_at INTEGER,
      rejection_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (job_id) REFERENCES tasks(id) ON DELETE CASCADE,
      UNIQUE (idempotency_namespace, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS idx_job_controls_pending
      ON job_control_commands(job_id, state, created_at);

    CREATE TABLE IF NOT EXISTS policy_snapshots (
      policy_snapshot_id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL,
      digest TEXT NOT NULL UNIQUE,
      trust_level TEXT NOT NULL,
      autonomy_policy TEXT NOT NULL,
      approval_mode TEXT NOT NULL,
      tool_metadata_version TEXT NOT NULL,
      sandbox_policy_json TEXT NOT NULL,
      network_policy_json TEXT NOT NULL,
      plugin_grants_json TEXT NOT NULL,
      mcp_grants_json TEXT NOT NULL,
      spending_limits_json TEXT,
      workspace_overrides_json TEXT NOT NULL,
      job_overrides_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS approvals (
      approval_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      tool_call_id TEXT NOT NULL,
      request_sequence INTEGER NOT NULL,
      tool_name TEXT NOT NULL,
      risk_tier TEXT NOT NULL,
      risk_reasons_json TEXT NOT NULL,
      normalized_execution_plan TEXT NOT NULL,
      action_digest TEXT NOT NULL,
      policy_snapshot_id TEXT NOT NULL,
      state TEXT NOT NULL,
      decision TEXT,
      decision_input_id TEXT,
      decision_scope TEXT,
      decided_by TEXT,
      decision_channel TEXT,
      requested_at INTEGER NOT NULL,
      displayed_at INTEGER,
      decided_at INTEGER,
      expires_at INTEGER,
      invalidated_at INTEGER,
      invalidation_reason TEXT,
      executed_at INTEGER,
      FOREIGN KEY (job_id) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (policy_snapshot_id) REFERENCES policy_snapshots(policy_snapshot_id),
      FOREIGN KEY (decision_input_id) REFERENCES durable_inputs(input_id) ON DELETE SET NULL,
      UNIQUE (job_id, request_sequence)
    );
    CREATE INDEX IF NOT EXISTS idx_approvals_waiting
      ON approvals(job_id, state, requested_at);
    CREATE INDEX IF NOT EXISTS idx_approvals_tool_call
      ON approvals(tool_call_id, state);
  `);
}

/** Extend the existing SideEffect ledger with explicit execution contracts. */
function applyV22(db: Database.Database): void {
  addMissingColumns(db, 'side_effect_ledger', [
    ['effect_classification',      "TEXT NOT NULL DEFAULT 'unknown_mutation'"],
    ['effect_kind',                "TEXT NOT NULL DEFAULT 'unknown'"],
    ['retry_safety',               "TEXT NOT NULL DEFAULT 'never_automatic'"],
    ['idempotency_key',            'TEXT'],
    ['idempotency_supported',      'INTEGER NOT NULL DEFAULT 0'],
    ['reconciliation_supported',   'INTEGER NOT NULL DEFAULT 0'],
    ['verification_supported',     'INTEGER NOT NULL DEFAULT 0'],
    ['approval_requirement',       "TEXT NOT NULL DEFAULT 'always'"],
    ['approval_state',             "TEXT NOT NULL DEFAULT 'not_required'"],
    ['approval_id',                'TEXT'],
    ['action_digest',              'TEXT'],
    ['sensitive_fields_json',      "TEXT NOT NULL DEFAULT '[]'"],
    ['redaction_rules_json',       "TEXT NOT NULL DEFAULT '[]'"],
    ['result_ref',                 'TEXT'],
    ['updated_at',                 'INTEGER'],
  ]);
  addMissingColumns(db, 'approvals', [
    ['effect_id', 'TEXT'],
  ]);
  db.exec(`
    UPDATE side_effect_ledger
       SET updated_at = COALESCE(updated_at, confirmed_at, attempted_at),
           effect_classification = CASE
             WHEN effect_classification = 'unknown_mutation' AND effect_state IN ('committed','started')
               THEN 'unsafe_mutation'
             ELSE effect_classification
           END;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_side_effect_job_idempotency
      ON side_effect_ledger(job_id, idempotency_key)
      WHERE job_id IS NOT NULL AND idempotency_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_side_effect_recovery
      ON side_effect_ledger(effect_state, retry_safety, updated_at);
    CREATE INDEX IF NOT EXISTS idx_approvals_effect
      ON approvals(effect_id, state)
      WHERE effect_id IS NOT NULL;
  `);
}

/** Append-only reconciliation history for uncertain real-world Effects. */
function applyV23(db: Database.Database): void {
  addMissingColumns(db, 'side_effect_ledger', [
    ['reconciliation_data_json', 'TEXT'],
    ['reconciliation_outcome', 'TEXT'],
    ['reconciliation_required', 'INTEGER NOT NULL DEFAULT 0'],
    ['last_reconciled_at', 'INTEGER'],
  ]);
  db.exec(`
    CREATE TABLE IF NOT EXISTS effect_reconciliations (
      reconciliation_id TEXT PRIMARY KEY,
      effect_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      outcome TEXT NOT NULL,
      confidence TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      retry_recommendation TEXT NOT NULL,
      human_resolution_required INTEGER NOT NULL,
      producer TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (effect_id) REFERENCES side_effect_ledger(key) ON DELETE CASCADE,
      FOREIGN KEY (job_id) REFERENCES tasks(id) ON DELETE CASCADE,
      UNIQUE (effect_id, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS idx_effect_reconciliations_effect
      ON effect_reconciliations(effect_id, created_at, reconciliation_id);
    CREATE INDEX IF NOT EXISTS idx_effect_reconciliation_required
      ON side_effect_ledger(job_id, reconciliation_required, effect_state);
  `);
}

/** Durable dependency graph and append-only node execution history. */
function applyV24(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS execution_graphs (
      graph_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL UNIQUE,
      plan_digest TEXT NOT NULL,
      state TEXT NOT NULL,
      version INTEGER NOT NULL,
      next_event_sequence INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (job_id) REFERENCES tasks(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS execution_graph_nodes (
      node_id TEXT PRIMARY KEY,
      node_key TEXT NOT NULL,
      graph_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      state TEXT NOT NULL,
      label TEXT,
      input_ref TEXT,
      output_ref TEXT,
      verification_ref TEXT,
      requires_verification INTEGER NOT NULL DEFAULT 0,
      ordinal INTEGER NOT NULL,
      state_version INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (graph_id) REFERENCES execution_graphs(graph_id) ON DELETE CASCADE,
      FOREIGN KEY (job_id) REFERENCES tasks(id) ON DELETE CASCADE,
      UNIQUE (graph_id, node_key)
    );
    CREATE INDEX IF NOT EXISTS idx_execution_graph_nodes_state
      ON execution_graph_nodes(graph_id, state, ordinal);
    CREATE TABLE IF NOT EXISTS execution_graph_edges (
      graph_id TEXT NOT NULL,
      from_node_id TEXT NOT NULL,
      to_node_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (graph_id, from_node_id, to_node_id),
      FOREIGN KEY (graph_id) REFERENCES execution_graphs(graph_id) ON DELETE CASCADE,
      FOREIGN KEY (from_node_id) REFERENCES execution_graph_nodes(node_id) ON DELETE CASCADE,
      FOREIGN KEY (to_node_id) REFERENCES execution_graph_nodes(node_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_execution_graph_edges_target
      ON execution_graph_edges(graph_id, to_node_id);
    CREATE TABLE IF NOT EXISTS execution_node_attempts (
      node_execution_id TEXT PRIMARY KEY,
      graph_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      state TEXT NOT NULL,
      output_ref TEXT,
      verification_ref TEXT,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      FOREIGN KEY (graph_id) REFERENCES execution_graphs(graph_id) ON DELETE CASCADE,
      FOREIGN KEY (node_id) REFERENCES execution_graph_nodes(node_id) ON DELETE CASCADE,
      FOREIGN KEY (job_id) REFERENCES tasks(id) ON DELETE CASCADE,
      UNIQUE (node_id, attempt_id, generation)
    );
    CREATE INDEX IF NOT EXISTS idx_execution_node_attempts_active
      ON execution_node_attempts(job_id, state, started_at);
    CREATE TABLE IF NOT EXISTS execution_graph_events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      graph_id TEXT NOT NULL,
      graph_sequence INTEGER NOT NULL,
      job_id TEXT NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      producer TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (graph_id) REFERENCES execution_graphs(graph_id) ON DELETE CASCADE,
      FOREIGN KEY (job_id) REFERENCES tasks(id) ON DELETE CASCADE,
      UNIQUE (graph_id, graph_sequence),
      UNIQUE (graph_id, idempotency_key)
    );
  `);
}

/** Durable waits and their append-only resolution history. */
function applyV25(db: Database.Database): void {
  addMissingColumns(db, 'tasks', [
    ['next_wait_sequence', 'INTEGER NOT NULL DEFAULT 1'],
  ]);
  db.exec(`
    CREATE TABLE IF NOT EXISTS job_waits (
      wait_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      sequence INTEGER NOT NULL,
      graph_node_key TEXT,
      kind TEXT NOT NULL,
      state TEXT NOT NULL,
      deadline_at INTEGER,
      external_key TEXT,
      payload_ref TEXT,
      resolved_by_input_id TEXT,
      resolution_ref TEXT,
      idempotency_namespace TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      resolved_at INTEGER,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (job_id) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (resolved_by_input_id) REFERENCES durable_inputs(input_id) ON DELETE SET NULL,
      UNIQUE (idempotency_namespace, idempotency_key),
      UNIQUE (job_id, sequence)
    );
    CREATE INDEX IF NOT EXISTS idx_job_waits_pending
      ON job_waits(job_id, state, deadline_at, sequence);
    CREATE INDEX IF NOT EXISTS idx_job_waits_external
      ON job_waits(job_id, external_key, state) WHERE external_key IS NOT NULL;
    CREATE TABLE IF NOT EXISTS job_wait_events (
      wait_event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      wait_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      producer TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (wait_id) REFERENCES job_waits(wait_id) ON DELETE CASCADE,
      FOREIGN KEY (job_id) REFERENCES tasks(id) ON DELETE CASCADE,
      UNIQUE (wait_id, idempotency_key)
    );
  `);
}

/** Bind each durable Approval to the exact lease fence that requested it. */
function applyV26(db: Database.Database): void {
  addMissingColumns(db, 'approvals', [
    ['fence_token_digest', 'TEXT'],
  ]);
}

/** Durable execution contract and attributed result for delegated child Jobs. */
function applyV27(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS child_job_contracts (
      child_job_id TEXT PRIMARY KEY,
      parent_job_id TEXT NOT NULL,
      required INTEGER NOT NULL DEFAULT 1,
      worker_id TEXT NOT NULL,
      capabilities_json TEXT NOT NULL,
      allowed_resources_json TEXT NOT NULL,
      budget_json TEXT NOT NULL,
      result_attempt_id TEXT,
      result_generation INTEGER,
      result_status TEXT,
      evidence_json TEXT,
      evidence_handles_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (child_job_id) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (parent_job_id) REFERENCES tasks(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_child_job_contracts_parent
      ON child_job_contracts(parent_job_id, required, child_job_id);
  `);
}

/** Durable budget balances, debits, and least-privilege capability snapshots. */
function applyV28(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS job_budgets (
      job_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      limit_value REAL,
      used_value REAL NOT NULL DEFAULT 0,
      has_unknown_usage INTEGER NOT NULL DEFAULT 0,
      state_version INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (job_id, kind),
      FOREIGN KEY (job_id) REFERENCES tasks(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS job_budget_debits (
      debit_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      kind TEXT NOT NULL,
      amount REAL,
      certainty TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (job_id) REFERENCES tasks(id) ON DELETE CASCADE,
      UNIQUE (job_id, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS idx_job_budget_debits_attempt
      ON job_budget_debits(attempt_id, generation, created_at);
    CREATE TABLE IF NOT EXISTS job_capability_sets (
      job_id TEXT PRIMARY KEY,
      allowed_tools_json TEXT NOT NULL,
      allowed_paths_json TEXT NOT NULL,
      allowed_hosts_json TEXT NOT NULL,
      allowed_applications_json TEXT NOT NULL,
      allowed_connections_json TEXT NOT NULL,
      allowed_accounts_json TEXT NOT NULL,
      allowed_workers_json TEXT NOT NULL,
      allowed_effect_kinds_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (job_id) REFERENCES tasks(id) ON DELETE CASCADE
    );
  `);
}

/** Attempt-attributed claims, evidence, immutable verdicts, and late-review history. */
function applyV29(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS job_claims (
      claim_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      attempt_id TEXT,
      generation INTEGER,
      category TEXT NOT NULL,
      statement TEXT NOT NULL,
      required INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL DEFAULT 'unverified',
      created_at INTEGER NOT NULL,
      checked_at INTEGER,
      FOREIGN KEY (job_id) REFERENCES tasks(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_job_claims_job
      ON job_claims(job_id, category, required, created_at);
    CREATE TABLE IF NOT EXISTS job_evidence (
      evidence_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      effect_id TEXT,
      source TEXT NOT NULL,
      producer TEXT NOT NULL,
      captured_at INTEGER NOT NULL,
      observed_at INTEGER NOT NULL,
      fresh_until INTEGER,
      integrity_sha256 TEXT NOT NULL,
      coverage TEXT NOT NULL,
      verification_result TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      late INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (job_id) REFERENCES tasks(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_job_evidence_attempt
      ON job_evidence(job_id, attempt_id, generation, captured_at);
    CREATE TABLE IF NOT EXISTS claim_evidence (
      claim_id TEXT NOT NULL,
      evidence_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (claim_id, evidence_id),
      FOREIGN KEY (claim_id) REFERENCES job_claims(claim_id) ON DELETE CASCADE,
      FOREIGN KEY (evidence_id) REFERENCES job_evidence(evidence_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS job_verdicts (
      job_id TEXT PRIMARY KEY,
      attempt_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      verdict TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      finalized_at INTEGER NOT NULL,
      FOREIGN KEY (job_id) REFERENCES tasks(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS proof_reviews (
      review_id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      evidence_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (job_id) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (evidence_id) REFERENCES job_evidence(evidence_id) ON DELETE CASCADE
    );
  `);
}

/** Durable cursors for replayable Job-event consumers. */
function applyV30(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS job_event_cursors (
      consumer_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      last_sequence INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (consumer_id, job_id),
      FOREIGN KEY (job_id) REFERENCES tasks(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_job_event_cursors_job
      ON job_event_cursors(job_id, last_sequence);
  `);
}

/** Cover the ordered kernel projection and active-Job query paths. */
function applyV31(db: Database.Database): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tasks_status_created_id
      ON tasks(status, created_at, id);
    CREATE INDEX IF NOT EXISTS idx_tasks_session_created_id
      ON tasks(session_id, created_at, id);
    CREATE INDEX IF NOT EXISTS idx_side_effect_job_created
      ON side_effect_ledger(job_id, attempted_at, key);
    CREATE INDEX IF NOT EXISTS idx_child_job_contracts_parent_created
      ON child_job_contracts(parent_job_id, created_at, child_job_id);
    CREATE INDEX IF NOT EXISTS idx_job_claims_job_created
      ON job_claims(job_id, created_at, claim_id);
    CREATE INDEX IF NOT EXISTS idx_job_evidence_job_created
      ON job_evidence(job_id, captured_at, evidence_id);
  `);
}

/** Immutable repository identity and source-state captures bound to durable Attempts. */
function applyV32(db: Database.Database): void {
  addMissingColumns(db, 'tasks', [['repository_snapshot_id', 'TEXT']]);
  addMissingColumns(db, 'runs', [['repository_snapshot_id', 'TEXT']]);
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_descriptors (
      workspace_id TEXT PRIMARY KEY,
      requested_path TEXT NOT NULL,
      canonical_path TEXT NOT NULL,
      portable_path TEXT NOT NULL,
      path_kind TEXT NOT NULL,
      platform TEXT NOT NULL,
      exists_flag INTEGER NOT NULL,
      repository_root TEXT,
      git_directory TEXT,
      git_common_directory TEXT,
      outer_repository_root TEXT,
      vcs_kind TEXT NOT NULL,
      trust_policy_digest TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_descriptors_identity
      ON workspace_descriptors(platform, portable_path);

    CREATE TABLE IF NOT EXISTS repository_snapshots (
      snapshot_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      repository_root TEXT,
      vcs_kind TEXT NOT NULL,
      branch TEXT,
      head_commit TEXT,
      upstream TEXT,
      index_digest TEXT NOT NULL,
      working_tree_digest TEXT NOT NULL,
      capture_policy_digest TEXT NOT NULL,
      capture_policy_json TEXT NOT NULL,
      incomplete INTEGER NOT NULL DEFAULT 0,
      incomplete_reasons_json TEXT NOT NULL DEFAULT '[]',
      previous_snapshot_id TEXT,
      state_digest TEXT NOT NULL,
      captured_at INTEGER NOT NULL,
      FOREIGN KEY (workspace_id) REFERENCES workspace_descriptors(workspace_id),
      FOREIGN KEY (job_id) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (previous_snapshot_id) REFERENCES repository_snapshots(snapshot_id)
    );
    CREATE INDEX IF NOT EXISTS idx_repository_snapshots_job
      ON repository_snapshots(job_id, captured_at, snapshot_id);
    CREATE INDEX IF NOT EXISTS idx_repository_snapshots_attempt
      ON repository_snapshots(attempt_id, generation, captured_at, snapshot_id);
    CREATE INDEX IF NOT EXISTS idx_repository_snapshots_workspace
      ON repository_snapshots(workspace_id, captured_at, snapshot_id);
    CREATE INDEX IF NOT EXISTS idx_repository_snapshots_ancestry
      ON repository_snapshots(previous_snapshot_id);

    CREATE TABLE IF NOT EXISTS repository_snapshot_entries (
      snapshot_id TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      canonical_identity TEXT NOT NULL,
      classification TEXT NOT NULL,
      git_state TEXT,
      size INTEGER,
      modified_at REAL,
      mode INTEGER,
      content_hash TEXT,
      capture_status TEXT NOT NULL,
      reason TEXT,
      PRIMARY KEY (snapshot_id, relative_path),
      FOREIGN KEY (snapshot_id) REFERENCES repository_snapshots(snapshot_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_repository_snapshot_entries_path
      ON repository_snapshot_entries(relative_path, snapshot_id);
  `);
}

/** Source-fenced repository change intents and their verified outcomes. */
function applyV33(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS repository_change_intents (
      intent_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      fence_token TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      base_snapshot_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      canonical_target TEXT NOT NULL,
      canonical_destination TEXT,
      expected_scope_json TEXT NOT NULL,
      original_hash TEXT,
      original_metadata_json TEXT NOT NULL,
      destination_original_metadata_json TEXT,
      plan_digest TEXT NOT NULL,
      planned_result_hash TEXT,
      planned_result_size INTEGER,
      effect_id TEXT,
      approval_id TEXT,
      action_digest TEXT,
      claim_id TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(attempt_id, generation, tool_call_id),
      FOREIGN KEY (job_id) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (base_snapshot_id) REFERENCES repository_snapshots(snapshot_id),
      FOREIGN KEY (effect_id) REFERENCES side_effect_ledger(key),
      FOREIGN KEY (approval_id) REFERENCES approvals(approval_id),
      FOREIGN KEY (claim_id) REFERENCES job_claims(claim_id)
    );
    CREATE INDEX IF NOT EXISTS idx_repository_change_intents_job
      ON repository_change_intents(job_id, created_at, intent_id);
    CREATE INDEX IF NOT EXISTS idx_repository_change_intents_snapshot
      ON repository_change_intents(base_snapshot_id, created_at, intent_id);

    CREATE TABLE IF NOT EXISTS repository_change_records (
      change_id TEXT PRIMARY KEY,
      intent_id TEXT NOT NULL UNIQUE,
      job_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      fence_token TEXT NOT NULL,
      effect_id TEXT NOT NULL,
      base_snapshot_id TEXT NOT NULL,
      state TEXT NOT NULL,
      result_hash TEXT,
      result_metadata_json TEXT,
      diff_evidence_id TEXT,
      descendant_snapshot_id TEXT,
      error_code TEXT,
      error_message TEXT,
      created_at INTEGER NOT NULL,
      completed_at INTEGER,
      FOREIGN KEY (intent_id) REFERENCES repository_change_intents(intent_id) ON DELETE CASCADE,
      FOREIGN KEY (job_id) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (effect_id) REFERENCES side_effect_ledger(key),
      FOREIGN KEY (base_snapshot_id) REFERENCES repository_snapshots(snapshot_id),
      FOREIGN KEY (diff_evidence_id) REFERENCES job_evidence(evidence_id),
      FOREIGN KEY (descendant_snapshot_id) REFERENCES repository_snapshots(snapshot_id)
    );
    CREATE INDEX IF NOT EXISTS idx_repository_change_records_job
      ON repository_change_records(job_id, created_at, change_id);
  `);
}

/** Snapshot-bound test, build, diagnostic, and validation artifact records. */
function applyV34(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS validation_runs (
      run_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('test','build')),
      job_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      fence_token TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      effect_id TEXT NOT NULL,
      execution_node_id TEXT,
      repository_snapshot_id TEXT NOT NULL,
      source_state_digest TEXT NOT NULL,
      command TEXT NOT NULL,
      working_directory TEXT NOT NULL,
      environment_fingerprint TEXT NOT NULL,
      environment_json TEXT NOT NULL,
      scope TEXT NOT NULL CHECK (scope IN ('focused','full')),
      state TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      exit_code INTEGER,
      timed_out INTEGER NOT NULL DEFAULT 0,
      cancelled INTEGER NOT NULL DEFAULT 0,
      parse_state TEXT NOT NULL DEFAULT 'pending',
      resulting_snapshot_id TEXT,
      source_mutations_json TEXT NOT NULL DEFAULT '[]',
      raw_log_evidence_id TEXT,
      claim_ids_json TEXT NOT NULL DEFAULT '[]',
      artifact_ids_json TEXT NOT NULL DEFAULT '[]',
      UNIQUE(attempt_id, generation, tool_call_id, kind),
      FOREIGN KEY (job_id) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (repository_snapshot_id) REFERENCES repository_snapshots(snapshot_id),
      FOREIGN KEY (resulting_snapshot_id) REFERENCES repository_snapshots(snapshot_id),
      FOREIGN KEY (effect_id) REFERENCES side_effect_ledger(key),
      FOREIGN KEY (execution_node_id) REFERENCES execution_graph_nodes(node_id),
      FOREIGN KEY (raw_log_evidence_id) REFERENCES job_evidence(evidence_id)
    );
    CREATE INDEX IF NOT EXISTS idx_validation_runs_job
      ON validation_runs(job_id, started_at, run_id);
    CREATE INDEX IF NOT EXISTS idx_validation_runs_snapshot
      ON validation_runs(repository_snapshot_id, kind, completed_at, run_id);

    CREATE TABLE IF NOT EXISTS test_run_details (
      run_id TEXT PRIMARY KEY,
      passed_count INTEGER,
      failed_count INTEGER,
      skipped_count INTEGER,
      failed_test_ids_json TEXT NOT NULL DEFAULT '[]',
      FOREIGN KEY (run_id) REFERENCES validation_runs(run_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS build_run_details (
      run_id TEXT PRIMARY KEY,
      declared_output_paths_json TEXT NOT NULL DEFAULT '[]',
      output_artifacts_json TEXT NOT NULL DEFAULT '[]',
      output_hashes_json TEXT NOT NULL DEFAULT '{}',
      package_identity_json TEXT,
      warnings_json TEXT NOT NULL DEFAULT '[]',
      reproducibility_json TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY (run_id) REFERENCES validation_runs(run_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS validation_artifacts (
      artifact_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      relative_path TEXT,
      sha256 TEXT NOT NULL,
      byte_count INTEGER NOT NULL,
      media_type TEXT NOT NULL,
      compression TEXT,
      content_blob BLOB,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      FOREIGN KEY (run_id) REFERENCES validation_runs(run_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_validation_artifacts_run
      ON validation_artifacts(run_id, created_at, artifact_id);

    CREATE TABLE IF NOT EXISTS validation_diagnostics (
      diagnostic_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      repository_snapshot_id TEXT NOT NULL,
      tool TEXT NOT NULL,
      severity TEXT NOT NULL,
      message TEXT NOT NULL,
      relative_path TEXT,
      start_line INTEGER,
      start_column INTEGER,
      end_line INTEGER,
      end_column INTEGER,
      code TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (run_id) REFERENCES validation_runs(run_id) ON DELETE CASCADE,
      FOREIGN KEY (repository_snapshot_id) REFERENCES repository_snapshots(snapshot_id)
    );
    CREATE INDEX IF NOT EXISTS idx_validation_diagnostics_run
      ON validation_diagnostics(run_id, created_at, diagnostic_id);
  `);
}

/** Exact local and remote Git mutations bound to the existing Effect ledger. */
function applyV35(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS git_effect_operations (
      operation_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      fence_token TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      effect_id TEXT,
      approval_id TEXT,
      action_digest TEXT,
      repository_snapshot_id TEXT NOT NULL,
      resulting_snapshot_id TEXT,
      kind TEXT NOT NULL,
      repository_root TEXT NOT NULL,
      base_commit TEXT NOT NULL,
      current_branch TEXT,
      target_ref TEXT,
      expected_old_ref TEXT,
      expected_new_ref TEXT,
      remote_name TEXT,
      remote_identity TEXT,
      owned_paths_json TEXT NOT NULL DEFAULT '[]',
      index_state_json TEXT NOT NULL,
      expected_tree_hash TEXT,
      resulting_tree_hash TEXT,
      commit_hash TEXT,
      author_name TEXT NOT NULL,
      author_email TEXT NOT NULL,
      committer_name TEXT NOT NULL,
      committer_email TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      plan_digest TEXT NOT NULL,
      reconciliation_strategy TEXT NOT NULL,
      reconciliation_outcome TEXT,
      external_reference TEXT,
      evidence_id TEXT,
      state TEXT NOT NULL,
      error_code TEXT,
      error_message TEXT,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      completed_at INTEGER,
      updated_at INTEGER NOT NULL,
      UNIQUE(job_id, idempotency_key),
      UNIQUE(attempt_id, generation, tool_call_id),
      FOREIGN KEY (job_id) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (repository_snapshot_id) REFERENCES repository_snapshots(snapshot_id),
      FOREIGN KEY (resulting_snapshot_id) REFERENCES repository_snapshots(snapshot_id),
      FOREIGN KEY (effect_id) REFERENCES side_effect_ledger(key),
      FOREIGN KEY (approval_id) REFERENCES approvals(approval_id),
      FOREIGN KEY (evidence_id) REFERENCES job_evidence(evidence_id)
    );
    CREATE INDEX IF NOT EXISTS idx_git_effect_operations_job
      ON git_effect_operations(job_id, created_at, operation_id);
    CREATE INDEX IF NOT EXISTS idx_git_effect_operations_state
      ON git_effect_operations(state, updated_at, operation_id);
    CREATE INDEX IF NOT EXISTS idx_git_effect_operations_snapshot
      ON git_effect_operations(repository_snapshot_id, created_at, operation_id);
  `);
}

/** Snapshot-derived repository facts, graph-projected coding references, and source-bound Claims. */
function applyV36(db: Database.Database): void {
  addMissingColumns(db, 'job_claims', [
    ['repository_snapshot_id', 'TEXT'],
    ['source_references_json', "TEXT NOT NULL DEFAULT '[]'"],
    ['required_validation_json', "TEXT NOT NULL DEFAULT '[]'"],
    ['required_evidence_categories_json', "TEXT NOT NULL DEFAULT '[]'"],
  ]);
  addMissingColumns(db, 'job_evidence', [
    ['repository_snapshot_id', 'TEXT'],
  ]);
  db.exec(`
    CREATE TABLE IF NOT EXISTS repository_understanding_indexes (
      snapshot_id TEXT PRIMARY KEY,
      state_digest TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('completed','failed')),
      created_count INTEGER NOT NULL DEFAULT 0,
      reused_count INTEGER NOT NULL DEFAULT 0,
      indexed_at INTEGER NOT NULL,
      FOREIGN KEY (snapshot_id) REFERENCES repository_snapshots(snapshot_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS repository_understanding_records (
      record_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      record_key TEXT NOT NULL,
      source_path TEXT,
      source_hash TEXT,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_repository_understanding_records_kind
      ON repository_understanding_records(kind, record_key, record_id);

    CREATE TABLE IF NOT EXISTS repository_understanding_snapshot_records (
      snapshot_id TEXT NOT NULL,
      record_id TEXT NOT NULL,
      reused_from_snapshot_id TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (snapshot_id, record_id),
      FOREIGN KEY (snapshot_id) REFERENCES repository_snapshots(snapshot_id) ON DELETE CASCADE,
      FOREIGN KEY (record_id) REFERENCES repository_understanding_records(record_id) ON DELETE CASCADE,
      FOREIGN KEY (reused_from_snapshot_id) REFERENCES repository_snapshots(snapshot_id)
    );
    CREATE INDEX IF NOT EXISTS idx_repository_understanding_snapshot_kind
      ON repository_understanding_snapshot_records(snapshot_id, record_id);

    CREATE TABLE IF NOT EXISTS repository_architecture_notes (
      note_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      fence_token TEXT NOT NULL,
      repository_snapshot_id TEXT NOT NULL,
      statement TEXT NOT NULL,
      source_references_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (job_id) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (repository_snapshot_id) REFERENCES repository_snapshots(snapshot_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_repository_architecture_notes_snapshot
      ON repository_architecture_notes(repository_snapshot_id, created_at, note_id);

    CREATE TABLE IF NOT EXISTS execution_graph_node_references (
      reference_key TEXT PRIMARY KEY,
      graph_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      reference_kind TEXT NOT NULL,
      reference_id TEXT,
      repository_snapshot_id TEXT,
      relative_path TEXT,
      line_start INTEGER,
      line_end INTEGER,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (graph_id) REFERENCES execution_graphs(graph_id) ON DELETE CASCADE,
      FOREIGN KEY (node_id) REFERENCES execution_graph_nodes(node_id) ON DELETE CASCADE,
      FOREIGN KEY (repository_snapshot_id) REFERENCES repository_snapshots(snapshot_id)
    );
    CREATE INDEX IF NOT EXISTS idx_execution_graph_node_references_graph
      ON execution_graph_node_references(graph_id, node_id, reference_kind);
  `);
}

/** Immutable Worker contracts and thin child-Attempt relations. */
function applyV37(db: Database.Database): void {
  addMissingColumns(db, 'execution_graph_node_references', [
    ['reference_generation', 'INTEGER'],
  ]);
  db.exec(`
    CREATE TABLE IF NOT EXISTS worker_provider_bindings (
      provider_binding_id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL,
      provider_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      provider_runtime_identity TEXT NOT NULL,
      credential_reference TEXT,
      endpoint_reference TEXT,
      capability_snapshot_hash TEXT NOT NULL,
      selection_reason TEXT NOT NULL,
      fallback_policy_id TEXT,
      context_window INTEGER NOT NULL,
      max_output_tokens INTEGER NOT NULL,
      binding_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS worker_context_envelopes (
      context_envelope_id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL,
      assignment_id TEXT NOT NULL,
      repository_snapshot_id TEXT,
      plan_step_ids_json TEXT NOT NULL,
      claim_ids_json TEXT NOT NULL,
      source_reference_ids_json TEXT NOT NULL,
      instruction_reference_ids_json TEXT NOT NULL,
      bounded_parent_note TEXT,
      tool_schema_digest TEXT NOT NULL,
      content_digest TEXT NOT NULL,
      token_estimate INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (repository_snapshot_id) REFERENCES repository_snapshots(snapshot_id)
    );

    CREATE TABLE IF NOT EXISTS worker_assignments (
      assignment_id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      worker_definition_id TEXT NOT NULL,
      worker_definition_version INTEGER NOT NULL,
      parent_job_id TEXT NOT NULL,
      parent_attempt_id TEXT NOT NULL,
      parent_generation INTEGER NOT NULL,
      parent_fence_digest TEXT NOT NULL,
      child_contract_id TEXT NOT NULL,
      child_job_id TEXT NOT NULL,
      repository_snapshot_id TEXT,
      execution_graph_node_id TEXT,
      context_envelope_id TEXT NOT NULL,
      provider_binding_id TEXT NOT NULL,
      capability_set_id TEXT,
      goal TEXT NOT NULL,
      expected_result_schema_id TEXT NOT NULL,
      expected_evidence_schema_id TEXT,
      input_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (parent_job_id) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (child_job_id) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (child_contract_id) REFERENCES child_job_contracts(child_job_id) ON DELETE CASCADE,
      FOREIGN KEY (repository_snapshot_id) REFERENCES repository_snapshots(snapshot_id),
      FOREIGN KEY (context_envelope_id) REFERENCES worker_context_envelopes(context_envelope_id),
      FOREIGN KEY (provider_binding_id) REFERENCES worker_provider_bindings(provider_binding_id)
    );
    CREATE INDEX IF NOT EXISTS idx_worker_assignments_parent
      ON worker_assignments(parent_job_id, parent_attempt_id, parent_generation, created_at);
    CREATE INDEX IF NOT EXISTS idx_worker_assignments_child
      ON worker_assignments(child_job_id, created_at);

    CREATE TABLE IF NOT EXISTS worker_runs (
      worker_run_id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL,
      assignment_id TEXT NOT NULL,
      child_job_id TEXT NOT NULL,
      child_attempt_id TEXT NOT NULL,
      child_generation INTEGER NOT NULL,
      execution_graph_node_id TEXT,
      provider_binding_id TEXT NOT NULL,
      context_envelope_id TEXT NOT NULL,
      accepted_result_id TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (assignment_id) REFERENCES worker_assignments(assignment_id) ON DELETE CASCADE,
      FOREIGN KEY (child_job_id) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (provider_binding_id) REFERENCES worker_provider_bindings(provider_binding_id),
      FOREIGN KEY (context_envelope_id) REFERENCES worker_context_envelopes(context_envelope_id),
      UNIQUE (child_attempt_id, child_generation),
      UNIQUE (assignment_id, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS idx_worker_runs_assignment
      ON worker_runs(assignment_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_worker_runs_child
      ON worker_runs(child_job_id, child_attempt_id, child_generation);

    CREATE TABLE IF NOT EXISTS worker_results (
      worker_result_id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL,
      worker_run_id TEXT NOT NULL,
      assignment_id TEXT NOT NULL,
      child_job_id TEXT NOT NULL,
      child_attempt_id TEXT NOT NULL,
      child_generation INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('completed','partial','failed','cancelled','timed_out','blocked','invalid')),
      summary TEXT NOT NULL,
      structured_payload_json TEXT,
      evidence_ids_json TEXT NOT NULL,
      provider_attempt_ids_json TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      result_hash TEXT NOT NULL,
      acceptance_state TEXT NOT NULL CHECK (acceptance_state IN ('received','accepted','rejected')),
      rejection_code TEXT,
      rejection_reason TEXT,
      created_at INTEGER NOT NULL,
      accepted_at INTEGER,
      rejected_at INTEGER,
      FOREIGN KEY (worker_run_id) REFERENCES worker_runs(worker_run_id) ON DELETE CASCADE,
      FOREIGN KEY (assignment_id) REFERENCES worker_assignments(assignment_id) ON DELETE CASCADE,
      FOREIGN KEY (child_job_id) REFERENCES tasks(id) ON DELETE CASCADE,
      UNIQUE (worker_run_id, idempotency_key, result_hash)
    );
    CREATE INDEX IF NOT EXISTS idx_worker_results_run
      ON worker_results(worker_run_id, created_at, worker_result_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_worker_results_final_accepted
      ON worker_results(worker_run_id)
      WHERE acceptance_state = 'accepted' AND status <> 'partial';
  `);
}

/** Durable Worker provider-call correlation and parent budget reservations. */
function applyV38(db: Database.Database): void {
  addMissingColumns(db, 'worker_provider_bindings', [
    ['supports_tool_calling', 'INTEGER NOT NULL DEFAULT 1'],
    ['supports_streaming', 'INTEGER NOT NULL DEFAULT 0'],
    ['catalog_digest', "TEXT NOT NULL DEFAULT ''"],
    ['fallback_binding_ids_json', "TEXT NOT NULL DEFAULT '[]'"],
  ]);
  db.exec(`
    CREATE TABLE IF NOT EXISTS worker_logical_provider_calls (
      logical_call_id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL,
      worker_run_id TEXT NOT NULL,
      assignment_id TEXT NOT NULL,
      provider_binding_id TEXT NOT NULL,
      child_job_id TEXT NOT NULL,
      child_attempt_id TEXT NOT NULL,
      child_generation INTEGER NOT NULL,
      call_ordinal INTEGER NOT NULL,
      request_hash TEXT NOT NULL,
      tool_schema_hash TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      fallback_policy_id TEXT,
      state TEXT NOT NULL CHECK (state IN (
        'prepared','attempting','response_received','accepted','downstream_started',
        'completed','failed','cancelled','unknown'
      )),
      accepted_provider_attempt_id TEXT,
      response_hash TEXT,
      provider_request_id TEXT,
      failure_kind TEXT,
      outcome_known INTEGER NOT NULL DEFAULT 1,
      response_received_at INTEGER,
      accepted_at INTEGER,
      downstream_started_at INTEGER,
      completed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (worker_run_id) REFERENCES worker_runs(worker_run_id) ON DELETE CASCADE,
      FOREIGN KEY (assignment_id) REFERENCES worker_assignments(assignment_id) ON DELETE CASCADE,
      FOREIGN KEY (provider_binding_id) REFERENCES worker_provider_bindings(provider_binding_id),
      FOREIGN KEY (child_job_id) REFERENCES tasks(id) ON DELETE CASCADE,
      UNIQUE (worker_run_id, idempotency_key),
      UNIQUE (worker_run_id, call_ordinal)
    );
    CREATE INDEX IF NOT EXISTS idx_worker_logical_calls_child
      ON worker_logical_provider_calls(child_job_id, child_attempt_id, child_generation, call_ordinal);

    CREATE TABLE IF NOT EXISTS worker_provider_tool_links (
      link_id TEXT PRIMARY KEY,
      logical_call_id TEXT NOT NULL,
      worker_run_id TEXT NOT NULL,
      provider_tool_call_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      arguments_hash TEXT NOT NULL,
      response_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (logical_call_id) REFERENCES worker_logical_provider_calls(logical_call_id) ON DELETE CASCADE,
      FOREIGN KEY (worker_run_id) REFERENCES worker_runs(worker_run_id) ON DELETE CASCADE,
      UNIQUE (worker_run_id, provider_tool_call_id)
    );

    CREATE TABLE IF NOT EXISTS job_budget_reservations (
      reservation_id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL,
      parent_job_id TEXT NOT NULL,
      parent_attempt_id TEXT NOT NULL,
      parent_generation INTEGER NOT NULL,
      child_job_id TEXT NOT NULL,
      child_attempt_id TEXT NOT NULL,
      child_generation INTEGER NOT NULL,
      worker_run_id TEXT NOT NULL,
      assignment_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN (
        'reserved','partially_committed','committed','released','exhausted','cancelled','reconciled'
      )),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      released_at INTEGER,
      FOREIGN KEY (parent_job_id) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (child_job_id) REFERENCES tasks(id) ON DELETE CASCADE,
      UNIQUE (parent_job_id, idempotency_key),
      UNIQUE (child_job_id)
    );
    CREATE INDEX IF NOT EXISTS idx_job_budget_reservations_parent
      ON job_budget_reservations(parent_job_id, state, created_at);

    CREATE TABLE IF NOT EXISTS job_budget_reservation_items (
      reservation_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      reserved_value REAL NOT NULL,
      committed_value REAL NOT NULL DEFAULT 0,
      released_value REAL NOT NULL DEFAULT 0,
      has_unknown_usage INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL CHECK (state IN ('reserved','partially_committed','committed','released','exhausted','unknown')),
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (reservation_id, kind),
      FOREIGN KEY (reservation_id) REFERENCES job_budget_reservations(reservation_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS job_budget_reservation_commits (
      commit_id TEXT PRIMARY KEY,
      reservation_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      amount REAL,
      certainty TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (reservation_id) REFERENCES job_budget_reservations(reservation_id) ON DELETE CASCADE,
      UNIQUE (reservation_id, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS idx_job_budget_reservation_commits_source
      ON job_budget_reservation_commits(source_kind, source_id);
  `);
}

/** Worker provider interruption and restart reconciliation metadata. */
function applyV39(db: Database.Database): void {
  addMissingColumns(db, 'worker_logical_provider_calls', [
    ['reconciliation_state', "TEXT NOT NULL DEFAULT 'not_required'"],
    ['outcome_knowledge', "TEXT NOT NULL DEFAULT 'no_request_started'"],
    ['retry_safety', "TEXT NOT NULL DEFAULT 'not_applicable'"],
    ['interruption_kind', 'TEXT'],
    ['cancellation_requested_at', 'INTEGER'],
    ['timeout_requested_at', 'INTEGER'],
    ['authority_lost_at', 'INTEGER'],
    ['stale_response_rejected_at', 'INTEGER'],
    ['late_response_observed_at', 'INTEGER'],
    ['reconciliation_started_at', 'INTEGER'],
    ['reconciled_at', 'INTEGER'],
    ['reconciliation_reason', 'TEXT'],
    ['reconciliation_version', 'INTEGER NOT NULL DEFAULT 0'],
    ['recovery_predecessor_logical_call_id', 'TEXT'],
  ]);
  addMissingColumns(db, 'job_budget_reservations', [
    ['reconciliation_state', "TEXT NOT NULL DEFAULT 'not_required'"],
    ['reconciliation_reason', 'TEXT'],
    ['unknown_spend_pending', 'INTEGER NOT NULL DEFAULT 0'],
    ['last_reconciled_at', 'INTEGER'],
    ['settlement_blocked_at', 'INTEGER'],
  ]);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_worker_logical_calls_reconciliation
      ON worker_logical_provider_calls(reconciliation_state, logical_call_id);
    CREATE INDEX IF NOT EXISTS idx_worker_budget_reconciliation
      ON job_budget_reservations(reconciliation_state, updated_at, reservation_id);

    CREATE TABLE IF NOT EXISTS worker_provider_call_reconciliations (
      reconciliation_id TEXT PRIMARY KEY,
      logical_call_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      worker_run_id TEXT NOT NULL,
      child_job_id TEXT NOT NULL,
      child_attempt_id TEXT NOT NULL,
      child_generation INTEGER NOT NULL,
      outcome_knowledge TEXT NOT NULL,
      retry_safety TEXT NOT NULL,
      reason TEXT NOT NULL,
      physical_attempt_ids_json TEXT NOT NULL DEFAULT '[]',
      unknown_spend INTEGER NOT NULL DEFAULT 0,
      unsettled_downstream INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      completed_at INTEGER,
      FOREIGN KEY (logical_call_id) REFERENCES worker_logical_provider_calls(logical_call_id) ON DELETE CASCADE,
      UNIQUE (logical_call_id, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS idx_worker_provider_reconciliations_pending
      ON worker_provider_call_reconciliations(state, created_at, reconciliation_id);

    CREATE TABLE IF NOT EXISTS worker_provider_late_responses (
      late_response_id TEXT PRIMARY KEY,
      logical_call_id TEXT NOT NULL,
      provider_attempt_id TEXT NOT NULL,
      response_hash TEXT NOT NULL,
      provider_request_id TEXT,
      reason TEXT NOT NULL,
      observed_at INTEGER NOT NULL,
      FOREIGN KEY (logical_call_id) REFERENCES worker_logical_provider_calls(logical_call_id) ON DELETE CASCADE,
      UNIQUE (logical_call_id, provider_attempt_id)
    );

    CREATE TABLE IF NOT EXISTS job_budget_reservation_reconciliations (
      reconciliation_id TEXT PRIMARY KEY,
      reservation_id TEXT NOT NULL,
      logical_call_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      outcome_knowledge TEXT NOT NULL,
      retry_safety TEXT NOT NULL,
      unknown_spend INTEGER NOT NULL DEFAULT 0,
      safe_to_release INTEGER NOT NULL DEFAULT 0,
      reason TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (reservation_id) REFERENCES job_budget_reservations(reservation_id) ON DELETE CASCADE,
      FOREIGN KEY (logical_call_id) REFERENCES worker_logical_provider_calls(logical_call_id) ON DELETE CASCADE,
      UNIQUE (reservation_id, idempotency_key)
    );
  `);
}

/** Bounded parallel read-only Worker group projections and provider slots. */
function applyV40(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS worker_groups (
      group_id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL DEFAULT 1,
      idempotency_key TEXT NOT NULL,
      parent_job_id TEXT NOT NULL,
      parent_attempt_id TEXT NOT NULL,
      parent_generation INTEGER NOT NULL,
      parent_fence_digest TEXT NOT NULL,
      policy TEXT NOT NULL CHECK(policy IN ('require_all','allow_partial')),
      state TEXT NOT NULL CHECK(state IN ('admitting','active','cancelling','timed_out','settling','settled','blocked_unknown')),
      requested_member_count INTEGER NOT NULL CHECK(requested_member_count BETWEEN 1 AND 4),
      admitted_member_count INTEGER NOT NULL DEFAULT 0,
      settled_member_count INTEGER NOT NULL DEFAULT 0,
      successful_member_count INTEGER NOT NULL DEFAULT 0,
      failed_member_count INTEGER NOT NULL DEFAULT 0,
      unknown_member_count INTEGER NOT NULL DEFAULT 0,
      cancelled_member_count INTEGER NOT NULL DEFAULT 0,
      input_hash TEXT NOT NULL,
      aggregate_hash TEXT,
      created_at INTEGER NOT NULL,
      cancellation_requested_at INTEGER,
      timeout_requested_at INTEGER,
      settled_at INTEGER,
      settlement_version INTEGER NOT NULL DEFAULT 0,
      settlement_reason TEXT,
      FOREIGN KEY (parent_job_id) REFERENCES tasks(id) ON DELETE CASCADE,
      UNIQUE (parent_job_id, parent_attempt_id, parent_generation, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS idx_worker_groups_pending
      ON worker_groups(state, created_at, group_id);
    CREATE INDEX IF NOT EXISTS idx_worker_groups_parent
      ON worker_groups(parent_job_id, parent_attempt_id, parent_generation, state, group_id);

    CREATE TABLE IF NOT EXISTS worker_group_members (
      group_id TEXT NOT NULL,
      member_id TEXT PRIMARY KEY,
      ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 1 AND 4),
      requested_provider_id TEXT NOT NULL,
      assignment_id TEXT,
      child_job_id TEXT,
      child_attempt_id TEXT,
      child_generation INTEGER,
      provider_binding_id TEXT,
      outcome TEXT NOT NULL DEFAULT 'pending' CHECK(outcome IN ('pending','admitted','verified','rejected','failed','unknown','blocked','cancelled','timed_out')),
      worker_result_id TEXT,
      result_hash TEXT,
      joined_at INTEGER,
      settlement_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (group_id) REFERENCES worker_groups(group_id) ON DELETE CASCADE,
      FOREIGN KEY (assignment_id) REFERENCES worker_assignments(assignment_id) ON DELETE RESTRICT,
      FOREIGN KEY (child_job_id) REFERENCES tasks(id) ON DELETE RESTRICT,
      FOREIGN KEY (worker_result_id) REFERENCES worker_results(worker_result_id) ON DELETE RESTRICT,
      UNIQUE (group_id, ordinal),
      UNIQUE (group_id, assignment_id),
      UNIQUE (child_job_id)
    );
    CREATE INDEX IF NOT EXISTS idx_worker_group_members_group
      ON worker_group_members(group_id, ordinal, member_id);
    CREATE INDEX IF NOT EXISTS idx_worker_group_members_unsettled
      ON worker_group_members(outcome, updated_at, member_id);

    CREATE TABLE IF NOT EXISTS worker_provider_concurrency_reservations (
      provider_slot_id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL,
      group_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      parent_job_id TEXT NOT NULL,
      parent_attempt_id TEXT NOT NULL,
      parent_generation INTEGER NOT NULL,
      provider_id TEXT NOT NULL,
      limit_value INTEGER NOT NULL CHECK(limit_value BETWEEN 1 AND 1024),
      state TEXT NOT NULL CHECK(state IN ('reserved','released','blocked_unknown')),
      created_at INTEGER NOT NULL,
      released_at INTEGER,
      blocked_at INTEGER,
      settlement_reason TEXT,
      FOREIGN KEY (group_id) REFERENCES worker_groups(group_id) ON DELETE CASCADE,
      FOREIGN KEY (member_id) REFERENCES worker_group_members(member_id) ON DELETE CASCADE,
      UNIQUE (parent_job_id, idempotency_key),
      UNIQUE (member_id)
    );
    CREATE INDEX IF NOT EXISTS idx_worker_provider_slots_capacity
      ON worker_provider_concurrency_reservations(provider_id, state, created_at, provider_slot_id);
    CREATE INDEX IF NOT EXISTS idx_worker_provider_slots_group
      ON worker_provider_concurrency_reservations(group_id, state, member_id);
  `);
}

/** Durable claim identity for cross-process TriggerBus lease fencing. */
function applyV41(db: Database.Database): void {
  addMissingColumns(db, 'trigger_events', [
    ['claim_token', 'TEXT'],
  ]);
}

/** Exact durable Effect bindings for proof Claims. */
function applyV42(db: Database.Database): void {
  addMissingColumns(db, 'job_claims', [
    ['effect_ids_json', "TEXT NOT NULL DEFAULT '[]'"],
  ]);
}

/** Durable continuity references over the existing Job/Attempt authorities. */
function applyV43(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS continuity_checkpoints (
      checkpoint_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      checkpoint_id TEXT NOT NULL UNIQUE,
      schema_version INTEGER NOT NULL DEFAULT 1,
      workspace_id TEXT,
      root_job_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      attempt_generation INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      repository_snapshot_id TEXT,
      repository_fingerprint TEXT,
      event_cursor INTEGER NOT NULL DEFAULT 0,
      proof_ids_json TEXT NOT NULL DEFAULT '[]',
      evidence_ids_json TEXT NOT NULL DEFAULT '[]',
      pending_wait_ids_json TEXT NOT NULL DEFAULT '[]',
      pending_approval_ids_json TEXT NOT NULL DEFAULT '[]',
      durable_input_cursor INTEGER NOT NULL DEFAULT 0,
      context_recipe_version INTEGER NOT NULL DEFAULT 1,
      context_recipe_digest TEXT NOT NULL,
      decisions_json TEXT NOT NULL DEFAULT '[]',
      blockers_json TEXT NOT NULL DEFAULT '[]',
      proposed_next_json TEXT NOT NULL DEFAULT '[]',
      environment_fingerprint TEXT,
      reason TEXT NOT NULL,
      validity TEXT NOT NULL CHECK(validity IN ('current','superseded','invalid')),
      idempotency_namespace TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      supersedes_checkpoint_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (job_id) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (attempt_id) REFERENCES runs(attempt_id) ON DELETE CASCADE,
      FOREIGN KEY (supersedes_checkpoint_id) REFERENCES continuity_checkpoints(checkpoint_id) ON DELETE SET NULL,
      UNIQUE (job_id, attempt_id, attempt_generation, idempotency_namespace, idempotency_key)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_continuity_one_current_per_job
      ON continuity_checkpoints(job_id) WHERE validity = 'current';
    CREATE INDEX IF NOT EXISTS idx_continuity_workspace_recent
      ON continuity_checkpoints(workspace_id, updated_at DESC, checkpoint_sequence DESC);
    CREATE INDEX IF NOT EXISTS idx_continuity_job_recent
      ON continuity_checkpoints(job_id, updated_at DESC, checkpoint_sequence DESC);
    CREATE TABLE IF NOT EXISTS continuity_actions (
      action_id TEXT PRIMARY KEY,
      checkpoint_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      decision TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (checkpoint_id) REFERENCES continuity_checkpoints(checkpoint_id) ON DELETE CASCADE,
      UNIQUE (checkpoint_id, idempotency_key)
    );
  `);
}

/** Job-scoped browser sessions, owned tabs, action receipts and bounded history. */
function applyV44(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS browser_sessions (
      browser_session_id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL DEFAULT 1,
      job_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      fence_digest TEXT NOT NULL,
      workspace_id TEXT,
      mode TEXT NOT NULL CHECK(mode IN ('owned','attached')),
      profile_identity TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN (
        'initializing','ready','user_control_required','user_control',
        'reconciling','closing','closed','lost','failed','cancelled'
      )),
      controlled_tab_id TEXT,
      recovery_state TEXT NOT NULL DEFAULT 'none',
      lease_epoch INTEGER NOT NULL DEFAULT 1,
      usage_json TEXT NOT NULL DEFAULT '{}',
      budget_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      closed_at INTEGER,
      FOREIGN KEY (job_id) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (attempt_id) REFERENCES runs(attempt_id) ON DELETE CASCADE,
      UNIQUE (job_id, attempt_id, generation)
    );
    CREATE INDEX IF NOT EXISTS idx_browser_sessions_job_state
      ON browser_sessions(job_id, state, updated_at, browser_session_id);
    CREATE INDEX IF NOT EXISTS idx_browser_sessions_attempt
      ON browser_sessions(attempt_id, generation, state);

    CREATE TABLE IF NOT EXISTS browser_tabs (
      browser_session_id TEXT NOT NULL,
      tab_id TEXT NOT NULL,
      owner_job_id TEXT NOT NULL,
      owner_attempt_id TEXT NOT NULL,
      owner_generation INTEGER NOT NULL,
      created_by TEXT NOT NULL CHECK(created_by IN ('aiden','user')),
      controlled INTEGER NOT NULL DEFAULT 0 CHECK(controlled IN (0,1)),
      opener_tab_id TEXT,
      purpose TEXT,
      url TEXT NOT NULL DEFAULT '',
      normalized_url TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      dirty_form INTEGER NOT NULL DEFAULT 0 CHECK(dirty_form IN (0,1)),
      last_state_digest TEXT,
      last_observed_at INTEGER,
      last_evidence_at INTEGER,
      close_policy TEXT NOT NULL CHECK(close_policy IN ('aiden_owned','user_owned')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      closed_at INTEGER,
      PRIMARY KEY (browser_session_id, tab_id),
      FOREIGN KEY (browser_session_id) REFERENCES browser_sessions(browser_session_id) ON DELETE CASCADE,
      FOREIGN KEY (owner_job_id) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (owner_attempt_id) REFERENCES runs(attempt_id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_browser_one_controlled_tab
      ON browser_tabs(browser_session_id) WHERE controlled = 1 AND closed_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_browser_tabs_owner
      ON browser_tabs(owner_job_id, owner_attempt_id, owner_generation, closed_at);

    CREATE TABLE IF NOT EXISTS browser_action_receipts (
      action_id TEXT PRIMARY KEY,
      browser_session_id TEXT NOT NULL,
      action_sequence INTEGER NOT NULL,
      job_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      tool_call_id TEXT,
      effect_id TEXT,
      tab_id TEXT,
      action_type TEXT NOT NULL,
      action_signature TEXT NOT NULL,
      args_digest TEXT NOT NULL,
      expected_json TEXT NOT NULL DEFAULT '{}',
      state TEXT NOT NULL CHECK(state IN (
        'prepared','dispatched','returned','verified','failed','unknown',
        'reconciling','not_applied','cancelled','stale_rejected'
      )),
      command_ok INTEGER,
      semantic_ok INTEGER,
      pre_state_digest TEXT,
      post_state_digest TEXT,
      verification_json TEXT,
      evidence_ids_json TEXT NOT NULL DEFAULT '[]',
      error_code TEXT,
      dispatched_at INTEGER,
      returned_at INTEGER,
      observed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (browser_session_id) REFERENCES browser_sessions(browser_session_id) ON DELETE CASCADE,
      FOREIGN KEY (job_id) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (attempt_id) REFERENCES runs(attempt_id) ON DELETE CASCADE,
      FOREIGN KEY (effect_id) REFERENCES side_effect_ledger(key) ON DELETE SET NULL,
      UNIQUE (browser_session_id, action_signature, created_at)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_browser_action_sequence
      ON browser_action_receipts(browser_session_id, action_sequence);
    CREATE INDEX IF NOT EXISTS idx_browser_actions_job_state
      ON browser_action_receipts(job_id, state, created_at, action_id);
    CREATE INDEX IF NOT EXISTS idx_browser_actions_effect
      ON browser_action_receipts(effect_id, state) WHERE effect_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS browser_navigation_history (
      navigation_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      browser_session_id TEXT NOT NULL,
      tab_id TEXT NOT NULL,
      normalized_url TEXT NOT NULL,
      purpose TEXT,
      state_digest TEXT,
      information_digest TEXT,
      observed_at INTEGER NOT NULL,
      FOREIGN KEY (browser_session_id) REFERENCES browser_sessions(browser_session_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_browser_navigation_recent
      ON browser_navigation_history(browser_session_id, observed_at DESC, navigation_sequence DESC);
    CREATE INDEX IF NOT EXISTS idx_browser_navigation_url
      ON browser_navigation_history(browser_session_id, normalized_url, observed_at DESC);
  `);
}

/** Provider-neutral Apps identities, version pins and opaque secret metadata. */
function applyV45(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS integration_secret_handles (
      secret_handle TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      account_id TEXT,
      label TEXT NOT NULL,
      backend TEXT NOT NULL,
      storage_ref TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK(status IN ('active','revoked')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      revoked_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_integration_secrets_scope
      ON integration_secret_handles(workspace_id, owner_id, provider_id, status);

    CREATE TABLE IF NOT EXISTS integration_provider_credentials (
      provider_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      secret_handle TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('active','revoked')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (provider_id, workspace_id, owner_id),
      FOREIGN KEY (secret_handle) REFERENCES integration_secret_handles(secret_handle) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS connected_accounts (
      account_id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      toolkit_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      label TEXT NOT NULL,
      provider_account_ref TEXT NOT NULL,
      provider_user_ref TEXT,
      secret_handle TEXT,
      hosted_auth_ref TEXT,
      status TEXT NOT NULL CHECK(status IN ('connecting','active','degraded','expired','revoked')),
      health TEXT NOT NULL CHECK(health IN (
        'unknown','healthy','degraded','insufficient_scope','expired','revoked'
      )),
      scopes_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_checked_at INTEGER,
      revoked_at INTEGER,
      FOREIGN KEY (secret_handle) REFERENCES integration_secret_handles(secret_handle) ON DELETE SET NULL,
      UNIQUE (provider_id, provider_account_ref, workspace_id, owner_id)
    );
    CREATE INDEX IF NOT EXISTS idx_connected_accounts_selection
      ON connected_accounts(workspace_id, owner_id, provider_id, toolkit_id, status, created_at);

    CREATE TABLE IF NOT EXISTS integration_job_account_bindings (
      job_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      toolkit_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      bound_attempt_id TEXT,
      bound_generation INTEGER,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (job_id, toolkit_id),
      FOREIGN KEY (job_id) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (account_id) REFERENCES connected_accounts(account_id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_integration_job_account
      ON integration_job_account_bindings(account_id, job_id);

    CREATE TABLE IF NOT EXISTS integration_connection_sessions (
      connection_id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      toolkit_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      label TEXT,
      state TEXT NOT NULL CHECK(state IN ('pending','completed','failed','expired','cancelled')),
      authorization_url TEXT,
      user_code TEXT,
      expires_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_account_id TEXT,
      reconnect_account_id TEXT,
      FOREIGN KEY (completed_account_id) REFERENCES connected_accounts(account_id) ON DELETE SET NULL,
      FOREIGN KEY (reconnect_account_id) REFERENCES connected_accounts(account_id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_integration_connections_scope
      ON integration_connection_sessions(workspace_id, owner_id, provider_id, state, created_at);

    CREATE TABLE IF NOT EXISTS integration_action_schemas (
      provider_id TEXT NOT NULL,
      toolkit_id TEXT NOT NULL,
      action_id TEXT NOT NULL,
      schema_version TEXT NOT NULL,
      provider_action_version TEXT NOT NULL,
      operation TEXT NOT NULL CHECK(operation IN ('read','mutation')),
      risk TEXT NOT NULL,
      schema_digest TEXT NOT NULL,
      input_schema_json TEXT NOT NULL,
      output_schema_json TEXT,
      discovered_at INTEGER NOT NULL,
      PRIMARY KEY (provider_id, toolkit_id, action_id, schema_version, provider_action_version)
    );
    CREATE INDEX IF NOT EXISTS idx_integration_action_current
      ON integration_action_schemas(provider_id, toolkit_id, action_id, discovered_at DESC);

    CREATE TABLE IF NOT EXISTS integration_action_receipts (
      receipt_id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      toolkit_id TEXT NOT NULL,
      action_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      schema_version TEXT NOT NULL,
      provider_action_version TEXT NOT NULL,
      request_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      reconciliation_json TEXT NOT NULL DEFAULT '{}',
      job_id TEXT,
      attempt_id TEXT,
      generation INTEGER,
      tool_call_id TEXT,
      effect_id TEXT,
      state TEXT NOT NULL CHECK(state IN (
        'prepared','dispatched','succeeded','failed','unknown','reconciling',
        'verified','not_applied','cancelled','stale_rejected'
      )),
      external_ref TEXT,
      result_digest TEXT,
      error_category TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      settled_at INTEGER,
      FOREIGN KEY (account_id) REFERENCES connected_accounts(account_id) ON DELETE RESTRICT,
      FOREIGN KEY (effect_id) REFERENCES side_effect_ledger(key) ON DELETE SET NULL,
      UNIQUE (provider_id, account_id, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS idx_integration_receipts_effect
      ON integration_action_receipts(effect_id, state) WHERE effect_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_integration_receipts_job
      ON integration_action_receipts(job_id, attempt_id, generation, created_at);

    CREATE TABLE IF NOT EXISTS integration_trigger_cursors (
      provider_id TEXT NOT NULL,
      toolkit_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      trigger_id TEXT NOT NULL,
      cursor TEXT NOT NULL,
      cursor_digest TEXT NOT NULL,
      observed_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (provider_id, toolkit_id, account_id, trigger_id),
      FOREIGN KEY (account_id) REFERENCES connected_accounts(account_id) ON DELETE CASCADE
    );
  `);
}

/** Durable authority for isolated external coding sessions. */
function applyV46(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS external_coding_capability_snapshots (
      capability_digest TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL CHECK(schema_version = 1),
      capability_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      provider_version TEXT NOT NULL,
      protocol_mode TEXT NOT NULL CHECK(protocol_mode IN ('structured','pty')),
      protocol_version TEXT NOT NULL,
      capability_json TEXT NOT NULL,
      captured_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS external_coding_workspace_leases (
      workspace_lease_id TEXT PRIMARY KEY,
      coding_session_id TEXT NOT NULL UNIQUE,
      repository_identity TEXT NOT NULL,
      source_workspace_id TEXT NOT NULL,
      source_path TEXT NOT NULL,
      worktree_path TEXT NOT NULL UNIQUE,
      base_head TEXT NOT NULL,
      base_branch TEXT,
      state TEXT NOT NULL CHECK(state IN (
        'allocating','ready','review_pending','promotion_pending',
        'reconciliation_required','released','failed'
      )),
      child_job_id TEXT NOT NULL,
      child_attempt_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      protected_paths_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      last_validated_at INTEGER NOT NULL,
      released_at INTEGER,
      FOREIGN KEY (child_job_id) REFERENCES tasks(id) ON DELETE RESTRICT,
      FOREIGN KEY (child_attempt_id) REFERENCES runs(attempt_id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_external_coding_workspaces_state
      ON external_coding_workspace_leases(state, created_at, workspace_lease_id);

    CREATE TABLE IF NOT EXISTS external_coding_repository_locks (
      repository_identity TEXT PRIMARY KEY,
      workspace_lease_id TEXT NOT NULL UNIQUE,
      coding_session_id TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL CHECK(state IN ('held','released')),
      acquired_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      released_at INTEGER,
      FOREIGN KEY (workspace_lease_id) REFERENCES external_coding_workspace_leases(workspace_lease_id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS external_coding_sessions (
      coding_session_id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL CHECK(schema_version = 1),
      idempotency_key TEXT NOT NULL UNIQUE,
      input_digest TEXT NOT NULL,
      parent_job_id TEXT NOT NULL,
      assignment_id TEXT NOT NULL UNIQUE,
      worker_run_id TEXT NOT NULL UNIQUE,
      child_job_id TEXT NOT NULL UNIQUE,
      child_attempt_id TEXT NOT NULL UNIQUE,
      child_generation INTEGER NOT NULL,
      workspace_lease_id TEXT NOT NULL UNIQUE,
      capability_digest TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      provider_version TEXT NOT NULL,
      protocol_mode TEXT NOT NULL CHECK(protocol_mode IN ('structured','pty')),
      protocol_version TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN (
        'preparing','starting','running','waiting_for_input','waiting_for_approval',
        'cancelling','process_terminal','reconciliation_required','verification_pending',
        'ready_for_review','terminal','failed','unknown'
      )),
      reconciliation_state TEXT NOT NULL CHECK(reconciliation_state IN (
        'not_required','required','inspecting','reconciled','blocked_unknown'
      )),
      next_event_sequence INTEGER NOT NULL DEFAULT 1,
      next_input_sequence INTEGER NOT NULL DEFAULT 1,
      provider_session_id TEXT,
      session_home_path TEXT NOT NULL,
      process_identity_json TEXT,
      task_envelope_json TEXT NOT NULL,
      pre_snapshot_id TEXT,
      post_snapshot_id TEXT,
      result_ref TEXT,
      validation_refs_json TEXT NOT NULL DEFAULT '[]',
      cancellation_requested_at INTEGER,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      last_activity_at INTEGER NOT NULL,
      terminal_at INTEGER,
      FOREIGN KEY (parent_job_id) REFERENCES tasks(id) ON DELETE RESTRICT,
      FOREIGN KEY (assignment_id) REFERENCES worker_assignments(assignment_id) ON DELETE RESTRICT,
      FOREIGN KEY (worker_run_id) REFERENCES worker_runs(worker_run_id) ON DELETE RESTRICT,
      FOREIGN KEY (child_job_id) REFERENCES tasks(id) ON DELETE RESTRICT,
      FOREIGN KEY (child_attempt_id) REFERENCES runs(attempt_id) ON DELETE RESTRICT,
      FOREIGN KEY (workspace_lease_id) REFERENCES external_coding_workspace_leases(workspace_lease_id) ON DELETE RESTRICT,
      FOREIGN KEY (capability_digest) REFERENCES external_coding_capability_snapshots(capability_digest) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_external_coding_sessions_parent
      ON external_coding_sessions(parent_job_id, created_at, coding_session_id);
    CREATE INDEX IF NOT EXISTS idx_external_coding_sessions_state
      ON external_coding_sessions(state, reconciliation_state, last_activity_at);

    CREATE TABLE IF NOT EXISTS external_coding_events (
      event_id TEXT PRIMARY KEY,
      coding_session_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      child_attempt_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      payload_digest TEXT NOT NULL,
      producer TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      authoritative INTEGER NOT NULL DEFAULT 1 CHECK(authoritative IN (0,1)),
      created_at INTEGER NOT NULL,
      FOREIGN KEY (coding_session_id) REFERENCES external_coding_sessions(coding_session_id) ON DELETE CASCADE,
      UNIQUE (coding_session_id, sequence),
      UNIQUE (coding_session_id, idempotency_key)
    );

    CREATE TABLE IF NOT EXISTS external_coding_inputs (
      input_id TEXT PRIMARY KEY,
      coding_session_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      request_id TEXT NOT NULL,
      child_attempt_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('task','clarification','approval','control')),
      content TEXT NOT NULL,
      content_digest TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('accepted','delivered','rejected_stale')),
      idempotency_key TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      delivered_at INTEGER,
      FOREIGN KEY (coding_session_id) REFERENCES external_coding_sessions(coding_session_id) ON DELETE CASCADE,
      UNIQUE (coding_session_id, sequence),
      UNIQUE (coding_session_id, idempotency_key)
    );

    CREATE TABLE IF NOT EXISTS external_coding_processes (
      process_record_id TEXT PRIMARY KEY,
      coding_session_id TEXT NOT NULL UNIQUE,
      child_attempt_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      pid INTEGER NOT NULL,
      start_time INTEGER,
      executable TEXT NOT NULL,
      executable_version TEXT NOT NULL,
      cwd TEXT NOT NULL,
      protocol_mode TEXT NOT NULL CHECK(protocol_mode IN ('structured','pty')),
      state TEXT NOT NULL CHECK(state IN ('starting','running','stopping','exited','unknown')),
      exit_code INTEGER,
      exit_signal TEXT,
      tree_dead_verified INTEGER NOT NULL DEFAULT 0 CHECK(tree_dead_verified IN (0,1)),
      created_at INTEGER NOT NULL,
      exited_at INTEGER,
      FOREIGN KEY (coding_session_id) REFERENCES external_coding_sessions(coding_session_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS external_coding_raw_output (
      coding_session_id TEXT NOT NULL,
      chunk_sequence INTEGER NOT NULL,
      stream TEXT NOT NULL CHECK(stream IN ('stdout','stderr','pty')),
      content TEXT NOT NULL,
      content_digest TEXT NOT NULL,
      byte_count INTEGER NOT NULL,
      truncated INTEGER NOT NULL DEFAULT 0 CHECK(truncated IN (0,1)),
      created_at INTEGER NOT NULL,
      PRIMARY KEY (coding_session_id, chunk_sequence),
      FOREIGN KEY (coding_session_id) REFERENCES external_coding_sessions(coding_session_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS external_coding_mutation_receipts (
      receipt_id TEXT PRIMARY KEY,
      coding_session_id TEXT NOT NULL,
      workspace_lease_id TEXT NOT NULL,
      pre_snapshot_id TEXT NOT NULL,
      post_snapshot_id TEXT,
      changed_paths_json TEXT NOT NULL DEFAULT '[]',
      protected_path_violations_json TEXT NOT NULL DEFAULT '[]',
      unexpected_paths_json TEXT NOT NULL DEFAULT '[]',
      reported_files_json TEXT NOT NULL DEFAULT '[]',
      report_mismatch INTEGER NOT NULL DEFAULT 0 CHECK(report_mismatch IN (0,1)),
      reported_result_digest TEXT,
      observed_diff_digest TEXT,
      state TEXT NOT NULL CHECK(state IN (
        'prepared','observed','verified','rejected','unknown','reconciliation_required'
      )),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (coding_session_id) REFERENCES external_coding_sessions(coding_session_id) ON DELETE RESTRICT,
      FOREIGN KEY (workspace_lease_id) REFERENCES external_coding_workspace_leases(workspace_lease_id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS external_coding_promotion_plans (
      promotion_id TEXT PRIMARY KEY,
      coding_session_id TEXT NOT NULL UNIQUE,
      workspace_lease_id TEXT NOT NULL,
      parent_job_id TEXT NOT NULL,
      parent_attempt_id TEXT NOT NULL,
      parent_generation INTEGER NOT NULL,
      promotion_job_id TEXT,
      promotion_attempt_id TEXT,
      promotion_generation INTEGER,
      mutation_receipt_id TEXT NOT NULL,
      target_snapshot_id TEXT NOT NULL,
      candidate_snapshot_id TEXT NOT NULL,
      target_head TEXT NOT NULL,
      candidate_head TEXT NOT NULL,
      target_state_digest TEXT NOT NULL,
      plan_digest TEXT NOT NULL,
      changed_paths_json TEXT NOT NULL,
      blocked_reason TEXT,
      change_record_ids_json TEXT NOT NULL,
      validation_refs_json TEXT NOT NULL,
      approval_id TEXT,
      state TEXT NOT NULL CHECK(state IN (
        'prepared','approval_required','approved','applying','applied','blocked_drift','rejected','unknown'
      )),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      applied_at INTEGER,
      FOREIGN KEY (coding_session_id) REFERENCES external_coding_sessions(coding_session_id) ON DELETE RESTRICT,
      FOREIGN KEY (workspace_lease_id) REFERENCES external_coding_workspace_leases(workspace_lease_id) ON DELETE RESTRICT,
      FOREIGN KEY (parent_job_id) REFERENCES tasks(id) ON DELETE RESTRICT,
      FOREIGN KEY (parent_attempt_id) REFERENCES runs(attempt_id) ON DELETE RESTRICT,
      FOREIGN KEY (promotion_job_id) REFERENCES tasks(id) ON DELETE RESTRICT,
      FOREIGN KEY (promotion_attempt_id) REFERENCES runs(attempt_id) ON DELETE RESTRICT,
      FOREIGN KEY (mutation_receipt_id) REFERENCES external_coding_mutation_receipts(receipt_id) ON DELETE RESTRICT,
      FOREIGN KEY (target_snapshot_id) REFERENCES repository_snapshots(snapshot_id) ON DELETE RESTRICT,
      FOREIGN KEY (candidate_snapshot_id) REFERENCES repository_snapshots(snapshot_id) ON DELETE RESTRICT
    );
  `);
}

/** Keep the provider's terminal candidate distinct from its mutation receipt. */
function applyV47(db: Database.Database): void {
  addMissingColumns(db, 'external_coding_sessions', [
    ['candidate_result_ref', 'TEXT'],
  ]);
}

/** Reliable automation definitions, immutable revisions, occurrences and trigger bindings. */
function applyV48(db: Database.Database): void {
  addMissingColumns(db, 'tasks', [
    ['automation_id', 'TEXT'],
    ['automation_revision_id', 'TEXT'],
    ['automation_occurrence_id', 'TEXT'],
  ]);
  db.exec(`
    CREATE TABLE IF NOT EXISTS automation_definitions (
      automation_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
      current_revision_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      workspace_id TEXT,
      commercial_context TEXT NOT NULL DEFAULT 'pro',
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS automation_revisions (
      revision_id TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL,
      revision_number INTEGER NOT NULL,
      spec_json TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(automation_id,revision_number),
      FOREIGN KEY (automation_id) REFERENCES automation_definitions(automation_id) ON DELETE RESTRICT
    );

    CREATE TRIGGER IF NOT EXISTS automation_revisions_immutable_update
      BEFORE UPDATE ON automation_revisions
      BEGIN SELECT RAISE(ABORT, 'automation revisions are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS automation_revisions_immutable_delete
      BEFORE DELETE ON automation_revisions
      BEGIN SELECT RAISE(ABORT, 'automation revisions are immutable'); END;

    CREATE TABLE IF NOT EXISTS automation_occurrences (
      occurrence_id TEXT PRIMARY KEY,
      occurrence_key TEXT NOT NULL UNIQUE,
      automation_id TEXT NOT NULL,
      revision_id TEXT NOT NULL,
      trigger_kind TEXT NOT NULL,
      source_identity TEXT NOT NULL,
      scheduled_for TEXT,
      triggered_at INTEGER NOT NULL,
      admitted_at INTEGER,
      trigger_event_id INTEGER,
      job_id TEXT,
      attempt_id TEXT,
      state TEXT NOT NULL,
      replay_of_occurrence_id TEXT,
      detail_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      terminal_at INTEGER,
      FOREIGN KEY (automation_id) REFERENCES automation_definitions(automation_id) ON DELETE RESTRICT,
      FOREIGN KEY (revision_id) REFERENCES automation_revisions(revision_id) ON DELETE RESTRICT,
      FOREIGN KEY (trigger_event_id) REFERENCES trigger_events(id) ON DELETE RESTRICT,
      FOREIGN KEY (job_id) REFERENCES tasks(id) ON DELETE RESTRICT,
      FOREIGN KEY (attempt_id) REFERENCES runs(attempt_id) ON DELETE RESTRICT,
      FOREIGN KEY (replay_of_occurrence_id) REFERENCES automation_occurrences(occurrence_id) ON DELETE RESTRICT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_occurrence_job
      ON automation_occurrences(job_id) WHERE job_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_automation_occurrences_history
      ON automation_occurrences(automation_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_automation_occurrences_active
      ON automation_occurrences(automation_id,state,created_at)
      WHERE state IN ('detected','admitted','queued_overlap','waiting_approval','running','unknown');

    CREATE TABLE IF NOT EXISTS automation_trigger_bindings (
      binding_id TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL,
      revision_id TEXT NOT NULL,
      trigger_kind TEXT NOT NULL,
      source_key TEXT,
      schedule_expression TEXT,
      timezone TEXT,
      next_fire_at TEXT,
      last_scanned_at INTEGER,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(automation_id,revision_id,trigger_kind,source_key),
      FOREIGN KEY (automation_id) REFERENCES automation_definitions(automation_id) ON DELETE RESTRICT,
      FOREIGN KEY (revision_id) REFERENCES automation_revisions(revision_id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_automation_bindings_due
      ON automation_trigger_bindings(enabled,next_fire_at,binding_id)
      WHERE enabled = 1 AND next_fire_at IS NOT NULL;

    CREATE TABLE IF NOT EXISTS automation_migration_receipts (
      source_kind TEXT NOT NULL,
      source_identity TEXT NOT NULL,
      source_digest TEXT NOT NULL,
      automation_id TEXT NOT NULL,
      revision_id TEXT NOT NULL,
      imported_at INTEGER NOT NULL,
      PRIMARY KEY(source_kind,source_identity),
      FOREIGN KEY (automation_id) REFERENCES automation_definitions(automation_id) ON DELETE RESTRICT,
      FOREIGN KEY (revision_id) REFERENCES automation_revisions(revision_id) ON DELETE RESTRICT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_automation_occurrence
      ON tasks(automation_occurrence_id) WHERE automation_occurrence_id IS NOT NULL;
  `);
}

/** Restart-safe ScriptSpec cursor and exact pending Approval identity. */
function applyV49(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS automation_approval_continuations (
      continuation_id TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL,
      revision_id TEXT NOT NULL,
      occurrence_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      fence_token_digest TEXT NOT NULL,
      script_spec_json TEXT NOT NULL,
      script_spec_digest TEXT NOT NULL,
      step_index INTEGER NOT NULL CHECK(step_index >= 0),
      tool_call_id TEXT NOT NULL,
      effect_id TEXT,
      action_digest TEXT,
      policy_snapshot_id TEXT,
      approval_id TEXT UNIQUE,
      state TEXT NOT NULL CHECK(state IN (
        'preparing','waiting_approval','claimed','approved','denied',
        'cancelled','consumed','unknown'
      )),
      claim_owner TEXT,
      claim_token TEXT,
      claim_expires_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      terminal_at INTEGER,
      UNIQUE(job_id,attempt_id,generation,step_index),
      UNIQUE(job_id,attempt_id,generation,tool_call_id),
      FOREIGN KEY (automation_id) REFERENCES automation_definitions(automation_id) ON DELETE RESTRICT,
      FOREIGN KEY (revision_id) REFERENCES automation_revisions(revision_id) ON DELETE RESTRICT,
      FOREIGN KEY (occurrence_id) REFERENCES automation_occurrences(occurrence_id) ON DELETE RESTRICT,
      FOREIGN KEY (job_id) REFERENCES tasks(id) ON DELETE RESTRICT,
      FOREIGN KEY (attempt_id) REFERENCES runs(attempt_id) ON DELETE RESTRICT,
      FOREIGN KEY (approval_id) REFERENCES approvals(approval_id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_automation_approval_continuations_active
      ON automation_approval_continuations(job_id,state,step_index)
      WHERE state IN ('preparing','waiting_approval','claimed','approved','unknown');
    CREATE INDEX IF NOT EXISTS idx_automation_approval_continuations_claim
      ON automation_approval_continuations(state,claim_expires_at);
  `);
}

const MIGRATIONS: ReadonlyArray<Migration> = [
  { version: 1, name: 'phase 1 — daemon foundation',                  sql: V1_SQL },
  { version: 2, name: 'phase 2 — file watcher observations',          sql: V2_SQL },
  { version: 3, name: 'phase 3 — webhook deliveries log',             sql: V3_SQL },
  { version: 4, name: 'phase 4a — email seen forensic table',         sql: V4_SQL },
  { version: 5, name: 'phase 5b — scheduled workflows',               sql: V5_SQL },
  { version: 6, name: 'v4.6 phase 1 — sub-agent lineage',             sql: V6_SQL },
  { version: 7, name: 'v4.6 phase 3b — self-improvement loop',        sql: V7_SQL },
  { version: 8, name: 'v4.9 slice 4 — daemon identity + incarnations', sql: V8_SQL },
  { version: 9, name: 'v4.9 slice 5 — durable run queue',              sql: V9_SQL },
  { version: 10, name: 'v4.9 slice 7 — external trace adoption',       sql: V10_SQL },
  { version: 11, name: 'v4.9 slice 12a — hook system',                  sql: V11_SQL },
  { version: 12, name: 'v4.9 slice 12b — hook auto-disable counter',    sql: V12_SQL },
  { version: 13, name: 'v4.10 slice 10.2b — run_events richer schema',  sql: V13_SQL },
  { version: 14, name: 'v4.10 slice 10.8 — durable Task-lite kernel',   sql: V14_SQL },
  { version: 15, name: 'v4.11 — artifact registry with provenance',     sql: V15_SQL },
  { version: 16, name: 'v4.13 gap 1 — task verification evidence',      sql: V16_SQL },
  { version: 17, name: 'v4.13 gap 3 — job-card columns',                sql: V17_SQL },
  { version: 18, name: 'v4.13 gap 4 — resume linkage + wake-loop cap',   sql: V18_SQL },
  { version: 19, name: 'v4.12.1 — side-effect idempotency ledger',        sql: V19_SQL },
  { version: 20, name: 'v4.15.1 — durable Job and Attempt foundation',    apply: applyV20 },
  { version: 21, name: 'v4.15.1 - durable input and approval authority', apply: applyV21 },
  { version: 22, name: 'durable effect contracts', apply: applyV22 },
  { version: 23, name: 'append-only effect reconciliation', apply: applyV23 },
  { version: 24, name: 'durable execution graph', apply: applyV24 },
  { version: 25, name: 'durable waits and continuations', apply: applyV25 },
  { version: 26, name: 'exact approval fence binding', apply: applyV26 },
  { version: 27, name: 'durable child Job contracts', apply: applyV27 },
  { version: 28, name: 'durable budgets and capabilities', apply: applyV28 },
  { version: 29, name: 'durable claims evidence and verdicts', apply: applyV29 },
  { version: 30, name: 'durable Job event cursors', apply: applyV30 },
  { version: 31, name: 'kernel projection query indexes', apply: applyV31 },
  { version: 32, name: 'immutable repository snapshots', apply: applyV32 },
  { version: 33, name: 'source-fenced repository changes', apply: applyV33 },
  { version: 34, name: 'snapshot-bound structured validation', apply: applyV34 },
  { version: 35, name: 'durable Git effects and reconciliation', apply: applyV35 },
  { version: 36, name: 'repository understanding and durable coding plans', apply: applyV36 },
  { version: 37, name: 'durable Worker contracts and authority boundaries', apply: applyV37 },
  { version: 38, name: 'durable Worker provider calls and budget reservations', apply: applyV38 },
  { version: 39, name: 'Worker provider restart and reconciliation', apply: applyV39 },
  { version: 40, name: 'bounded parallel read-only Worker groups', apply: applyV40 },
  { version: 41, name: 'durable TriggerBus claim fencing', apply: applyV41 },
  { version: 42, name: 'exact Claim Effect bindings', apply: applyV42 },
  { version: 43, name: 'durable continuity checkpoints', apply: applyV43 },
  { version: 44, name: 'durable browser operator authority', apply: applyV44 },
  { version: 45, name: 'provider-neutral Apps authority', apply: applyV45 },
  { version: 46, name: 'durable external coding session authority', apply: applyV46 },
  { version: 47, name: 'durable external coding candidate recovery', apply: applyV47 },
  { version: 48, name: 'reliable automation authority', apply: applyV48 },
  { version: 49, name: 'durable automation approval continuation', apply: applyV49 },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

/**
 * v4.10 Slice 10.2b — exposed for the v13 migration smoke test, which
 * needs to apply migrations up to a target version (not all the way
 * to LATEST). Production callers should use `runMigrations(db)` —
 * this constant is for diagnostic + test surfaces only.
 */
export const MIGRATIONS_FOR_TESTS = MIGRATIONS;

function getCurrentVersion(db: Database.Database): number {
  // The schema_version table may not exist yet on first boot. Detect
  // via sqlite_master so we don't trip the migration runner on a
  // fresh database.
  const row = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'",
    )
    .get() as { name?: string } | undefined;
  if (!row?.name) return 0;
  const verRow = db
    .prepare('SELECT version FROM schema_version WHERE id = 1')
    .get() as { version?: number } | undefined;
  return verRow?.version ?? 0;
}

function tableExists(db: Database.Database, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

function validateLatestSchema(db: Database.Database): void {
  const required = ['tasks', 'runs', 'run_events', 'side_effect_ledger', 'durable_inputs',
    'workspace_descriptors', 'repository_snapshots', 'repository_snapshot_entries',
    'repository_change_intents', 'repository_change_records', 'validation_runs',
    'test_run_details', 'build_run_details', 'validation_artifacts', 'validation_diagnostics',
    'git_effect_operations', 'repository_understanding_indexes', 'repository_understanding_records',
    'repository_understanding_snapshot_records', 'repository_architecture_notes',
    'execution_graph_node_references', 'worker_assignments', 'worker_runs',
    'worker_provider_bindings', 'worker_context_envelopes', 'worker_results',
    'worker_logical_provider_calls', 'worker_provider_tool_links', 'job_budget_reservations',
    'job_budget_reservation_items', 'job_budget_reservation_commits',
    'worker_provider_call_reconciliations', 'worker_provider_late_responses',
    'job_budget_reservation_reconciliations', 'worker_groups', 'worker_group_members',
    'worker_provider_concurrency_reservations', 'continuity_checkpoints',
    'continuity_actions', 'browser_sessions', 'browser_tabs',
    'browser_action_receipts', 'browser_navigation_history',
    'integration_secret_handles', 'integration_provider_credentials',
    'connected_accounts', 'integration_job_account_bindings',
    'integration_connection_sessions', 'integration_action_schemas',
    'integration_action_receipts', 'integration_trigger_cursors',
    'external_coding_capability_snapshots', 'external_coding_workspace_leases',
    'external_coding_repository_locks', 'external_coding_sessions',
    'external_coding_events', 'external_coding_inputs', 'external_coding_processes',
    'external_coding_raw_output', 'external_coding_mutation_receipts',
    'external_coding_promotion_plans', 'automation_definitions',
    'automation_revisions', 'automation_occurrences', 'automation_trigger_bindings',
    'automation_migration_receipts', 'automation_approval_continuations'];
  const missing = required.filter((table) => !tableExists(db, table));
  if (missing.length > 0) throw new Error(`Database schema is incomplete at version ${LATEST_SCHEMA_VERSION}: missing ${missing.join(', ')}`);
  if (!tableExists(db, 'job_event_cursors')) {
    db.transaction(() => applyV30(db)).immediate();
  }
}

/**
 * Apply every pending migration. Idempotent: re-running a database
 * already at the latest version is a no-op.
 */
export function runMigrations(db: Database.Database): { from: number; to: number } {
  const from = getCurrentVersion(db);
  const pending = MIGRATIONS.filter((m) => m.version > from);
  if (pending.length === 0) {
    validateLatestSchema(db);
    return { from, to: from };
  }
  const apply = db.transaction((m: Migration): void => {
    if (m.apply) m.apply(db);
    else db.exec(m.sql ?? '');
    db.prepare(
      'INSERT OR REPLACE INTO schema_version (id, version, applied_at) VALUES (1, ?, ?)',
    ).run(m.version, Date.now());
  }).immediate;
  let to = from;
  for (const m of pending) {
    try {
      apply(m);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const wrapped = new Error(`Migration ${m.version} (${m.name}) failed: ${detail}`) as Error & { cause?: unknown };
      wrapped.cause = error;
      throw wrapped;
    }
    to = m.version;
  }
  validateLatestSchema(db);
  return { from, to };
}
