import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const setControl = vi.fn();
const upload = vi.fn();
const download = vi.fn();

vi.mock('../../../core/playwrightBridge', () => ({
  pwSetControl: setControl,
  pwUpload: upload,
  pwDownload: download,
  pwSnapshot: vi.fn(async () => ({ ok: true, text: '' })),
}));

const previousDepth = process.env.AIDEN_BROWSER_DEPTH;
process.env.AIDEN_BROWSER_DEPTH = '0';

const { getLeaseStore } = await import('../../../core/v4/browserState');
const { browserControlTool } = await import('../../../tools/v4/browser/browserControl');
const { browserUploadTool } = await import('../../../tools/v4/browser/browserUpload');
const { browserDownloadTool } = await import('../../../tools/v4/browser/browserDownload');

const ctx = { signal: undefined } as never;

describe('structured browser controls and transfers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getLeaseStore().invalidate();
  });

  afterAll(() => {
    if (previousDepth === undefined) delete process.env.AIDEN_BROWSER_DEPTH;
    else process.env.AIDEN_BROWSER_DEPTH = previousDepth;
  });

  it.each([
    ['check', undefined, { checked: true }],
    ['uncheck', undefined, { checked: false }],
    ['radio', undefined, { checked: true }],
    ['select', 'Estonia', { value: 'ee' }],
    ['choose', 'Pro', { value: 'Pro' }],
    ['autocomplete', 'Tallinn', { value: 'Tallinn' }],
  ])('verifies the %s operation without submitting', async (operation, value, output) => {
    setControl.mockResolvedValue({ ok: true, verified: true, ...output });
    const result = await browserControlTool.execute({ selector: '#field', operation, value }, ctx) as Record<string, unknown>;
    expect(result).toMatchObject({ success: true, verified: true, ...output });
    expect(setControl).toHaveBeenCalledWith({ selector: '#field', operation, value });
  });

  it('requires a fresh current-snapshot lease for ref-based controls', async () => {
    const result = await browserControlTool.execute({ ref: '@e1', operation: 'check' }, ctx);
    expect(result).toMatchObject({ success: false });
    expect(setControl).not.toHaveBeenCalled();
  });

  it('validates upload paths and returns verified file readback', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aiden-browser-upload-'));
    const file = join(root, 'fixture.txt');
    writeFileSync(file, 'fixture');
    try {
      upload.mockResolvedValue({ ok: true, files: ['fixture.txt'], verified: true });
      const result = await browserUploadTool.execute({ selector: '#file', paths: [file] }, ctx);
      expect(result).toEqual({ success: true, files: ['fixture.txt'], verified: true });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('rejects relative upload paths before touching the browser', async () => {
    const result = await browserUploadTool.execute({ selector: '#file', paths: ['secret.txt'] }, ctx);
    expect(result).toMatchObject({ success: false, error: 'Upload paths must be absolute' });
    expect(upload).not.toHaveBeenCalled();
  });

  it('projects a verified completed download artifact', async () => {
    download.mockResolvedValue({
      ok: true, verified: true, path: 'artifact/file.txt', filename: 'file.txt',
      size: 7, sha256: 'abc',
    });
    const result = await browserDownloadTool.execute({ selector: '#download' }, ctx);
    expect(result).toEqual({
      success: true, verified: true, artifactPath: 'artifact/file.txt',
      path: 'artifact/file.txt', filename: 'file.txt', size: 7, bytes: 7, sha256: 'abc',
    });
  });
});
