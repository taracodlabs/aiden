/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import type { EditionAuthority } from '../commercial/edition';
import type { LearningAuthority } from '../learning/learningAuthority';
import type {
  LearningEntry,
  LearningExport,
  LearningScope,
  LearningScopeKind,
  LearningType,
} from '../learning/types';

const LEARNING_TYPES: ReadonlySet<LearningType> = new Set([
  'USER_PREFERENCE', 'USER_CORRECTION', 'WORKSPACE_CONVENTION',
  'VERIFIED_PROCEDURE_LESSON', 'TOOL_RELIABILITY_LESSON', 'SKILL_RELIABILITY',
  'PRESENCE_FEEDBACK', 'RECOVERY_LESSON',
]);

export interface WorkbenchLearningSnapshot {
  enabled: boolean;
  trusted: LearningEntry[];
  needsReview: LearningEntry[];
  archived: LearningEntry[];
  conflicts: ReturnType<LearningAuthority['conflicts']>;
  counts: { trusted: number; needsReview: number; conflicts: number; archived: number };
}

export interface WorkbenchLearningPort {
  snapshot(): WorkbenchLearningSnapshot;
  review(entryId: string): {
    entry: LearningEntry;
    history: ReturnType<LearningAuthority['history']>;
    versions: ReturnType<LearningAuthority['versions']>;
    sources: LearningExport['sources'];
    conflicts: LearningExport['conflicts'];
  };
  remember(input: {
    content: string;
    subjectKey: string;
    type: LearningType;
    scopeKind: LearningScopeKind;
    idempotencyKey: string;
  }): LearningEntry;
  edit(input: { entryId: string; expectedVersion: number; content: string; idempotencyKey: string }): LearningEntry;
  rollback(input: { entryId: string; expectedVersion: number; versionId: string; idempotencyKey: string }): LearningEntry;
  demote(input: { entryId: string; expectedVersion: number; reason: string }): LearningEntry;
  archive(input: { entryId: string; expectedVersion: number; reason: string }): LearningEntry;
  delete(input: { entryId: string; expectedVersion: number; reason: string }): LearningEntry;
  export(): LearningExport;
  rebuild(): ReturnType<LearningAuthority['rebuild']>;
}

function sameScope(left: LearningScope, right: LearningScope): boolean {
  return left.kind === right.kind && left.key === right.key && left.ownerId === right.ownerId
    && left.workspaceId === right.workspaceId;
}

export function createWorkbenchLearningPort(options: {
  authority: LearningAuthority;
  edition: EditionAuthority;
  scopes: LearningScope[];
  defaultScope: LearningScope;
}): WorkbenchLearningPort {
  if (!options.scopes.some((scope) => sameScope(scope, options.defaultScope))) {
    throw new Error('Default Learning scope must be part of the active Workbench scopes');
  }
  const scopedEntry = (entryId: string): LearningEntry => {
    const entry = options.authority.get(entryId);
    if (!entry || !options.scopes.some((scope) => sameScope(scope, entry.scope))) {
      throw new Error('Learning entry not found in the active Workbench scope');
    }
    return entry;
  };
  const requireEnabled = (): void => {
    if (!options.edition.can('learning.enabled')) throw new Error('Learning capture requires Aiden Pro');
  };
  const requestedScope = (kind: LearningScopeKind): LearningScope => {
    const scope = options.scopes.find((candidate) => candidate.kind === kind);
    if (!scope) throw new Error('Requested Learning scope is outside the active Workbench scope');
    return scope;
  };

  return {
    snapshot() {
      const entries = options.authority.list({ scopes: options.scopes });
      const trusted = entries.filter((entry) => entry.lifecycle === 'ACTIVE' && entry.confidence === 'TRUSTED' && entry.eligible);
      const archived = entries.filter((entry) => entry.lifecycle === 'ARCHIVED');
      const needsReview = entries.filter((entry) => entry.lifecycle !== 'ARCHIVED'
        && !(entry.lifecycle === 'ACTIVE' && entry.confidence === 'TRUSTED' && entry.eligible));
      const conflicts = options.authority.conflicts({ scopes: options.scopes });
      return {
        enabled: options.edition.can('learning.enabled'),
        trusted,
        needsReview,
        archived,
        conflicts,
        counts: { trusted: trusted.length, needsReview: needsReview.length, conflicts: conflicts.length, archived: archived.length },
      };
    },
    review(entryId) {
      const entry = scopedEntry(entryId);
      const exported = options.authority.export({ scopes: options.scopes, includeDeleted: true });
      return {
        entry,
        history: options.authority.history(entry.id),
        versions: options.authority.versions(entry.id),
        sources: exported.sources.filter((source) => source.entryId === entry.id),
        conflicts: exported.conflicts.filter((conflict) =>
          conflict.leftEntryId === entry.id || conflict.rightEntryId === entry.id),
      };
    },
    remember(input) {
      requireEnabled();
      if (!LEARNING_TYPES.has(input.type)) throw new Error('Unsupported Learning type');
      const scope = requestedScope(input.scopeKind);
      return options.authority.capture({
        scope,
        type: input.type,
        subjectKey: input.subjectKey,
        content: input.content,
        source: {
          kind: 'USER_EXPLICIT',
          identity: `workbench:${input.idempotencyKey}`,
          revision: '1',
          independentKey: `workbench:${input.idempotencyKey}`,
        },
      }).entry;
    },
    edit(input) {
      requireEnabled();
      scopedEntry(input.entryId);
      return options.authority.correct({
        entryId: input.entryId,
        expectedVersion: input.expectedVersion,
        content: input.content,
        source: {
          kind: 'USER_CORRECTION',
          identity: `workbench:${input.idempotencyKey}`,
          revision: '1',
          independentKey: `workbench:${input.idempotencyKey}`,
        },
      });
    },
    rollback(input) {
      requireEnabled();
      scopedEntry(input.entryId);
      return options.authority.rollback({
        entryId: input.entryId,
        expectedVersion: input.expectedVersion,
        versionId: input.versionId,
        source: {
          kind: 'USER_CORRECTION',
          identity: `workbench:${input.idempotencyKey}`,
          revision: '1',
          independentKey: `workbench:${input.idempotencyKey}`,
        },
      });
    },
    demote(input) {
      scopedEntry(input.entryId);
      return options.authority.demote({ ...input, source: {
        kind: 'USER_EXPLICIT', identity: `management:demote:${input.entryId}:${input.expectedVersion}`,
        revision: '1', independentKey: `management:demote:${input.entryId}:${input.expectedVersion}`,
      } });
    },
    archive(input) {
      scopedEntry(input.entryId);
      return options.authority.archive({ ...input, source: {
        kind: 'USER_EXPLICIT', identity: `management:archive:${input.entryId}:${input.expectedVersion}`,
        revision: '1', independentKey: `management:archive:${input.entryId}:${input.expectedVersion}`,
      } });
    },
    delete(input) {
      scopedEntry(input.entryId);
      return options.authority.delete({ ...input, source: {
        kind: 'USER_EXPLICIT', identity: `management:delete:${input.entryId}:${input.expectedVersion}`,
        revision: '1', independentKey: `management:delete:${input.entryId}:${input.expectedVersion}`,
      } });
    },
    export() { return options.authority.export({ scopes: options.scopes, includeDeleted: true }); },
    rebuild() { return options.authority.rebuild(); },
  };
}
