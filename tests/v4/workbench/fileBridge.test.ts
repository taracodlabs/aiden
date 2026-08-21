/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createWorkbenchFileBridge } from '../../../core/v4/workbench/fileBridge';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('Workbench mediated files', () => {
  it('stores an attachment under the owned root and resolves only its opaque identity', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiden-workbench-file-'));
    roots.push(root);
    const bridge = createWorkbenchFileBridge({ root });

    const attachment = bridge.saveAttachment({
      name: '..\\..\\package.json',
      mime: 'application/json',
      bytes: Buffer.from('{"name":"fixture"}'),
    });

    expect(path.dirname(attachment.path)).toBe(path.join(root, 'attachments'));
    expect(path.basename(attachment.path)).toMatch(/^[a-f0-9]+-package\.json$/);
    expect(bridge.resolveAttachments([attachment.id])).toEqual([attachment]);
    expect(() => bridge.resolveAttachments(['attachment_missing'])).toThrow(/unknown attachment/i);
  });

  it('rejects oversized attachments before writing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiden-workbench-file-'));
    roots.push(root);
    const bridge = createWorkbenchFileBridge({ root, maxAttachmentBytes: 4 });

    expect(() => bridge.saveAttachment({ name: 'large.txt', mime: 'text/plain', bytes: Buffer.from('12345') }))
      .toThrow(/too large/i);
    expect(fs.readdirSync(path.join(root, 'attachments'))).toEqual([]);
  });

  it('serves an artifact only through its durable id and sanitizes SVG preview content', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiden-workbench-file-'));
    roots.push(root);
    const artifactPath = path.join(root, 'sun.svg');
    fs.writeFileSync(artifactPath, '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script><circle cx="5" cy="5" r="4"/></svg>');
    const store = {
      get: (id: string) => id === 'art_exact' ? {
        id, path: artifactPath, kind: 'file' as const, tool: 'file_write', action: 'create' as const,
        runId: 7, taskId: 'job_exact', sessionId: 'session_exact', createdAt: 1, bytes: 120, preview: 'sun',
      } : null,
      listRecent: () => [],
    };
    const bridge = createWorkbenchFileBridge({ root, artifacts: store, artifactCwd: root });

    const content = bridge.readArtifact('art_exact');
    expect(content?.mime).toBe('image/svg+xml');
    expect(content?.bytes.toString('utf8')).toContain('<circle');
    expect(content?.bytes.toString('utf8')).not.toMatch(/script|onload/i);
    expect(bridge.readArtifact('C:\\Windows\\win.ini')).toBeNull();
  });

  it('serves a verified archived artifact after its disposable source path is removed', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiden-workbench-file-'));
    roots.push(root);
    const removedSource = path.join(root, 'removed-candidate', 'result.txt');
    const artifact = {
      id: 'art_archived', path: removedSource, kind: 'file' as const, tool: 'file_write', action: 'create' as const,
      runId: 9, taskId: 'job_archived', sessionId: 'session_archived', createdAt: 1, bytes: 18, preview: null,
    };
    const bridge = createWorkbenchFileBridge({
      root,
      artifactCwd: root,
      artifacts: {
        get: (id: string) => id === artifact.id ? artifact : null,
        listRecent: () => [artifact],
        readContent: (id: string) => id === artifact.id
          ? { bytes: Buffer.from('durable result\n'), sourceName: 'result.txt' }
          : null,
      },
    });

    expect(fs.existsSync(removedSource)).toBe(false);
    const content = bridge.readArtifact(artifact.id);
    expect(content?.name).toBe('result.txt');
    expect(content?.mime).toBe('text/plain');
    expect(content?.bytes.toString('utf8')).toBe('durable result\n');
  });

  it('classifies common source artifacts as safe text previews', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiden-workbench-file-'));
    roots.push(root);
    const artifact = {
      id: 'art_source', path: 'slow.js', kind: 'file' as const, tool: 'file_write', action: 'create' as const,
      runId: 10, taskId: 'job_source', sessionId: 'session_source', createdAt: 1, bytes: 18, preview: null,
    };
    const bridge = createWorkbenchFileBridge({
      root,
      artifacts: {
        get: (id: string) => id === artifact.id ? artifact : null,
        listRecent: () => [artifact],
        readContent: () => ({ bytes: Buffer.from('export default 1;\n'), sourceName: 'slow.js' }),
      },
    });

    expect(bridge.readArtifact(artifact.id)).toMatchObject({ name: 'slow.js', mime: 'text/plain' });
  });

  it('rejects a durable artifact identity whose file is outside the active workspace', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiden-workbench-file-'));
    const foreign = fs.mkdtempSync(path.join(os.tmpdir(), 'aiden-workbench-foreign-'));
    roots.push(root, foreign);
    const foreignPath = path.join(foreign, 'foreign.txt');
    fs.writeFileSync(foreignPath, 'not in this workspace');
    const bridge = createWorkbenchFileBridge({
      root,
      artifactCwd: root,
      artifacts: {
        get: (id: string) => id === 'art_foreign' ? {
          id, path: foreignPath, kind: 'file' as const, tool: 'file_write', action: 'create' as const,
          runId: 8, taskId: 'job_foreign', sessionId: 'session_foreign', createdAt: 1, bytes: 21, preview: null,
        } : null,
        listRecent: () => [],
      },
    });

    expect(bridge.readArtifact('art_foreign')).toBeNull();
  });
});
