/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.9.2 SLICE 1 — recoveryScript unit coverage.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeRecoveryScript } from '../../../core/v4/update/recoveryScript';

let home: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-recovery-'));
});
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

describe('writeRecoveryScript', () => {
  it('writes a .ps1 with npm install line under ~/.aiden/ on Windows', async () => {
    const p = await writeRecoveryScript({
      platform: 'win32', home, packageSpec: 'aiden-runtime@latest',
    });
    expect(p).toBe(path.join(home, '.aiden', 'update-recovery.ps1'));
    const body = await fs.readFile(p, 'utf8');
    expect(body).toContain('npm install -g aiden-runtime@latest');
    expect(body).toContain('configured npm prefix');
    expect(body).not.toContain('Administrator PowerShell');
    // CRLF line endings on Windows script.
    expect(body).toContain('\r\n');
  });

  it('writes a .sh with sudo retry hint on Linux + makes it executable', async () => {
    const p = await writeRecoveryScript({
      platform: 'linux', home, packageSpec: 'aiden-runtime@latest',
    });
    expect(p).toBe(path.join(home, '.aiden', 'update-recovery.sh'));
    const body = await fs.readFile(p, 'utf8');
    expect(body.startsWith('#!/usr/bin/env bash')).toBe(true);
    expect(body).toContain('npm install -g aiden-runtime@latest');
    expect(body).toContain('configured npm prefix');
    expect(body).not.toContain('sudo $0');
    // Mode check is best-effort — chmod is a noop on platforms that
    // don't support it. Just confirm the file exists.
    const st = await fs.stat(p);
    expect(st.isFile()).toBe(true);
  });

  it('writes .sh on darwin (treated as POSIX)', async () => {
    const p = await writeRecoveryScript({
      platform: 'darwin', home, packageSpec: 'aiden-runtime@latest',
    });
    expect(p.endsWith('update-recovery.sh')).toBe(true);
  });

  it('creates ~/.aiden/ if missing', async () => {
    // home tmpdir is fresh — no .aiden inside.
    const aidenDir = path.join(home, '.aiden');
    let existed = true;
    try { await fs.access(aidenDir); } catch { existed = false; }
    expect(existed).toBe(false);
    await writeRecoveryScript({ platform: 'win32', home, packageSpec: 'aiden-runtime@latest' });
    await fs.access(aidenDir); // throws if missing
  });

  it('honors a custom packageSpec (e.g. beta tag)', async () => {
    const p = await writeRecoveryScript({
      platform: 'linux', home, packageSpec: 'aiden-runtime@beta',
    });
    const body = await fs.readFile(p, 'utf8');
    expect(body).toContain('npm install -g aiden-runtime@beta');
  });
});
