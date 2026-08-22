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

export type ProductDoctorGroup = 'System' | 'Runtime' | 'AI' | 'Coding' | 'Browser' | 'Apps' | 'Automations' | 'Workbench' | 'Commercial';
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

  if (input.readiness) {
    const groupByCategory: Record<string, ProductDoctorGroup> = {
      chat: 'AI', coding: 'Coding', validation: 'Coding', browser: 'Browser',
      apps: 'Apps', automations: 'Automations', workspace: 'Workbench', approvals: 'Workbench', evidence: 'Workbench',
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
