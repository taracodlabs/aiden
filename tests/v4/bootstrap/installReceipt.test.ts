import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../../..');

describe('installation provenance receipt', () => {
  it('records the owning prefix without copying user data into the package', () => {
    const packageRoot = mkdtempSync(path.join(tmpdir(), 'aiden receipt package '));
    const scripts = path.join(packageRoot, 'scripts');
    mkdirSync(scripts, { recursive: true });
    copyFileSync(path.join(root, 'scripts', 'postinstall.js'), path.join(scripts, 'postinstall.js'));
    const prefix = path.join(tmpdir(), 'aiden isolated prefix with spaces');
    const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const childEnv = { ...process.env };
    for (const key of Object.keys(childEnv)) {
      if (/^npm_(?:config_(?:global|prefix)|execpath)$/i.test(key)) delete childEnv[key];
    }
    const result = spawnSync(process.execPath, [path.join(scripts, 'postinstall.js')], {
      encoding: 'utf8',
      env: {
        ...childEnv,
        npm_config_global: 'true',
        npm_config_prefix: prefix,
        npm_execpath: npmCli,
      },
    });
    expect(result.status).toBe(0);
    const receiptPath = path.join(packageRoot, '.aiden-install.json');
    expect(existsSync(receiptPath)).toBe(true);
    expect(JSON.parse(readFileSync(receiptPath, 'utf8'))).toMatchObject({
      schemaVersion: 1,
      global: true,
      prefix,
      npmCli,
      nodeExecutable: process.execPath,
    });
    expect(existsSync(path.join(packageRoot, 'sessions.db'))).toBe(false);
    expect(existsSync(path.join(packageRoot, 'config.yaml'))).toBe(false);
    expect(existsSync(path.join(packageRoot, 'auth.json'))).toBe(false);
  });

  it('does not put secrets or environment contents in the receipt', () => {
    const source = readFileSync(path.join(root, 'scripts', 'postinstall.js'), 'utf8');
    expect(source).not.toMatch(/process\.env\.(?:GROQ_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY)/);
    expect(source).not.toMatch(/JSON\.stringify\(process\.env/);
  });
});
