/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

import type { ToolEffectContract } from '../../core/v4/effectContract';
import type { ToolHandler } from '../../core/v4/toolRegistry';

type ContractOptions = Omit<ToolEffectContract, 'target'> & {
  targetFields?: readonly string[];
  targetLabel?: string;
};

function contract(options: ContractOptions): ToolEffectContract {
  const { targetFields = [], targetLabel, ...metadata } = options;
  return Object.freeze({
    ...metadata,
    target(args) {
      const values = targetFields
        .map((field) => args[field])
        .filter((value): value is string | number => typeof value === 'string' || typeof value === 'number')
        .map(String);
      if (values.length === 0) return targetLabel ?? null;
      return targetLabel ? `${targetLabel}:${values.join(' -> ')}` : values.join(' -> ');
    },
  });
}

const FILE_WRITE = contract({
  classification: 'reconcilable_mutation', kind: 'filesystem.write',
  retrySafety: 'reconcile_before_retry', idempotencySupported: true,
  reconciliationSupported: true, verificationSupported: true,
  approvalRequirement: 'policy', sensitiveFields: ['content', 'patch'],
  redactionRules: ['digest_arguments', 'omit_sensitive_values'], targetFields: ['path'],
  reconciliationData(args, cwd) {
    const path = typeof args.path === 'string' ? resolve(cwd, args.path) : null;
    const content = typeof args.content === 'string' ? args.content : null;
    if (!path || content === null) return null;
    return {
      path,
      expectedContentSha256: createHash('sha256').update(content).digest('hex'),
      expectedSize: Buffer.byteLength(content),
    };
  },
});
const FILE_MOVE = contract({
  classification: 'reconcilable_mutation', kind: 'filesystem.move',
  retrySafety: 'reconcile_before_retry', idempotencySupported: true,
  reconciliationSupported: true, verificationSupported: true,
  approvalRequirement: 'policy', sensitiveFields: [], redactionRules: ['digest_arguments'],
  targetFields: ['source', 'destination'],
});
const FILE_DELETE = contract({
  classification: 'reconcilable_mutation', kind: 'filesystem.delete',
  retrySafety: 'reconcile_before_retry', idempotencySupported: true,
  reconciliationSupported: true, verificationSupported: true,
  approvalRequirement: 'policy', sensitiveFields: [], redactionRules: ['digest_arguments'],
  targetFields: ['path'],
});
const ARTIFACT_WRITE = contract({
  classification: 'idempotent_mutation', kind: 'artifact.capture',
  retrySafety: 'same_idempotency_key', idempotencySupported: true,
  reconciliationSupported: true, verificationSupported: true,
  approvalRequirement: 'none', sensitiveFields: [], redactionRules: ['digest_arguments'],
  targetLabel: 'runtime-artifact',
});
const LOCAL_PROCESS = contract({
  classification: 'unsafe_mutation', kind: 'process.command',
  retrySafety: 'never_automatic', idempotencySupported: false,
  reconciliationSupported: false, verificationSupported: false,
  approvalRequirement: 'policy', sensitiveFields: ['command', 'code', 'args', 'env'],
  redactionRules: ['digest_arguments', 'omit_sensitive_values'], targetLabel: 'local-runtime',
});
const PROCESS_CONTROL = contract({
  classification: 'reconcilable_mutation', kind: 'process.control',
  retrySafety: 'reconcile_before_retry', idempotencySupported: false,
  reconciliationSupported: true, verificationSupported: true,
  approvalRequirement: 'policy', sensitiveFields: ['args', 'env'],
  redactionRules: ['digest_arguments', 'omit_sensitive_values'], targetFields: ['pid'],
});
const BROWSER_ACTION = contract({
  classification: 'unsafe_mutation', kind: 'browser.action',
  retrySafety: 'never_automatic', idempotencySupported: false,
  reconciliationSupported: false, verificationSupported: true,
  approvalRequirement: 'policy', sensitiveFields: ['text', 'value', 'values', 'files'],
  redactionRules: ['digest_arguments', 'omit_sensitive_values'], targetFields: ['selector', 'ref', 'url'],
});
const INTERNAL_STATE = contract({
  classification: 'idempotent_mutation', kind: 'aiden.state',
  retrySafety: 'same_idempotency_key', idempotencySupported: true,
  reconciliationSupported: true, verificationSupported: true,
  approvalRequirement: 'policy', sensitiveFields: ['content', 'value'],
  redactionRules: ['digest_arguments', 'omit_sensitive_values'], targetFields: ['name', 'id'],
});
const SYSTEM_CONTROL = contract({
  classification: 'unsafe_mutation', kind: 'system.control',
  retrySafety: 'never_automatic', idempotencySupported: false,
  reconciliationSupported: false, verificationSupported: false,
  approvalRequirement: 'policy', sensitiveFields: ['text', 'keys'],
  redactionRules: ['digest_arguments', 'omit_sensitive_values'], targetFields: ['app', 'name'],
});
const PACKAGE_INSTALL = contract({
  classification: 'unsafe_mutation', kind: 'package.install',
  retrySafety: 'never_automatic', idempotencySupported: false,
  reconciliationSupported: true, verificationSupported: true,
  approvalRequirement: 'always', sensitiveFields: [], redactionRules: ['digest_arguments'],
  targetLabel: 'runtime-package',
});

const CONTRACTS: Readonly<Record<string, ToolEffectContract>> = Object.freeze({
  file_write: FILE_WRITE,
  file_patch: FILE_WRITE,
  file_delete: FILE_DELETE,
  file_move: FILE_MOVE,
  file_copy: { ...FILE_MOVE, kind: 'filesystem.copy' },
  browser_screenshot: ARTIFACT_WRITE,
  screenshot: ARTIFACT_WRITE,
  open_url: { ...SYSTEM_CONTROL, kind: 'system.external_launch', target: (args) => typeof args.url === 'string' ? args.url : null },
  shell_exec: LOCAL_PROCESS,
  execute_code: LOCAL_PROCESS,
  process_spawn: PROCESS_CONTROL,
  process_kill: PROCESS_CONTROL,
  browser_navigate: BROWSER_ACTION,
  browser_click: BROWSER_ACTION,
  browser_type: BROWSER_ACTION,
  browser_fill: BROWSER_ACTION,
  browser_scroll: BROWSER_ACTION,
  browser_close: BROWSER_ACTION,
  browser_dialog: BROWSER_ACTION,
  browser_upload: BROWSER_ACTION,
  memory_add: INTERNAL_STATE,
  memory_replace: INTERNAL_STATE,
  memory_remove: INTERNAL_STATE,
  session_summary: INTERNAL_STATE,
  skill_manage: INTERNAL_STATE,
  aiden_self_update: PACKAGE_INSTALL,
  media_key: SYSTEM_CONTROL,
  volume_set: SYSTEM_CONTROL,
  app_launch: SYSTEM_CONTROL,
  app_close: SYSTEM_CONTROL,
  clipboard_write: SYSTEM_CONTROL,
  media_transport: SYSTEM_CONTROL,
  app_input: SYSTEM_CONTROL,
});

export function withBuiltInEffectContract(handler: ToolHandler): ToolHandler {
  if (handler.mutates === false) return handler;
  const effectContract = CONTRACTS[handler.schema.name];
  if (!effectContract) {
    throw new Error(`Built-in mutating tool ${handler.schema.name} has no durable effect contract`);
  }
  return { ...handler, effectContract };
}
