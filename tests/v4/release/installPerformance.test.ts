import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findSystemBrowserExecutable, NO_SYSTEM_BROWSER_ERROR } from '../../../core/browserExecutable';

const repoRoot = path.resolve(__dirname, '../../..');
const readJson = (name: string): Record<string, any> =>
  JSON.parse(fs.readFileSync(path.join(repoRoot, name), 'utf8')) as Record<string, any>;

describe('runtime installation boundary', () => {
  it('does not install browser automation or WhatsApp in the core runtime', () => {
    const manifest = readJson('package.json');
    const dependencies = {
      ...(manifest.dependencies ?? {}),
      ...(manifest.optionalDependencies ?? {}),
    };

    expect(dependencies).not.toHaveProperty('puppeteer');
    expect(dependencies).not.toHaveProperty('puppeteer-core');
    expect(dependencies).not.toHaveProperty('whatsapp-web.js');
  });

  it('keeps type-only packages out of runtime dependencies', () => {
    const manifest = readJson('package.json');
    const runtime = manifest.dependencies ?? {};
    const development = manifest.devDependencies ?? {};

    for (const name of [
      '@types/archiver',
      '@types/bcrypt',
      '@types/sql.js',
      '@types/twilio',
      '@types/ws',
    ]) {
      expect(runtime).not.toHaveProperty(name);
      expect(development).toHaveProperty(name);
    }
  });

  it('keeps the obsolete workspace and protected release note outside the package scope', () => {
    const manifest = readJson('package.json');
    const files = (manifest.files ?? []) as string[];
    expect(files.join('\n')).not.toContain('release-notes-v4.16.0.md');
    expect(files.join('\n')).not.toContain('packages/aiden-os');

    const lock = fs.readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8');
    expect(lock).not.toContain('node_modules/puppeteer');
    expect(lock).not.toContain('node_modules/whatsapp-web.js');
  });

  it('uses a detected system browser for the owned browser capability', () => {
    const bridge = fs.readFileSync(path.join(repoRoot, 'core/playwrightBridge.ts'), 'utf8');

    expect(bridge).toContain('findSystemBrowserExecutable');
    expect(bridge).toContain('executablePath');
    expect(bridge).toContain('NO_SYSTEM_BROWSER_ERROR');
  });

  it('discovers Chrome or Edge from standard Windows locations without launching a download', () => {
    const executable = findSystemBrowserExecutable({
      platform: 'win32',
      env: {
        PROGRAMFILES: 'C:\\Program Files',
        PATH: '',
      },
      exists: (candidate) => candidate.endsWith('Chrome\\Application\\chrome.exe'),
    });

    expect(executable).toBe('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
    expect(NO_SYSTEM_BROWSER_ERROR).toContain('does not download browsers');
  });

  it('returns a bounded setup result when no system browser exists', () => {
    expect(findSystemBrowserExecutable({
      platform: 'win32',
      env: { PROGRAMFILES: 'C:\\Program Files', PATH: '' },
      exists: () => false,
    })).toBeNull();
    expect(NO_SYSTEM_BROWSER_ERROR).toContain('Install Google Chrome or Microsoft Edge');
  });

  it('keeps the WhatsApp module behind an optional runtime boundary', () => {
    const whatsapp = fs.readFileSync(path.join(repoRoot, 'core/channels/whatsapp.ts'), 'utf8');

    expect(whatsapp).toContain('WHATSAPP_ENABLED');
    expect(whatsapp).toContain('whatsapp-web.js');
    expect(whatsapp).toContain('not available');
  });

  it('ships the disposable installation performance harness', () => {
    const harness = path.join(repoRoot, 'scripts/test-install-performance.mjs');
    expect(fs.existsSync(harness)).toBe(true);
    const source = fs.readFileSync(harness, 'utf8');
    expect(source).toContain('--no-audit');
    expect(source).toContain('--no-fund');
    expect(source).toContain('5 * 60 * 1000');
  });
});
