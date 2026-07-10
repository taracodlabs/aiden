/**
 * Phase 18 Task 7 — first-run detection tests.
 *
 * The lenient isFreshInstall criteria: any of (root missing, config.yaml
 * missing, providers section empty) counts as first-run. Plugins-not-
 * granted is NOT a fresh-install signal — bundled plugins ship in
 * pending-grant state and the boot card surfaces them honestly.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  isFreshInstall,
  printPostWizardTutorial,
} from '../../../cli/v4/setupWizard';
import {
  shouldRunWizard,
  type ProviderDetection,
} from '../../../core/v4/firstRun/providerDetection';
import { Display } from '../../../cli/v4/display';
import { SkinEngine } from '../../../cli/v4/skinEngine';
import {
  resolveAidenPaths,
  ensureAidenDirsExist,
} from '../../../core/v4/paths';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-firstrun-'));
});
afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('isFreshInstall', () => {
  it('61. returns true when paths.root does not exist', async () => {
    const fakeRoot = path.join(tmpRoot, 'never-created');
    const paths = resolveAidenPaths({ rootOverride: fakeRoot });
    expect(await isFreshInstall(paths)).toBe(true);
  });

  it('62. returns true when config.yaml is missing (root exists)', async () => {
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    await ensureAidenDirsExist(paths);
    expect(await isFreshInstall(paths)).toBe(true);
  });

  it('63. returns true when config.yaml has empty providers section', async () => {
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    await ensureAidenDirsExist(paths);
    await fs.writeFile(
      paths.configYaml,
      'model:\n  provider: groq\n  modelId: llama-3.3-70b-versatile\n',
      'utf8',
    );
    // No providers: at all.
    expect(await isFreshInstall(paths)).toBe(true);
  });

  it('64. returns true when providers: is present but empty', async () => {
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    await ensureAidenDirsExist(paths);
    await fs.writeFile(
      paths.configYaml,
      'model:\n  provider: groq\n  modelId: x\nproviders:\n',
      'utf8',
    );
    expect(await isFreshInstall(paths)).toBe(true);
  });

  it('65. returns false when providers: has at least one entry', async () => {
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    await ensureAidenDirsExist(paths);
    await fs.writeFile(
      paths.configYaml,
      [
        'model:',
        '  provider: groq',
        '  modelId: llama-3.3-70b-versatile',
        'providers:',
        '  groq:',
        '    apiKey: ${GROQ_API_KEY}',
      ].join('\n') + '\n',
      'utf8',
    );
    expect(await isFreshInstall(paths)).toBe(false);
  });

  it('66. returns false for a wizard-saved OAuth config (providers.<id>.auth=oauth)', async () => {
    const paths = resolveAidenPaths({ rootOverride: tmpRoot });
    await ensureAidenDirsExist(paths);
    await fs.writeFile(
      paths.configYaml,
      [
        'model:',
        '  provider: chatgpt-plus',
        '  modelId: claude-opus-4-7',
        'providers:',
        '  chatgpt-plus:',
        '    auth: oauth',
      ].join('\n') + '\n',
      'utf8',
    );
    expect(await isFreshInstall(paths)).toBe(false);
  });
});

describe('printPostWizardTutorial', () => {
  // Phase 22 Task 6 replaced the bullet-list tutorial with a rounded
  // box ("Setup Complete" + config map + re-run commands + Try CTA).
  // Detailed shape assertions live in tests/v4/cli/setupWizard.test.ts;
  // this file keeps the cross-cutting first-run / version-flow checks.
  function captureTutorial(version: string): string {
    const chunks: string[] = [];
    const stdout = {
      isTTY: false,
      write(s: string) {
        chunks.push(s);
        return true;
      },
    } as unknown as NodeJS.WriteStream;
    const display = new Display({
      skin: new SkinEngine({ forceMono: true }),
      stdout,
    });
    printPostWizardTutorial(display, version);
    return chunks.join('');
  }

  it('67. renders the boxed setup-complete summary', () => {
    const text = captureTutorial('4.0.0');
    expect(text).toMatch(/┌── Setup Complete /);
    expect(text).toMatch(/Aiden v4\.0\.0 is ready/);
    expect(text).toMatch(/All your files in:/);
    expect(text).toMatch(/Re-run setup:/);
    expect(text).toMatch(/Try: aiden/);
  });

  it('68. version string flows through verbatim', () => {
    expect(captureTutorial('4.1.7-beta')).toContain('Aiden v4.1.7-beta is ready');
  });
});

describe('shouldRunWizard — boot gate (v4.11 config-detection fix)', () => {
  /** ProviderDetection factory; defaults to "nothing configured". */
  function det(over: Partial<ProviderDetection> = {}): ProviderDetection {
    return {
      hasAnyProvider: false,
      envVars: [],
      oauthTokens: [],
      ollamaReachable: false,
      configProvider: null,
      configModel: null,
      configuredProviders: [],
      configuredProviderHasCredentials: false,
      ...over,
    };
  }

  it('forceSetup always fires (the `aiden setup` subcommand)', () => {
    expect(shouldRunWizard(det({ hasAnyProvider: true }), { forceSetup: true, configEmpty: false })).toBe(true);
  });

  it('truly fresh — no provider anywhere → fires', () => {
    expect(shouldRunWizard(det(), { forceSetup: false, configEmpty: true })).toBe(true);
  });

  it('config names a provider with NO usable credentials → fires (broken)', () => {
    const d = det({
      hasAnyProvider: true,            // some unrelated env key exists
      envVars: ['GROQ_API_KEY'],
      configProvider: 'chatgpt-plus',  // but config points here…
      configuredProviderHasCredentials: false, // …and its token is missing
    });
    expect(shouldRunWizard(d, { forceSetup: false, configEmpty: false })).toBe(true);
  });

  it('creds detected but config names no provider → fires (DEFAULT_CONFIG would mis-route)', () => {
    const d = det({ hasAnyProvider: true, envVars: ['GROQ_API_KEY'], configProvider: null });
    expect(shouldRunWizard(d, { forceSetup: false, configEmpty: true })).toBe(true);
  });

  it('inline providers.<id>.apiKey config (moat-boot fixture) → does NOT fire', () => {
    const d = det({
      hasAnyProvider: true,
      configProvider: 'fake',
      configuredProviders: ['fake'],
      configuredProviderHasCredentials: true,
    });
    expect(shouldRunWizard(d, { forceSetup: false, configEmpty: false })).toBe(false);
  });

  // ── THE BUG ANCHOR ──────────────────────────────────────────────
  it('BUG FIX: live OAuth config (chatgpt-plus token) with empty providers: section → does NOT fire', () => {
    // Shiva's case: chatgpt-plus configured via OAuth (token in the auth
    // store, NOT config.yaml providers:), so isFreshInstall reports the
    // config "empty" (configEmpty=true) even though it's working.
    const d = det({
      hasAnyProvider: true,
      oauthTokens: ['chatgpt-plus'],
      configProvider: 'chatgpt-plus',
      configuredProviderHasCredentials: true,
    });
    // Pre-fix this returned true (wizard auto-fired, offered overwrite).
    expect(shouldRunWizard(d, { forceSetup: false, configEmpty: true })).toBe(false);
  });

  it('BUG FIX: live env config (groq via GROQ_API_KEY) with empty providers: section → does NOT fire', () => {
    // Mirrors firstRunDetection test 63: model.provider=groq, no providers:
    // section, GROQ_API_KEY in env → isFreshInstall=true but config is live.
    const d = det({
      hasAnyProvider: true,
      envVars: ['GROQ_API_KEY'],
      configProvider: 'groq',
      configuredProviderHasCredentials: true,
    });
    expect(shouldRunWizard(d, { forceSetup: false, configEmpty: true })).toBe(false);
  });
});
