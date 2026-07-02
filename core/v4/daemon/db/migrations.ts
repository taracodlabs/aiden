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

interface Migration {
  version: number;
  name:    string;
  sql:     string;
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

/**
 * Apply every pending migration. Idempotent: re-running a database
 * already at the latest version is a no-op.
 */
export function runMigrations(db: Database.Database): { from: number; to: number } {
  const from = getCurrentVersion(db);
  const pending = MIGRATIONS.filter((m) => m.version > from);
  if (pending.length === 0) return { from, to: from };
  const apply = db.transaction((m: Migration): void => {
    db.exec(m.sql);
    db.prepare(
      'INSERT OR REPLACE INTO schema_version (id, version, applied_at) VALUES (1, ?, ?)',
    ).run(m.version, Date.now());
  });
  let to = from;
  for (const m of pending) {
    apply(m);
    to = m.version;
  }
  return { from, to };
}
