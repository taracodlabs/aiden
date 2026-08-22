/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { createHash } from 'node:crypto';

import type { MemorySnapshot } from '../memoryProvider';
import type { LearningAuthority } from './learningAuthority';
import type { LearningScope, LearningType } from './types';

const TAGGED_ENTRY = /^\s*(?:[-*]\s+)?\[(said|saw|guess)\]\s+(.+?)\s*$/i;
const UNTYPED_ENTRY = /^\s*[-*]\s+\S/;

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function learningTypeFor(namespace: string): LearningType {
  return namespace === 'user' ? 'USER_PREFERENCE' : 'WORKSPACE_CONVENTION';
}

export interface LegacyMemoryMigrationResult {
  imported: number;
  rejected: number;
  duplicates: number;
  rejectedReasons: Array<{ namespace: string; line: number; reason: string }>;
}

/**
 * Selectively projects provenance-tagged legacy entries. It never edits the
 * source snapshot, and retrieval keeps legacy-only rows shadowed while the old
 * MemoryProvider remains an active prompt source.
 */
export function migrateLegacyMemorySnapshot(input: {
  authority: LearningAuthority;
  snapshot: MemorySnapshot;
  resolveScope(namespace: string, filePath: string | null): LearningScope | null;
}): LegacyMemoryMigrationResult {
  const files = input.snapshot.files ?? {
    memory: { content: input.snapshot.memoryMd, charCount: input.snapshot.memoryMd.length, charLimit: 0, path: 'MEMORY.md' },
    user: { content: input.snapshot.userMd, charCount: input.snapshot.userMd.length, charLimit: 0, path: 'USER.md' },
  };
  const result: LegacyMemoryMigrationResult = { imported: 0, rejected: 0, duplicates: 0, rejectedReasons: [] };
  for (const [namespace, file] of Object.entries(files).sort(([left], [right]) => left.localeCompare(right))) {
    const scope = input.resolveScope(namespace, file.path ?? null);
    if (!scope) continue;
    const fileDigest = digest(`${namespace}\0${file.path}\0${file.content}`);
    const lines = file.content.replace(/\r\n?/g, '\n').split('\n');
    lines.forEach((line, index) => {
      const match = line.match(TAGGED_ENTRY);
      if (!match) {
        if (UNTYPED_ENTRY.test(line)) {
          result.rejected += 1;
          result.rejectedReasons.push({ namespace, line: index + 1, reason: 'provenance_unknown' });
        }
        return;
      }
      const provenance = match[1]!.toLowerCase() as 'said' | 'saw' | 'guess';
      const content = match[2]!.trim();
      const lineDigest = digest(`${namespace}\0${index + 1}\0${content}`);
      const captured = input.authority.capture({
        scope,
        type: learningTypeFor(namespace),
        subjectKey: `legacy.${namespace}.${lineDigest.slice(0, 24)}`,
        content,
        source: {
          kind: 'LEGACY_MEMORY',
          identity: `${fileDigest}:${index + 1}`,
          revision: lineDigest,
          independentKey: `${fileDigest}:${index + 1}`,
          metadata: {
            namespace,
            provenance,
            provenanceVerified: provenance === 'said',
          },
        },
      });
      if (captured.duplicate) result.duplicates += 1;
      else result.imported += 1;
    });
  }
  return result;
}
