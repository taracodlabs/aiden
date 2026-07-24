/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/update/recoveryScript.ts — v4.9.2 SLICE 1.
 *
 * Fallback when spawnCommand() itself fails to launch npm (synchronous
 * throw — invalid argv shape, cmd.exe missing, etc.). We write a small
 * shell script the user can run by hand to complete the install and
 * report its path in the failure message. Honest: we tried, we couldn't
 * launch, here's the exact thing to type.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface RecoveryScriptInput {
  platform:    NodeJS.Platform;
  home:        string;
  packageSpec: string;
}

/**
 * Write a recovery script under `~/.aiden/`:
 *   - Windows → update-recovery.ps1 (PowerShell)
 *   - Unix    → update-recovery.sh  (bash, +x)
 *
 * Returns the absolute path written. Creates `~/.aiden/` if missing.
 */
export async function writeRecoveryScript(input: RecoveryScriptInput): Promise<string> {
  const aidenDir = path.join(input.home, '.aiden');
  await fs.mkdir(aidenDir, { recursive: true });

  if (input.platform === 'win32') {
    const p = path.join(aidenDir, 'update-recovery.ps1');
    const body = [
      '# Aiden v4.9.2 — install-recovery fallback.',
      '# Run from PowerShell (right-click → "Run with PowerShell" if associated).',
      `Write-Host "Installing ${input.packageSpec} via npm..."`,
      `npm install -g ${input.packageSpec}`,
      'if ($LASTEXITCODE -ne 0) {',
      '  Write-Host "If you saw EPERM/EACCES, use the shell or environment manager that owns the configured npm prefix."',
      '  exit $LASTEXITCODE',
      '}',
      `Write-Host "Done. Type 'aiden' to launch the new version."`,
      '',
    ].join('\r\n');
    await fs.writeFile(p, body, 'utf8');
    return p;
  }

  const p = path.join(aidenDir, 'update-recovery.sh');
  const body = [
    '#!/usr/bin/env bash',
    '# Aiden v4.9.2 — install-recovery fallback.',
    'set -e',
    `echo "Installing ${input.packageSpec} via npm..."`,
    `if ! npm install -g ${input.packageSpec}; then`,
    '  echo "Install failed. If you saw EACCES, use the shell or environment manager that owns the configured npm prefix."',
    '  exit 1',
    'fi',
    'echo "Done. Type \\"aiden\\" to launch the new version."',
    '',
  ].join('\n');
  await fs.writeFile(p, body, 'utf8');
  try { await fs.chmod(p, 0o755); } catch { /* noop on platforms that don't support chmod */ }
  return p;
}
