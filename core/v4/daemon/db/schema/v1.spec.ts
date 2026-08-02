/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/daemon/db/schema/v1.spec.ts — v4.5 Phase 1: typed shapes
 * matching the columns in `v1.sql`. Used by the daemon modules
 * that read/write SQLite rows so we have one type per table that
 * stays in sync with the DDL.
 *
 * Naming convention: column names from SQL stay snake_case; TS
 * row interfaces use camelCase aliases via the mapping helpers
 * inside each module. These raw interfaces match the wire shape.
 */

export interface SchemaVersionRow {
  id:         1;
  version:    number;
  applied_at: number;
}

export interface DaemonInstanceRowSql {
  instance_id:     string;
  pid:             number;
  hostname:        string;
  started_at:      number;
  last_heartbeat:  number;
  shutdown_at:     number | null;
  shutdown_reason: string | null;
  exit_code:       number | null;
  version:         string;
}

export interface RunRowSql {
  id:               number;
  trigger_event_id: number | null;
  session_id:       string;
  instance_id:      string;
  status:           string;
  finish_reason:    string | null;
  started_at:       number;
  completed_at:     number | null;
  resume_pending:   number;            // 0/1 SQLite bool
  resume_reason:    string | null;
}

export interface TriggerEventRowSql {
  id:               number;
  source:           string;
  source_key:       string;
  idempotency_key:  string | null;
  payload_json:     string;
  status:           string;
  attempts:         number;
  claim_owner:      string | null;
  claim_token:      string | null;
  claim_expires_at: number | null;
  last_error:       string | null;
  created_at:       number;
  updated_at:       number;
  completed_at:     number | null;
  run_id:           number | null;
}

export interface RunEventRowSql {
  id:      number;
  run_id:  number;
  ts:      number;
  kind:    string;
  payload: string;
}

export interface IdempotencyKeyRowSql {
  scope:         string;
  key:           string;
  fingerprint:   string | null;
  response_json: string;
  status_code:   number;
  created_at:    number;
  expires_at:    number;
}

export interface CrashReportRowSql {
  id:                  number;
  instance_id:         string;
  detected_at:         number;
  prev_started_at:     number | null;
  prev_last_heartbeat: number | null;
  prev_pid:            number | null;
  affected_sessions:   string;
  ps_snapshot:         string | null;
  details:             string;
}

export interface RestartFailureCountRowSql {
  session_id:     string;
  count:          number;
  last_failure:   number;
  auto_suspended: number;
}

export interface TriggerRowSql {
  id:              string;
  source:          string;
  name:            string;
  spec_json:       string;
  enabled:         number;
  fire_rate_limit: number | null;
  prompt_template: string | null;
  deliver_only:    number;
  created_at:      number;
  updated_at:      number;
}
