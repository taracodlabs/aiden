/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveDesktopApiClientLocalCommand } from '../../../cli/desktopApiClientArgs';

const root = path.resolve(__dirname, '../../..');

describe('CLI entrypoint contract', () => {
  it('maps both public commands to the standalone local runtime only', () => {
    const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      bin: Record<string, string>;
      files: string[];
    };
    expect(manifest.bin).toEqual({
      aiden: './bin/aiden-bootstrap.cjs',
      'aiden-runtime': './bin/aiden-bootstrap.cjs',
    });
    expect(manifest.files).toContain('bin/aiden-bootstrap.cjs');
    expect(manifest.files).toContain('bin/aiden-updater.cjs');
    expect(manifest.files).not.toContain('bin/');
    expect(manifest.files).not.toContain('dist-bundle/');
    expect(manifest.files).not.toContain('packages/aiden-os/');
    expect(manifest.files).not.toContain('release-notes-v4.16.0.md');
  });

  it('routes interactive CLI and Workbench through the same installed launcher', () => {
    const bootstrap = readFileSync(path.join(root, 'bin', 'aiden-bootstrap.cjs'), 'utf8');
    const cli = readFileSync(path.join(root, 'cli', 'v4', 'aidenCLI.ts'), 'utf8');
    expect(bootstrap).toContain("const REAL_CLI = path.join('dist', 'cli', 'v4', 'aidenCLI.js')");
    expect(bootstrap).toContain('SUPPORTED_NODE_MAJORS = Object.freeze([20, 22])');
    expect(cli).toContain(".command('web')");
    expect(cli).toContain(".alias('workbench')");
    expect(cli).toContain('await startWorkbenchBridge({');
    expect(cli).toContain('await executionHost.stop()');
  });

  it('answers desktop/API client version and help without a server', () => {
    expect(resolveDesktopApiClientLocalCommand(['--version'], '4.19.0')).toBe('4.19.0\n');
    expect(resolveDesktopApiClientLocalCommand(['-v'], '4.19.0')).toBe('4.19.0\n');
    expect(resolveDesktopApiClientLocalCommand(['--help'], '4.19.0')).toContain('desktop/API client');
    expect(resolveDesktopApiClientLocalCommand(['-h'], '4.19.0')).toContain('AIDEN_API');
    expect(resolveDesktopApiClientLocalCommand([], '4.19.0')).toBeNull();
  });

  it('dispatches local informational flags before the desktop/API health request', () => {
    const source = readFileSync(path.join(root, 'cli/aiden.ts'), 'utf8');
    const localDispatch = source.indexOf('resolveDesktopApiClientLocalCommand(process.argv.slice(2), VERSION)');
    const healthRequest = source.indexOf("apiFetch<any>('/api/health', null)");
    expect(localDispatch).toBeGreaterThanOrEqual(0);
    expect(healthRequest).toBeGreaterThan(localDispatch);
  });
});
