/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Canonical location for runtime-owned state and artifacts.
 */
import path from 'node:path';

import { resolveAidenPaths, resolveUserPath, type AidenPaths } from './paths';

export function resolveRuntimeStorageRoot(
  env: NodeJS.ProcessEnv = process.env,
  paths: Pick<AidenPaths, 'root'> = resolveAidenPaths(),
): string {
  return resolveUserPath(env.AIDEN_USER_DATA) ?? paths.root;
}

export function runtimeArtifactDirectory(kind: string, root = resolveRuntimeStorageRoot()): string {
  return path.join(root, 'artifacts', kind);
}
