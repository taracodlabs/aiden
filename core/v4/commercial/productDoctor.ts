/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import type { AidenPaths } from '../paths';
import { daemonDbPath } from '../daemon/daemonConfig';
import type { SystemReadinessProjection } from '../workbench/systemReadiness';
import { classifyPlatform } from './platformSupport';
import { snapshotAutomationReadiness } from '../automation/readiness';
import { snapshotPresenceReadiness } from '../presence/readiness';
import { snapshotLearningReadiness } from '../learning/readiness';
import { MCP_COMPATIBLE_PROTOCOL_VERSIONS, MCP_PROTOCOL_VERSION } from '../mcp/protocol';
import { A2A_JSONRPC_BINDING, A2A_PROTOCOL_VERSION } from '../a2a/protocol';

export type ProductDoctorGroup = 'System' | 'Runtime' | 'AI' | 'Coding' | 'Browser' | 'Apps' | 'Automations' | 'Presence' | 'Learning' | 'MCP' | 'A2A' | 'Workbench' | 'Commercial';
export interface ProductDoctorResult {
  name: string;
  group: ProductDoctorGroup;
  passed: boolean;
  message: string;
  suggestion?: string;
  durationMs?: number;
}

interface DoctorLikeReport {
  results: Array<{ name: string; group: string; passed: boolean; message: string; suggestion?: string; durationMs?: number }>;
  passed: boolean;
  totalMs: number;
}

export interface CommercialDoctorContext {
  edition: string;
  entitlementState: string;
  updateChannel: string;
  serviceConnectivity?: 'ready' | 'unavailable' | 'not_configured';
}

export interface ExternalProtocolDoctorContext {
  mcpServers?: Array<{
    name: string;
    endpoint: string;
    transport: string;
    protocolVersion?: string;
    status: string;
    trustState?: string;
    capabilityChangeClass?: string;
    reviewRequired?: boolean;
    toolCount: number;
    resourcesAvailable: boolean;
  }>;
  a2aIdentities?: Array<{ displayName: string; trustState: string }>;
  a2aRecoverableTasks?: Array<{ state: string; locallyVerified: boolean }>;
  quarantinedArtifacts?: number;
}

export interface DoctorJsonReport {
  schemaVersion: 1;
  generatedAt: string;
  passed: boolean;
  totalMs: number;
  summary: { passing: number; warning: number; failing: number };
  checks: Array<{
    id: string;
    group: string;
    passed: boolean;
    status: 'passing' | 'warning' | 'failing';
    message: string;
    suggestion?: string;
    durationMs?: number;
  }>;
}

function result(name: string, group: ProductDoctorGroup, passed: boolean, message: string, suggestion?: string): ProductDoctorResult {
  return { name, group, passed, message, ...(suggestion ? { suggestion } : {}) };
}

export async function productDoctorResults(input: {
  paths: AidenPaths;
  installedVersion: string;
  readiness?: SystemReadinessProjection;
  commercial?: CommercialDoctorContext;
  externalProtocols?: ExternalProtocolDoctorContext;
}): Promise<ProductDoctorResult[]> {
  const support = classifyPlatform();
  const results: ProductDoctorResult[] = [
    result('platform support', 'System', support.level !== 'unsupported', `${support.level.replace(/_/g, ' ')} · ${support.detail}`,
      support.level === 'unsupported' ? 'Use Windows 11 with Node 20 or Node 22.' : undefined),
    result('operating system', 'System', true, `${process.platform} ${support.release} · ${process.arch}`),
    result('Node runtime', 'System', [20, 22].includes(support.nodeMajor), `${process.versions.node} · ABI ${process.versions.modules ?? 'unknown'}`,
      [20, 22].includes(support.nodeMajor) ? undefined : 'Install Node 20 or Node 22.'),
    result('Aiden version', 'System', input.installedVersion !== '0.0.0', input.installedVersion),
  ];

  try {
    await fs.access(input.paths.root, constants.W_OK);
    results.push(result('Aiden home', 'Runtime', true, `writable · ${input.paths.root}`));
  } catch {
    results.push(result('Aiden home', 'Runtime', false, `not writable · ${input.paths.root}`, 'Check the directory permissions or choose a writable AIDEN_HOME.'));
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = require('better-sqlite3') as new (name: string) => { prepare(sql: string): { get(): unknown }; close(): void };
    const db = new Database(':memory:');
    db.prepare('SELECT 1').get();
    db.close();
    results.push(result('SQLite', 'Runtime', true, 'native module and query ready'));
  } catch (error) {
    results.push(result('SQLite', 'Runtime', false, error instanceof Error ? error.message : 'unavailable', 'Reinstall Aiden under a supported Node runtime.'));
  }

  results.push(...externalProtocolDoctorResults(input.externalProtocols));

  if (input.readiness) {
    const groupByCategory: Record<string, ProductDoctorGroup> = {
      chat: 'AI', coding: 'Coding', validation: 'Coding', browser: 'Browser',
      apps: 'Apps', automations: 'Automations', presence: 'Presence', learning: 'Learning', workspace: 'Workbench', approvals: 'Workbench', evidence: 'Workbench',
    };
    for (const item of input.readiness.items) {
      results.push(result(
        item.title,
        groupByCategory[item.category] ?? 'Workbench',
        item.healthy || (!item.blocking && item.state === 'setup_available'),
        item.detail,
        item.healthy ? undefined : nextAction(item.availableActions),
      ));
    }
  }

  if (input.commercial && !input.readiness) {
    results.push(automationReadinessFromDisk(input.paths));
    results.push(presenceReadinessFromDisk(input.paths));
    results.push(learningReadinessFromDisk(
      input.paths,
      input.commercial.edition.toLowerCase() === 'pro'
        && !['revoked', 'expired'].includes(input.commercial.entitlementState),
    ));
  }

  if (input.commercial) {
    results.push(result('product edition', 'Commercial', true, input.commercial.edition));
    const entitlementHealthy = !['revoked', 'expired'].includes(input.commercial.entitlementState);
    results.push(result(
      'entitlement', 'Commercial', entitlementHealthy, input.commercial.entitlementState,
      input.commercial.entitlementState === 'unavailable' ? 'Connect the approved entitlement service when commercial distribution is configured.' : undefined,
    ));
    results.push(result('update channel', 'Commercial', true, input.commercial.updateChannel));
    if (input.commercial.serviceConnectivity) {
      results.push(result('commercial services', 'Commercial', input.commercial.serviceConnectivity === 'ready', input.commercial.serviceConnectivity));
    }
  }
  return results;
}

export function externalProtocolDoctorResults(
  context: ExternalProtocolDoctorContext | undefined,
): ProductDoctorResult[] {
  const mcpServers = context?.mcpServers ?? [];
  const a2aIdentities = context?.a2aIdentities ?? [];
  const recoverableTasks = context?.a2aRecoverableTasks ?? [];
  const quarantinedArtifacts = context?.quarantinedArtifacts ?? 0;
  const results: ProductDoctorResult[] = [
    result(
      'MCP protocol', 'MCP', true,
      `canonical ${MCP_PROTOCOL_VERSION} · compatible ${MCP_COMPATIBLE_PROTOCOL_VERSIONS.join(', ')}`,
    ),
  ];

  if (mcpServers.length === 0) {
    results.push(result('MCP servers', 'MCP', true, 'no servers configured · canonical client ready'));
    results.push(result('MCP OAuth and capability review', 'MCP', true, 'inactive until a server is configured'));
  } else {
    for (const server of mcpServers) {
      const drift = server.capabilityChangeClass && server.capabilityChangeClass !== 'same'
        ? `${server.capabilityChangeClass} drift`
        : 'capabilities stable';
      const trust = server.trustState ?? 'unverified';
      const healthyStatus = ['ready', 'needs-auth'].includes(server.status);
      const safeTrust = !['changed', 'revoked'].includes(trust);
      const passed = healthyStatus && safeTrust && server.reviewRequired !== true;
      const message = [
        server.endpoint,
        server.transport,
        server.protocolVersion ?? 'protocol unknown',
        server.status,
        `trust ${trust}`,
        drift,
        `${server.toolCount} tools`,
        server.resourcesAvailable ? 'resources advertised' : 'no resources advertised',
      ].join(' · ');
      results.push(result(
        `MCP ${server.name}`, 'MCP', passed, message,
        server.reviewRequired
          ? 'Review the exact capability change before enabling mutating tools.'
          : server.status === 'needs-auth'
            ? `Authorize ${server.name} with the exact OAuth resource and scopes.`
            : passed ? undefined : 'Inspect identity, transport, and capability state before reconnecting.',
      ));
    }
    const legacy = mcpServers.filter((server) => server.protocolVersion && server.protocolVersion !== MCP_PROTOCOL_VERSION).length;
    const needsAuth = mcpServers.filter((server) => server.status === 'needs-auth').length;
    results.push(result(
      'MCP OAuth and compatibility', 'MCP', true,
      `${needsAuth} awaiting OAuth · ${legacy} deliberate compatible-revision connection${legacy === 1 ? '' : 's'}`,
    ));
  }

  results.push(result(
    'A2A preview', 'A2A', true,
    `${A2A_PROTOCOL_VERSION} ${A2A_JSONRPC_BINDING} · read-only delegation · mutation disabled`,
  ));
  if (a2aIdentities.length === 0) {
    results.push(result('A2A agents', 'A2A', true, 'no agents configured · identity store ready'));
  } else {
    const unsafe = a2aIdentities.filter((identity) => ['changed', 'revoked'].includes(identity.trustState));
    results.push(result(
      'A2A agents', 'A2A', unsafe.length === 0,
      `${a2aIdentities.length} configured · ${unsafe.length} changed or revoked`,
      unsafe.length > 0 ? 'Review the exact Agent Card identity before any further contact.' : undefined,
    ));
  }
  const unresolvedTasks = recoverableTasks.filter((task) => task.state === 'unknown' || !task.locallyVerified).length;
  results.push(result(
    'A2A RemoteTasks', 'A2A', recoverableTasks.length === 0,
    recoverableTasks.length === 0
      ? 'no recoverable tasks · durable task store ready'
      : `${recoverableTasks.length} recoverable · ${unresolvedTasks} awaiting local reconciliation`,
    recoverableTasks.length > 0 ? 'Reconcile exact RemoteTask identity and local Proof before declaring completion.' : undefined,
  ));
  results.push(result(
    'A2A quarantine', 'A2A', true,
    `${quarantinedArtifacts} quarantined artifact${quarantinedArtifacts === 1 ? '' : 's'}`,
  ));
  results.push(result('A2A transport', 'A2A', true, 'bounded JSON-RPC streaming · local budgets and cancellation authority'));
  return results;
}

function learningReadinessFromDisk(paths: AidenPaths, entitled: boolean): ProductDoctorResult {
  let db: { prepare(sql: string): { get(...args: unknown[]): unknown; all(...args: unknown[]): unknown[] }; close(): void } | null = null;
  try {
    // Read-only by construction: Doctor observes and never migrates, imports,
    // rebuilds, edits, or deletes learned content.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = require('better-sqlite3') as new (
      name: string, options: { readonly: boolean; fileMustExist: boolean },
    ) => { prepare(sql: string): { get(...args: unknown[]): unknown; all(...args: unknown[]): unknown[] }; close(): void };
    db = new Database(daemonDbPath(paths.root), { readonly: true, fileMustExist: true });
    const readiness = snapshotLearningReadiness({
      db: db as unknown as import('better-sqlite3').Database,
      entitled,
    });
    return result(
      'Evidence-linked Learning', 'Learning', readiness.ready, readiness.detail,
      readiness.repairable ? 'Run `aiden learning rebuild` after reviewing the diagnostic.' : undefined,
    );
  } catch {
    return result(
      'Evidence-linked Learning', 'Learning', true, 'not initialized yet',
      'Start Aiden or open Workbench to initialize the local Learning database.',
    );
  } finally { db?.close(); }
}

function presenceReadinessFromDisk(paths: AidenPaths): ProductDoctorResult {
  let db: { prepare(sql: string): { get(...args: unknown[]): unknown; all(...args: unknown[]): unknown[] }; close(): void } | null = null;
  try {
    // Read-only: Doctor observes the canonical local projection and never runs migrations.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = require('better-sqlite3') as new (
      name: string, options: { readonly: boolean; fileMustExist: boolean },
    ) => { prepare(sql: string): { get(...args: unknown[]): unknown; all(...args: unknown[]): unknown[] }; close(): void };
    db = new Database(daemonDbPath(paths.root), { readonly: true, fileMustExist: true });
    const readiness = snapshotPresenceReadiness({
      db: db as unknown as import('better-sqlite3').Database,
      entitled: true,
    });
    return result(
      'Agentic Presence', 'Presence', readiness.ready, readiness.detail,
      readiness.ready ? undefined : 'Open Workbench and review Agentic Presence readiness.',
    );
  } catch {
    return result(
      'Agentic Presence', 'Presence', true, 'not initialized yet',
      'Start Aiden or open Workbench to initialize the local Presence database.',
    );
  } finally { db?.close(); }
}

function automationReadinessFromDisk(paths: AidenPaths): ProductDoctorResult {
  let db: { prepare(sql: string): { get(...args: unknown[]): unknown }; close(): void } | null = null;
  try {
    // Read-only by construction: doctor observes the canonical daemon database
    // and never runs migrations or creates a parallel scheduler authority.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = require('better-sqlite3') as new (
      name: string, options: { readonly: boolean; fileMustExist: boolean },
    ) => { prepare(sql: string): { get(...args: unknown[]): unknown }; close(): void };
    db = new Database(daemonDbPath(paths.root), { readonly: true, fileMustExist: true });
    const readiness = snapshotAutomationReadiness({
      db: db as unknown as import('better-sqlite3').Database,
      entitled: true,
    });
    return result(
      'Reliable Automations', 'Automations', readiness.ready,
      readiness.detail,
      readiness.ready ? undefined : 'Open Workbench Automations and review durable readiness.',
    );
  } catch {
    return result(
      'Reliable Automations', 'Automations', true,
      'not initialized yet',
      'Start Aiden or open Workbench to initialize the local automation database.',
    );
  } finally {
    db?.close();
  }
}

function nextAction(actions: string[]): string | undefined {
  if (actions.length === 0) return undefined;
  return `Next action: ${actions[0].replace(/_/g, ' ')}.`;
}

export async function applySafeDoctorFixes(paths: AidenPaths): Promise<Array<{ id: string; applied: boolean; detail: string }>> {
  const safeDirectories = [paths.root, paths.logsDir, paths.sessionsDir, paths.pluginsDir];
  const fixes: Array<{ id: string; applied: boolean; detail: string }> = [];
  for (const directory of safeDirectories) {
    try {
      await fs.mkdir(directory, { recursive: true });
      fixes.push({ id: `create:${path.basename(directory) || 'aiden-home'}`, applied: true, detail: directory });
    } catch (error) {
      fixes.push({ id: `create:${path.basename(directory) || 'aiden-home'}`, applied: false, detail: error instanceof Error ? error.message : 'failed' });
    }
  }
  return fixes;
}

const SECRET_PATTERN = /((?:api[_-]?key|token|secret|password|authorization|bearer)\s*[:=]\s*)\S+/gi;

export function toDoctorJson(report: DoctorLikeReport, now: () => Date = () => new Date()): DoctorJsonReport {
  let passing = 0;
  let warning = 0;
  let failing = 0;
  const checks = report.results.map((entry, index) => {
    const status = !entry.passed ? 'failing' : entry.suggestion ? 'warning' : 'passing';
    if (status === 'passing') passing += 1;
    else if (status === 'warning') warning += 1;
    else failing += 1;
    const clean = (value: string) => value.replace(SECRET_PATTERN, '$1<redacted>');
    return {
      id: `${entry.group.toLowerCase().replace(/[^a-z0-9]+/g, '-')}:${entry.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}:${index}`,
      group: entry.group,
      passed: entry.passed,
      status,
      message: clean(entry.message),
      ...(entry.suggestion ? { suggestion: clean(entry.suggestion) } : {}),
      ...(entry.durationMs === undefined ? {} : { durationMs: entry.durationMs }),
    } as DoctorJsonReport['checks'][number];
  });
  return { schemaVersion: 1, generatedAt: now().toISOString(), passed: report.passed && failing === 0, totalMs: report.totalMs, summary: { passing, warning, failing }, checks };
}
