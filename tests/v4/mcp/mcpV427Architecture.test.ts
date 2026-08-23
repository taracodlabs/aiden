/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../../..');

function sourceFiles(directory: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(absolute));
    else if (entry.isFile() && /\.[cm]?tsx?$/u.test(entry.name)) out.push(absolute);
  }
  return out;
}

function moduleSpecifiers(source: string): string[] {
  return [...source.matchAll(/(?:from\s+|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/gu)]
    .map((match) => match[1]);
}

describe('MCP v4.27 canonical client architecture', () => {
  it('prevents new v4 production code from importing the legacy MCP execution path', () => {
    const roots = ['core/v4', 'cli/v4', 'tools/v4'].map((directory) => path.join(ROOT, directory));
    const offenders = roots.flatMap(sourceFiles).flatMap((file) => {
      const legacy = moduleSpecifiers(fs.readFileSync(file, 'utf8'))
        .filter((specifier) => /(?:^|\/)core\/mcpClient$/u.test(specifier.replace(/\\/gu, '/')));
      return legacy.map((specifier) => `${path.relative(ROOT, file)} -> ${specifier}`);
    });
    expect(offenders).toEqual([]);
  });

  it('keeps legacy MCP imports bounded to explicit pre-v4 compatibility entry points', () => {
    const permitted = new Set([
      'api/server.ts',
      'cli/aiden.ts',
      'core/agentLoop.ts',
      'core/aidenSdk.ts',
      'core/toolRegistry.ts',
    ]);
    const candidates = [
      ...sourceFiles(path.join(ROOT, 'api')),
      ...sourceFiles(path.join(ROOT, 'cli')),
      ...sourceFiles(path.join(ROOT, 'core')),
    ];
    const importers = candidates.filter((file) => moduleSpecifiers(fs.readFileSync(file, 'utf8'))
      .some((specifier) => {
        const resolved = path.resolve(path.dirname(file), specifier).replace(/\\/gu, '/');
        return resolved.endsWith('/core/mcpClient');
      }))
      .map((file) => path.relative(ROOT, file).replace(/\\/gu, '/'))
      .sort();
    expect(importers).toEqual([...permitted].sort());
  });
});
