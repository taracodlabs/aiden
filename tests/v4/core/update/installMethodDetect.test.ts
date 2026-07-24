/**
 * v4.5 update system — install-method detection tests.
 */
import { describe, it, expect } from 'vitest';
import { detectInstallMethod } from '../../../../core/v4/update/installMethodDetect';

describe('detectInstallMethod', () => {
  it('detects npx via _npx cache marker in moduleDir', () => {
    const r = detectInstallMethod({
      moduleDir: '/home/user/.npm/_npx/abc123/node_modules/aiden-runtime/dist',
      argvScript: '/home/user/.npm/_npx/abc123/node_modules/.bin/aiden',
      env: {},
    });
    expect(r.method).toBe('npx');
    expect(r.inProcessInstallSupported).toBe(false);
    expect(r.updateCommand('4.5.1')).toMatch(/npx aiden-runtime@4\.5\.1/);
  });

  it('detects standalone-binary via env flag', () => {
    const r = detectInstallMethod({
      env: { AIDEN_STANDALONE_BINARY: '1' },
      moduleDir: '/opt/aiden',
    });
    expect(r.method).toBe('standalone-binary');
    expect(r.inProcessInstallSupported).toBe(false);
    expect(r.updateCommand('4.5.1')).toMatch(/github\.com\/taracodlabs\/aiden\/releases/);
  });

  it('detects npm-global via standard global node_modules path (Unix nvm)', () => {
    const r = detectInstallMethod({
      moduleDir: '/home/user/.nvm/versions/node/v20.10.0/lib/node_modules/aiden-runtime/dist',
      env: {},
    });
    expect(r.method).toBe('npm-global');
    expect(r.inProcessInstallSupported).toBe(true);
    expect(r.updateCommand('4.5.1')).toBe('npm install -g aiden-runtime@4.5.1');
  });

  it('detects npm-global via Windows nodejs path', () => {
    const r = detectInstallMethod({
      moduleDir: 'C:\\Program Files\\nodejs\\node_modules\\aiden-runtime\\dist',
      env: {},
      platform: 'win32',
    });
    expect(r.method).toBe('npm-global');
    expect(r.inProcessInstallSupported).toBe(true);
  });

  it('detects npm-local when node_modules is under a project (not global)', () => {
    const r = detectInstallMethod({
      moduleDir: '/home/user/my-project/node_modules/aiden-runtime/dist',
      env: {},
    });
    expect(r.method).toBe('npm-local');
    expect(r.inProcessInstallSupported).toBe(false);
    expect(r.updateCommand('4.5.1')).toMatch(/cd .+ && npm install aiden-runtime@4\.5\.1/);
  });

  it('detects a live TypeScript CLI as a source checkout', () => {
    const r = detectInstallMethod({
      moduleDir: '/some/dev/checkout/aiden',
      argvScript: '/some/dev/checkout/aiden/cli/v4/aidenCLI.ts',
      env: {},
    });
    expect(r.method).toBe('source');
    expect(r.inProcessInstallSupported).toBe(false);
    expect(r.updateCommand('4.5.1')).toMatch(/source checkout/);
  });
});
