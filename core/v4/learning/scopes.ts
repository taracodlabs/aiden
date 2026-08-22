/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import type { LearningScope } from './types';

/** One deterministic scope set shared by CLI, daemon, and Workbench adapters. */
export function localLearningScopes(input: { ownerId: string; workspaceId: string }): LearningScope[] {
  return [
    { kind: 'USER_GLOBAL', key: input.ownerId, ownerId: input.ownerId, workspaceId: null },
    { kind: 'WORKSPACE', key: input.workspaceId, ownerId: input.ownerId, workspaceId: input.workspaceId },
    { kind: 'REPOSITORY', key: input.workspaceId, ownerId: input.ownerId, workspaceId: input.workspaceId },
  ];
}

/** Conservative legacy namespace mapping; unknown namespaces are not imported. */
export function legacyLearningScope(scopes: readonly LearningScope[], namespace: string): LearningScope | null {
  const kind = namespace === 'user'
    ? 'USER_GLOBAL'
    : namespace === 'memory'
      ? 'WORKSPACE'
      : namespace === 'project'
        ? 'REPOSITORY'
        : null;
  return kind ? scopes.find((scope) => scope.kind === kind) ?? null : null;
}
