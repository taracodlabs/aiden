import { describe, expect, it } from 'vitest';
import { projectScriptSpec, validateScriptSpec } from '../../../core/v4/automation/scriptSpec';
import Database from 'better-sqlite3';
import { createAutomationAuthority } from '../../../core/v4/automation/automationAuthority';
import { runMigrations } from '../../../core/v4/daemon/db/migrations';

describe('typed automation ScriptSpec', () => {
  it('projects bounded typed operations without an arbitrary shell field', () => {
    const spec = {
      version: 1 as const, maxRuntimeMs: 30_000,
      steps: [
        { kind: 'read_file' as const, path: 'package.json', maxBytes: 32_000 },
        { kind: 'list_directory' as const, path: 'core/v4', maxEntries: 100 },
      ],
    };
    expect(() => validateScriptSpec(spec)).not.toThrow();
    expect(projectScriptSpec(spec)).toContain('Read file package.json');
    expect(projectScriptSpec(spec)).not.toMatch(/powershell|cmd\.exe|sh -c/i);
  });

  it('rejects traversal, unbounded reads and insecure network targets', () => {
    expect(() => validateScriptSpec({ version: 1, maxRuntimeMs: 1_000, steps: [{ kind: 'read_file', path: '../secret' }] })).toThrow(/workspace-relative/);
    expect(() => validateScriptSpec({ version: 1, maxRuntimeMs: 1_000, steps: [{ kind: 'read_file', path: 'a', maxBytes: 999_999 }] })).toThrow(/maxBytes/);
    expect(() => validateScriptSpec({ version: 1, maxRuntimeMs: 1_000, steps: [{ kind: 'http_request', method: 'GET', url: 'http://example.test' }] })).toThrow(/HTTPS/);
  });

  it('rejects typed steps that exceed the immutable revision capability envelope', () => {
    const db = new Database(':memory:');
    try {
      runMigrations(db);
      expect(() => createAutomationAuthority({ db }).create({
        name: 'Missing capability',
        action: { kind: 'script', script: { version: 1, maxRuntimeMs: 1_000, steps: [{ kind: 'write_file', path: 'out.txt', content: 'safe' }] } },
        trigger: { kind: 'manual' },
        policies: { misfire: { kind: 'skip' }, overlap: 'skip', retry: { maxAttempts: 1 } },
        capabilities: ['repository.read'], credentialRefs: [], workspace: { rootPath: process.cwd() }, createdBy: 'test',
      })).toThrow(/declared capabilities/);
    } finally { db.close(); }
  });
});
