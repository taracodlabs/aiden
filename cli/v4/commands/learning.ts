/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { buildEditionAuthority, detectProductEdition } from '../../../core/v4/commercial/edition';
import { daemonDbPath } from '../../../core/v4/daemon/daemonConfig';
import { closeDaemonDb, openDaemonDb } from '../../../core/v4/daemon/db/connection';
import { integrationLocalScope } from '../../../core/v4/integrations/runtime';
import { createLearningAuthority } from '../../../core/v4/learning/learningAuthority';
import { localLearningScopes } from '../../../core/v4/learning/scopes';
import type { LearningScope } from '../../../core/v4/learning/types';
import { resolveAidenPaths } from '../../../core/v4/paths';
import { createWorkbenchLearningPort } from '../../../core/v4/workbench/learningPort';

export interface LearningCliOptions {
  writeOut?: (value: string) => void;
  writeErr?: (value: string) => void;
  rootDir?: string;
  dbPath?: string;
  scopes?: LearningScope[];
  defaultScope?: LearningScope;
  enabled?: boolean;
  cwd?: string;
}

const stdout = (value: string): void => { process.stdout.write(value); };
const stderr = (value: string): void => { process.stderr.write(value); };

function flagValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  return value && !value.startsWith('--') ? value : undefined;
}

function requiredVersion(args: readonly string[]): number {
  const raw = flagValue(args, '--state-version') ?? flagValue(args, '--version');
  const value = raw === undefined ? Number.NaN : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('An exact --state-version <n> is required');
  return value;
}

function print(value: unknown, json: boolean, out: (value: string) => void): void {
  if (json) { out(`${JSON.stringify(value, null, 2)}\n`); return; }
  if (Array.isArray(value)) {
    if (value.length === 0) { out('No learned items in the active scope.\n'); return; }
    for (const entry of value as Array<{ id?: string; confidence?: string; lifecycle?: string; content?: string | null }>) {
      out(`${entry.id ?? '-'}  ${entry.confidence ?? ''}  ${entry.lifecycle ?? ''}\n  ${entry.content ?? '[content deleted]'}\n`);
    }
    return;
  }
  out(`${JSON.stringify(value, null, 2)}\n`);
}

function help(out: (value: string) => void): number {
  out(
    'Usage: aiden learning <action> [args] [--json]\n\n' +
    'Actions:\n' +
    '  list                              List scoped learned items.\n' +
    '  show <id>                         Show content and durable provenance.\n' +
    '  review [id]                       Show review queue or one full history.\n' +
    '  export                            Export scoped records as redacted JSON.\n' +
    '  archive <id> --state-version <n>        Stop automatic use and keep history.\n' +
    '  delete <id> --state-version <n> --yes   Hard-delete learned plaintext.\n' +
    '  rebuild                           Rebuild derived projection and FTS.\n',
  );
  return 0;
}

/** Bounded management adapter; it never captures implicit chat content. */
export async function runLearningSubcommand(
  action: string,
  args: string[],
  options: LearningCliOptions = {},
): Promise<number> {
  const out = options.writeOut ?? stdout;
  const err = options.writeErr ?? stderr;
  const json = args.includes('--json');
  if (action === 'help' || action === '--help') return help(out);

  const paths = resolveAidenPaths(options.rootDir ? { rootOverride: options.rootDir } : {});
  const databasePath = options.dbPath ?? daemonDbPath(paths.root);
  const local = integrationLocalScope(options.cwd ?? process.cwd());
  const scopes = options.scopes ?? localLearningScopes(local);
  const defaultScope = options.defaultScope ?? scopes.find((scope) => scope.kind === 'REPOSITORY') ?? scopes[0];
  if (!defaultScope) { err('No reliable Learning scope is available.\n'); return 1; }
  const detected = options.enabled === undefined ? detectProductEdition() !== 'community' : options.enabled;
  const edition = buildEditionAuthority(detected ? 'pro' : 'community');
  const db = openDaemonDb(databasePath);
  try {
    const authority = createLearningAuthority({ db, enabled: edition.can('learning.enabled') });
    const port = createWorkbenchLearningPort({ authority, edition, scopes, defaultScope });
    const id = args.find((value) => !value.startsWith('--')
      && value !== flagValue(args, '--state-version')
      && value !== flagValue(args, '--version')
      && value !== flagValue(args, '--reason'));
    switch (action || 'list') {
      case 'list':
        print(authority.list({ scopes }), json, out);
        return 0;
      case 'show':
        if (!id) { err('Learning entry id is required.\n'); return 2; }
        print(port.review(id), json, out);
        return 0;
      case 'review':
        print(id ? port.review(id) : { needsReview: port.snapshot().needsReview, conflicts: port.snapshot().conflicts }, json, out);
        return 0;
      case 'export':
        print(port.export(), true, out);
        return 0;
      case 'archive': {
        if (!id) { err('Learning entry id is required.\n'); return 2; }
        const result = port.archive({
          entryId: id,
          expectedVersion: requiredVersion(args),
          reason: flagValue(args, '--reason') ?? 'archived_by_user',
        });
        print(result, json, out);
        return 0;
      }
      case 'delete': {
        if (!id) { err('Learning entry id is required.\n'); return 2; }
        if (!args.includes('--yes')) { err('Hard deletion requires --yes confirmation.\n'); return 2; }
        const result = port.delete({
          entryId: id,
          expectedVersion: requiredVersion(args),
          reason: flagValue(args, '--reason') ?? 'privacy_request',
        });
        print(result, json, out);
        return 0;
      }
      case 'rebuild':
        print(port.rebuild(), json, out);
        return 0;
      default:
        err(`Unknown learning action: ${action}\n`);
        help(err);
        return 2;
    }
  } catch (error) {
    err(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    closeDaemonDb(databasePath);
  }
}
