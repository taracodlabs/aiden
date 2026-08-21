/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const originalCwd = process.cwd();
const originalAidenHome = process.env.AIDEN_HOME;
const roots: string[] = [];

function makeRoot(label: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `aiden-${label}-`));
  roots.push(root);
  return root;
}

function jsonFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
}

afterEach(() => {
  process.chdir(originalCwd);
  if (originalAidenHome === undefined) delete process.env.AIDEN_HOME;
  else process.env.AIDEN_HOME = originalAidenHome;
  vi.resetModules();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('response cache storage authority', () => {
  it('persists cache state outside a clean user repository', async () => {
    const root = makeRoot('response-cache');
    const repository = path.join(root, 'repository');
    const aidenHome = path.join(root, 'aiden-home');
    fs.mkdirSync(repository, { recursive: true });
    process.chdir(repository);
    process.env.AIDEN_HOME = aidenHome;
    vi.resetModules();

    const { responseCache } = await import('../../../core/responseCache');
    responseCache.set('web_search', { query: 'durable jobs' }, 'cached result');

    expect(fs.existsSync(path.join(repository, 'workspace'))).toBe(false);
    expect(jsonFiles(aidenHome)).toHaveLength(1);
  });

  it('uses distinct stable cache files for distinct repositories', async () => {
    const root = makeRoot('response-cache-workspaces');
    const aidenHome = path.join(root, 'aiden-home');
    const firstRepository = path.join(root, 'first');
    const secondRepository = path.join(root, 'second');
    fs.mkdirSync(firstRepository, { recursive: true });
    fs.mkdirSync(secondRepository, { recursive: true });
    process.env.AIDEN_HOME = aidenHome;

    process.chdir(firstRepository);
    vi.resetModules();
    const firstModule = await import('../../../core/responseCache');
    firstModule.responseCache.set('web_search', { query: 'one' }, 'first');

    process.chdir(secondRepository);
    vi.resetModules();
    const secondModule = await import('../../../core/responseCache');
    secondModule.responseCache.set('web_search', { query: 'two' }, 'second');

    const cacheFiles = jsonFiles(aidenHome);
    expect(cacheFiles).toHaveLength(2);
    expect(new Set(cacheFiles.map((file) => path.dirname(file))).size).toBe(2);
  });
});
