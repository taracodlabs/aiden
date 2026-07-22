/**
 * Persistent accounting for physical provider attempts.
 *
 * The ledger stores normalized measurements only. Prompts, provider response
 * bodies, authorization values, and unsanitized provider metadata never cross
 * this boundary.
 */

import Database from 'better-sqlite3';
import type { Database as DatabaseType, Statement } from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

import type { ApiMode } from '../../providers/v4/types';

export type ProviderAttemptPurpose =
  | 'primary'
  | 'retry'
  | 'fallback'
  | 'auxiliary'
  | 'compression'
  | 'distillation'
  | 'subagent'
  | 'aggregation'
  | 'setup'
  | 'readiness'
  | 'title'
  | 'memory_review'
  | 'legacy_api';

export type ProviderAttemptStatus =
  | 'success'
  | 'failed_before_send'
  | 'failed_after_send'
  | 'timeout'
  | 'interrupted'
  | 'provider_error'
  | 'validation_error';

export type ProviderUsageSource =
  | 'provider_reported'
  | 'locally_estimated'
  | 'partially_estimated'
  | 'unknown';

export type ProviderCostStatus = 'actual' | 'estimated' | 'included' | 'unknown';

export type UsageMode = 'economy' | 'balanced' | 'thorough';

export interface ProviderAttemptRecord {
  readonly callId: string;
  readonly parentCallId: string | null;
  readonly sessionId: string | null;
  readonly taskId: string | null;
  readonly runId: string | null;
  readonly entryPoint: string;
  readonly purpose: ProviderAttemptPurpose;
  readonly providerConfigured: string | null;
  readonly providerActual: string | null;
  readonly modelConfigured: string | null;
  readonly modelActual: string | null;
  readonly apiMode: ApiMode | null;
  readonly transport: string | null;
  readonly attemptIndex: number;
  readonly fallbackIndex: number;
  readonly credentialLabelRedacted: string | null;
  readonly status: ProviderAttemptStatus;
  readonly errorClass: string | null;
  readonly startedAt: number;
  readonly completedAt: number;
  readonly estimatedInputTokens: number | null;
  readonly estimatedOutputTokens: number | null;
  readonly estimatedSchemaTokens: number | null;
  readonly estimatedImageTokens: number | null;
  readonly providerInputTokens: number | null;
  readonly providerOutputTokens: number | null;
  readonly providerCacheReadTokens: number | null;
  readonly providerCacheWriteTokens: number | null;
  readonly providerReasoningTokens: number | null;
  readonly requestBytes: number | null;
  readonly responseBytes: number | null;
  readonly usageSource: ProviderUsageSource;
  readonly costAmount: number | null;
  readonly costCurrency: string | null;
  readonly costStatus: ProviderCostStatus;
  readonly costSource: string | null;
  readonly contextSnapshotId: string | null;
  readonly toolSchemaSnapshotId: string | null;
  readonly coreSchemaCount: number | null;
  readonly mcpSchemaCount: number | null;
  readonly pluginSchemaCount: number | null;
  readonly deferredSchemaCount: number | null;
  readonly serializedSchemaBytes: number | null;
  readonly selectedProfile: string | null;
  readonly selectedMode: UsageMode | null;
  readonly rawToolResultBytes: number | null;
  readonly transmittedToolResultBytes: number | null;
  readonly memoryTokens: number | null;
  readonly userProfileTokens: number | null;
  readonly projectMemoryTokens: number | null;
  readonly skillIndexTokens: number | null;
  readonly loadedSkillTokens: number | null;
}

export interface ProviderAttemptQuery {
  callId?: string;
  parentCallId?: string;
  sessionId?: string;
  taskId?: string;
  runId?: string;
  provider?: string;
  model?: string;
  purpose?: ProviderAttemptPurpose;
  status?: ProviderAttemptStatus;
  since?: number;
  until?: number;
  limit?: number;
}

export interface UsageProjectionQuery extends ProviderAttemptQuery {
  /** Setup/readiness are queryable but excluded from user-task totals by default. */
  includeSetup?: boolean;
}

export interface ProviderUsageProjection {
  physicalAttempts: number;
  successfulAttempts: number;
  failedAttempts: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedSchemaTokens: number;
  estimatedImageTokens: number;
  providerInputTokens: number;
  providerOutputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  requestBytes: number;
  responseBytes: number;
  rawToolResultBytes: number;
  transmittedToolResultBytes: number;
  memoryTokens: number;
  userProfileTokens: number;
  projectMemoryTokens: number;
  skillIndexTokens: number;
  loadedSkillTokens: number;
  coreSchemaCount: number;
  mcpSchemaCount: number;
  pluginSchemaCount: number;
  deferredSchemaCount: number;
  knownCostAmount: number;
  costCurrency: string | null;
  unknownCostAttempts: number;
  providerReportedAttempts: number;
  estimatedAttempts: number;
}

interface ProviderAttemptRow {
  call_id: string;
  parent_call_id: string | null;
  session_id: string | null;
  task_id: string | null;
  run_id: string | null;
  entry_point: string;
  purpose: ProviderAttemptPurpose;
  provider_configured: string | null;
  provider_actual: string | null;
  model_configured: string | null;
  model_actual: string | null;
  api_mode: ApiMode | null;
  transport: string | null;
  attempt_index: number;
  fallback_index: number;
  credential_label_redacted: string | null;
  status: ProviderAttemptStatus;
  error_class: string | null;
  started_at: number;
  completed_at: number;
  estimated_input_tokens: number | null;
  estimated_output_tokens: number | null;
  estimated_schema_tokens: number | null;
  estimated_image_tokens: number | null;
  provider_input_tokens: number | null;
  provider_output_tokens: number | null;
  provider_cache_read_tokens: number | null;
  provider_cache_write_tokens: number | null;
  provider_reasoning_tokens: number | null;
  request_bytes: number | null;
  response_bytes: number | null;
  usage_source: ProviderUsageSource;
  cost_amount: number | null;
  cost_currency: string | null;
  cost_status: ProviderCostStatus;
  cost_source: string | null;
  context_snapshot_id: string | null;
  tool_schema_snapshot_id: string | null;
  core_schema_count: number | null;
  mcp_schema_count: number | null;
  plugin_schema_count: number | null;
  deferred_schema_count: number | null;
  serialized_schema_bytes: number | null;
  selected_profile: string | null;
  selected_mode: UsageMode | null;
  raw_tool_result_bytes: number | null;
  transmitted_tool_result_bytes: number | null;
  memory_tokens: number | null;
  user_profile_tokens: number | null;
  project_memory_tokens: number | null;
  skill_index_tokens: number | null;
  loaded_skill_tokens: number | null;
}

const LEDGER_SCHEMA_VERSION = 2;

const LEDGER_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS provider_attempt_ledger_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_attempts (
  call_id TEXT PRIMARY KEY,
  parent_call_id TEXT,
  session_id TEXT,
  task_id TEXT,
  run_id TEXT,
  entry_point TEXT NOT NULL,
  purpose TEXT NOT NULL,
  provider_configured TEXT,
  provider_actual TEXT,
  model_configured TEXT,
  model_actual TEXT,
  api_mode TEXT,
  transport TEXT,
  attempt_index INTEGER NOT NULL,
  fallback_index INTEGER NOT NULL,
  credential_label_redacted TEXT,
  status TEXT NOT NULL,
  error_class TEXT,
  started_at INTEGER NOT NULL,
  completed_at INTEGER NOT NULL,
  estimated_input_tokens INTEGER,
  estimated_output_tokens INTEGER,
  estimated_schema_tokens INTEGER,
  estimated_image_tokens INTEGER,
  provider_input_tokens INTEGER,
  provider_output_tokens INTEGER,
  provider_cache_read_tokens INTEGER,
  provider_cache_write_tokens INTEGER,
  provider_reasoning_tokens INTEGER,
  request_bytes INTEGER,
  response_bytes INTEGER,
  usage_source TEXT NOT NULL,
  cost_amount REAL,
  cost_currency TEXT,
  cost_status TEXT NOT NULL,
  cost_source TEXT,
  context_snapshot_id TEXT,
  tool_schema_snapshot_id TEXT,
  core_schema_count INTEGER,
  mcp_schema_count INTEGER,
  plugin_schema_count INTEGER,
  deferred_schema_count INTEGER,
  serialized_schema_bytes INTEGER,
  selected_profile TEXT,
  selected_mode TEXT,
  raw_tool_result_bytes INTEGER,
  transmitted_tool_result_bytes INTEGER,
  memory_tokens INTEGER,
  user_profile_tokens INTEGER,
  project_memory_tokens INTEGER,
  skill_index_tokens INTEGER,
  loaded_skill_tokens INTEGER
);

CREATE INDEX IF NOT EXISTS idx_provider_attempts_session
  ON provider_attempts(session_id, started_at);
CREATE INDEX IF NOT EXISTS idx_provider_attempts_run
  ON provider_attempts(run_id, started_at);
CREATE INDEX IF NOT EXISTS idx_provider_attempts_task
  ON provider_attempts(task_id, started_at);
CREATE INDEX IF NOT EXISTS idx_provider_attempts_parent
  ON provider_attempts(parent_call_id, started_at);
CREATE INDEX IF NOT EXISTS idx_provider_attempts_provider_model
  ON provider_attempts(provider_actual, model_actual, started_at);
CREATE INDEX IF NOT EXISTS idx_provider_attempts_purpose_status
  ON provider_attempts(purpose, status, started_at);
`;

const INSERT_SQL = `
INSERT INTO provider_attempts (
  call_id, parent_call_id, session_id, task_id, run_id, entry_point, purpose,
  provider_configured, provider_actual, model_configured, model_actual,
  api_mode, transport, attempt_index, fallback_index,
  credential_label_redacted, status, error_class, started_at, completed_at,
  estimated_input_tokens, estimated_output_tokens, estimated_schema_tokens,
  estimated_image_tokens, provider_input_tokens, provider_output_tokens,
  provider_cache_read_tokens, provider_cache_write_tokens,
  provider_reasoning_tokens, request_bytes, response_bytes, usage_source,
  cost_amount, cost_currency, cost_status, cost_source,
  context_snapshot_id, tool_schema_snapshot_id, core_schema_count,
  mcp_schema_count, plugin_schema_count, deferred_schema_count,
  serialized_schema_bytes, selected_profile, selected_mode,
  raw_tool_result_bytes, transmitted_tool_result_bytes,
  memory_tokens, user_profile_tokens, project_memory_tokens,
  skill_index_tokens, loaded_skill_tokens
) VALUES (
  @call_id, @parent_call_id, @session_id, @task_id, @run_id, @entry_point, @purpose,
  @provider_configured, @provider_actual, @model_configured, @model_actual,
  @api_mode, @transport, @attempt_index, @fallback_index,
  @credential_label_redacted, @status, @error_class, @started_at, @completed_at,
  @estimated_input_tokens, @estimated_output_tokens, @estimated_schema_tokens,
  @estimated_image_tokens, @provider_input_tokens, @provider_output_tokens,
  @provider_cache_read_tokens, @provider_cache_write_tokens,
  @provider_reasoning_tokens, @request_bytes, @response_bytes, @usage_source,
  @cost_amount, @cost_currency, @cost_status, @cost_source,
  @context_snapshot_id, @tool_schema_snapshot_id, @core_schema_count,
  @mcp_schema_count, @plugin_schema_count, @deferred_schema_count,
  @serialized_schema_bytes, @selected_profile, @selected_mode,
  @raw_tool_result_bytes, @transmitted_tool_result_bytes,
  @memory_tokens, @user_profile_tokens, @project_memory_tokens,
  @skill_index_tokens, @loaded_skill_tokens
)
`;

/**
 * Keeps only a low-information credential source label. Values that resemble
 * credentials are replaced instead of being persisted.
 */
export function redactCredentialLabel(label: string | null | undefined): string | null {
  if (!label) return null;
  const compact = label.replace(/\s+/g, ' ').trim();
  if (!compact) return null;
  if (
    compact.length > 80
    || /(?:bearer\s+|api[_-]?key\s*[:=]|token\s*[:=]|gsk_|sk-)/i.test(compact)
  ) {
    return 'redacted';
  }
  return compact;
}

export class ProviderAttemptLedger {
  private readonly db: DatabaseType;
  private readonly insertStatement: Statement;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(LEDGER_SCHEMA_SQL);
    ensureLedgerColumns(this.db);
    this.db.prepare(`
      INSERT INTO provider_attempt_ledger_meta (singleton, schema_version)
      VALUES (1, ?)
      ON CONFLICT(singleton) DO UPDATE SET schema_version =
        MAX(schema_version, excluded.schema_version)
    `).run(LEDGER_SCHEMA_VERSION);
    this.insertStatement = this.db.prepare(INSERT_SQL);
  }

  /** Atomically append one terminal physical-attempt record. */
  append(record: ProviderAttemptRecord): void {
    const normalized = normalizeRecord(record);
    this.db.transaction(() => {
      this.insertStatement.run(recordToRow(normalized));
    })();
  }

  query(query: ProviderAttemptQuery = {}): readonly ProviderAttemptRecord[] {
    const { sql, params } = buildQuery(query);
    const rows = this.db.prepare(sql).all(...params) as ProviderAttemptRow[];
    return Object.freeze(rows.map(rowToRecord));
  }

  project(query: UsageProjectionQuery = {}): ProviderUsageProjection {
    const records = this.query(query).filter((record) => (
      query.includeSetup
      || (record.purpose !== 'setup' && record.purpose !== 'readiness')
    ));

    const projection: ProviderUsageProjection = {
      physicalAttempts: records.length,
      successfulAttempts: 0,
      failedAttempts: 0,
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
      estimatedSchemaTokens: 0,
      estimatedImageTokens: 0,
      providerInputTokens: 0,
      providerOutputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      requestBytes: 0,
      responseBytes: 0,
      rawToolResultBytes: 0,
      transmittedToolResultBytes: 0,
      memoryTokens: 0,
      userProfileTokens: 0,
      projectMemoryTokens: 0,
      skillIndexTokens: 0,
      loadedSkillTokens: 0,
      coreSchemaCount: 0,
      mcpSchemaCount: 0,
      pluginSchemaCount: 0,
      deferredSchemaCount: 0,
      knownCostAmount: 0,
      costCurrency: null,
      unknownCostAttempts: 0,
      providerReportedAttempts: 0,
      estimatedAttempts: 0,
    };

    for (const record of records) {
      if (record.status === 'success') projection.successfulAttempts += 1;
      else projection.failedAttempts += 1;
      projection.estimatedInputTokens += record.estimatedInputTokens ?? 0;
      projection.estimatedOutputTokens += record.estimatedOutputTokens ?? 0;
      projection.estimatedSchemaTokens += record.estimatedSchemaTokens ?? 0;
      projection.estimatedImageTokens += record.estimatedImageTokens ?? 0;
      projection.providerInputTokens += record.providerInputTokens ?? 0;
      projection.providerOutputTokens += record.providerOutputTokens ?? 0;
      projection.cacheReadTokens += record.providerCacheReadTokens ?? 0;
      projection.cacheWriteTokens += record.providerCacheWriteTokens ?? 0;
      projection.reasoningTokens += record.providerReasoningTokens ?? 0;
      projection.requestBytes += record.requestBytes ?? 0;
      projection.responseBytes += record.responseBytes ?? 0;
      projection.rawToolResultBytes += record.rawToolResultBytes ?? 0;
      projection.transmittedToolResultBytes += record.transmittedToolResultBytes ?? 0;
      projection.memoryTokens += record.memoryTokens ?? 0;
      projection.userProfileTokens += record.userProfileTokens ?? 0;
      projection.projectMemoryTokens += record.projectMemoryTokens ?? 0;
      projection.skillIndexTokens += record.skillIndexTokens ?? 0;
      projection.loadedSkillTokens += record.loadedSkillTokens ?? 0;
      projection.coreSchemaCount += record.coreSchemaCount ?? 0;
      projection.mcpSchemaCount += record.mcpSchemaCount ?? 0;
      projection.pluginSchemaCount += record.pluginSchemaCount ?? 0;
      projection.deferredSchemaCount += record.deferredSchemaCount ?? 0;
      if (record.costAmount === null || record.costStatus === 'unknown') {
        projection.unknownCostAttempts += 1;
      } else {
        projection.knownCostAmount += record.costAmount;
        projection.costCurrency ??= record.costCurrency;
        if (projection.costCurrency !== record.costCurrency) {
          projection.costCurrency = null;
        }
      }
      if (record.usageSource === 'provider_reported') {
        projection.providerReportedAttempts += 1;
      } else if (
        record.usageSource === 'locally_estimated'
        || record.usageSource === 'partially_estimated'
      ) {
        projection.estimatedAttempts += 1;
      }
    }

    return projection;
  }

  close(): void {
    try {
      this.db.pragma('wal_checkpoint(PASSIVE)');
    } catch {
      // A checkpoint is unnecessary for in-memory databases and best-effort on shutdown.
    }
    this.db.close();
  }
}

function ensureLedgerColumns(db: DatabaseType): void {
  const existing = new Set(
    (db.prepare('PRAGMA table_info(provider_attempts)').all() as Array<{ name: string }>)
      .map((column) => column.name),
  );
  const additions: ReadonlyArray<readonly [string, string]> = [
    ['memory_tokens', 'INTEGER'],
    ['user_profile_tokens', 'INTEGER'],
    ['project_memory_tokens', 'INTEGER'],
    ['skill_index_tokens', 'INTEGER'],
    ['loaded_skill_tokens', 'INTEGER'],
  ];
  for (const [name, sqlType] of additions) {
    if (!existing.has(name)) db.exec(`ALTER TABLE provider_attempts ADD COLUMN ${name} ${sqlType}`);
  }
}

function normalizeRecord(record: ProviderAttemptRecord): ProviderAttemptRecord {
  if (!record.callId.trim()) throw new Error('Provider attempt callId is required.');
  if (record.completedAt < record.startedAt) {
    throw new Error('Provider attempt completion cannot precede its start.');
  }
  return Object.freeze({
    ...record,
    credentialLabelRedacted: redactCredentialLabel(record.credentialLabelRedacted),
  });
}

function buildQuery(query: ProviderAttemptQuery): { sql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const equal = (column: string, value: unknown): void => {
    if (value === undefined) return;
    clauses.push(`${column} = ?`);
    params.push(value);
  };
  equal('call_id', query.callId);
  equal('parent_call_id', query.parentCallId);
  equal('session_id', query.sessionId);
  equal('task_id', query.taskId);
  equal('run_id', query.runId);
  equal('purpose', query.purpose);
  equal('status', query.status);
  if (query.provider !== undefined) {
    clauses.push('(provider_actual = ? OR provider_configured = ?)');
    params.push(query.provider, query.provider);
  }
  if (query.model !== undefined) {
    clauses.push('(model_actual = ? OR model_configured = ?)');
    params.push(query.model, query.model);
  }
  if (query.since !== undefined) {
    clauses.push('started_at >= ?');
    params.push(query.since);
  }
  if (query.until !== undefined) {
    clauses.push('started_at <= ?');
    params.push(query.until);
  }
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.max(1, Math.min(query.limit ?? 10_000, 100_000));
  params.push(limit);
  return {
    sql: `SELECT * FROM provider_attempts${where} ORDER BY started_at, call_id LIMIT ?`,
    params,
  };
}

function recordToRow(record: ProviderAttemptRecord): ProviderAttemptRow {
  return {
    call_id: record.callId,
    parent_call_id: record.parentCallId,
    session_id: record.sessionId,
    task_id: record.taskId,
    run_id: record.runId,
    entry_point: record.entryPoint,
    purpose: record.purpose,
    provider_configured: record.providerConfigured,
    provider_actual: record.providerActual,
    model_configured: record.modelConfigured,
    model_actual: record.modelActual,
    api_mode: record.apiMode,
    transport: record.transport,
    attempt_index: record.attemptIndex,
    fallback_index: record.fallbackIndex,
    credential_label_redacted: record.credentialLabelRedacted,
    status: record.status,
    error_class: record.errorClass,
    started_at: record.startedAt,
    completed_at: record.completedAt,
    estimated_input_tokens: record.estimatedInputTokens,
    estimated_output_tokens: record.estimatedOutputTokens,
    estimated_schema_tokens: record.estimatedSchemaTokens,
    estimated_image_tokens: record.estimatedImageTokens,
    provider_input_tokens: record.providerInputTokens,
    provider_output_tokens: record.providerOutputTokens,
    provider_cache_read_tokens: record.providerCacheReadTokens,
    provider_cache_write_tokens: record.providerCacheWriteTokens,
    provider_reasoning_tokens: record.providerReasoningTokens,
    request_bytes: record.requestBytes,
    response_bytes: record.responseBytes,
    usage_source: record.usageSource,
    cost_amount: record.costAmount,
    cost_currency: record.costCurrency,
    cost_status: record.costStatus,
    cost_source: record.costSource,
    context_snapshot_id: record.contextSnapshotId,
    tool_schema_snapshot_id: record.toolSchemaSnapshotId,
    core_schema_count: record.coreSchemaCount,
    mcp_schema_count: record.mcpSchemaCount,
    plugin_schema_count: record.pluginSchemaCount,
    deferred_schema_count: record.deferredSchemaCount,
    serialized_schema_bytes: record.serializedSchemaBytes,
    selected_profile: record.selectedProfile,
    selected_mode: record.selectedMode,
    raw_tool_result_bytes: record.rawToolResultBytes,
    transmitted_tool_result_bytes: record.transmittedToolResultBytes,
    memory_tokens: record.memoryTokens,
    user_profile_tokens: record.userProfileTokens,
    project_memory_tokens: record.projectMemoryTokens,
    skill_index_tokens: record.skillIndexTokens,
    loaded_skill_tokens: record.loadedSkillTokens,
  };
}

function rowToRecord(row: ProviderAttemptRow): ProviderAttemptRecord {
  return Object.freeze({
    callId: row.call_id,
    parentCallId: row.parent_call_id,
    sessionId: row.session_id,
    taskId: row.task_id,
    runId: row.run_id,
    entryPoint: row.entry_point,
    purpose: row.purpose,
    providerConfigured: row.provider_configured,
    providerActual: row.provider_actual,
    modelConfigured: row.model_configured,
    modelActual: row.model_actual,
    apiMode: row.api_mode,
    transport: row.transport,
    attemptIndex: row.attempt_index,
    fallbackIndex: row.fallback_index,
    credentialLabelRedacted: row.credential_label_redacted,
    status: row.status,
    errorClass: row.error_class,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    estimatedInputTokens: row.estimated_input_tokens,
    estimatedOutputTokens: row.estimated_output_tokens,
    estimatedSchemaTokens: row.estimated_schema_tokens,
    estimatedImageTokens: row.estimated_image_tokens,
    providerInputTokens: row.provider_input_tokens,
    providerOutputTokens: row.provider_output_tokens,
    providerCacheReadTokens: row.provider_cache_read_tokens,
    providerCacheWriteTokens: row.provider_cache_write_tokens,
    providerReasoningTokens: row.provider_reasoning_tokens,
    requestBytes: row.request_bytes,
    responseBytes: row.response_bytes,
    usageSource: row.usage_source,
    costAmount: row.cost_amount,
    costCurrency: row.cost_currency,
    costStatus: row.cost_status,
    costSource: row.cost_source,
    contextSnapshotId: row.context_snapshot_id,
    toolSchemaSnapshotId: row.tool_schema_snapshot_id,
    coreSchemaCount: row.core_schema_count,
    mcpSchemaCount: row.mcp_schema_count,
    pluginSchemaCount: row.plugin_schema_count,
    deferredSchemaCount: row.deferred_schema_count,
    serializedSchemaBytes: row.serialized_schema_bytes,
    selectedProfile: row.selected_profile,
    selectedMode: row.selected_mode,
    rawToolResultBytes: row.raw_tool_result_bytes,
    transmittedToolResultBytes: row.transmitted_tool_result_bytes,
    memoryTokens: row.memory_tokens,
    userProfileTokens: row.user_profile_tokens,
    projectMemoryTokens: row.project_memory_tokens,
    skillIndexTokens: row.skill_index_tokens,
    loadedSkillTokens: row.loaded_skill_tokens,
  });
}
