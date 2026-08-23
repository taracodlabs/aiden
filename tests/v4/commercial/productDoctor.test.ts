import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveAidenPaths } from '../../../core/v4/paths';
import {
  applySafeDoctorFixes,
  productDoctorResults,
  toDoctorJson,
} from '../../../core/v4/commercial/productDoctor';
import type { DoctorReport } from '../../../cli/v4/doctor';
import type { SystemReadinessProjection } from '../../../core/v4/workbench/systemReadiness';

const roots: string[] = [];
async function paths() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-doctor-product-'));
  roots.push(root);
  return resolveAidenPaths({ rootOverride: root });
}
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))));

describe('product doctor', () => {
  it('projects Workbench readiness from the existing authority', async () => {
    const checkedAt = Date.now();
    const readiness: SystemReadinessProjection = {
      overall: 'needs_attention', checkedAt,
      items: [{
        id: 'browser', category: 'browser', state: 'needs_setup', title: 'Browser',
        detail: 'Permission required', configured: false, available: true, healthy: false,
        blocking: false, severity: 'warning', availableActions: ['review_browser_permission'], checkedAt,
      }],
      issues: [],
    };
    const results = await productDoctorResults({ paths: await paths(), installedVersion: '4.20.0', readiness });
    expect(results).toContainEqual(expect.objectContaining({ group: 'Browser', name: 'Browser', message: 'Permission required' }));
    expect(results.find((entry) => entry.name === 'Browser')?.suggestion).toContain('review browser permission');
  });

  it('emits commercial checks only when commercial context is supplied', async () => {
    const without = await productDoctorResults({ paths: await paths(), installedVersion: '4.20.0' });
    expect(without.some((entry) => entry.group === 'Commercial')).toBe(false);
    const withCommercial = await productDoctorResults({
      paths: await paths(), installedVersion: '4.20.0',
      commercial: { edition: 'pro', entitlementState: 'active', updateChannel: 'pro-preview' },
    });
    expect(withCommercial.filter((entry) => entry.group === 'Commercial')).toHaveLength(3);
    expect(withCommercial).toContainEqual(expect.objectContaining({
      group: 'Learning', name: 'Evidence-linked Learning', message: 'not initialized yet',
    }));
  });

  it('reports canonical external protocol readiness when nothing is configured', async () => {
    const results = await productDoctorResults({ paths: await paths(), installedVersion: '4.20.0' });

    expect(results).toContainEqual(expect.objectContaining({
      group: 'MCP', name: 'MCP protocol', passed: true,
      message: expect.stringContaining('2025-11-25'),
    }));
    expect(results).toContainEqual(expect.objectContaining({
      group: 'MCP', name: 'MCP servers', passed: true,
      message: expect.stringContaining('no servers configured'),
    }));
    expect(results).toContainEqual(expect.objectContaining({
      group: 'A2A', name: 'A2A preview', passed: true,
      message: expect.stringContaining('read-only'),
    }));
    expect(results).toContainEqual(expect.objectContaining({
      group: 'A2A', name: 'A2A agents', passed: true,
      message: expect.stringContaining('no agents configured'),
    }));
  });

  it('surfaces exact MCP drift and A2A recovery truth from existing authorities', async () => {
    const results = await productDoctorResults({
      paths: await paths(), installedVersion: '4.20.0',
      externalProtocols: {
        mcpServers: [{
          name: 'repo', endpoint: 'https://mcp.example.test', transport: 'streamable',
          protocolVersion: '2025-11-25', status: 'ready', trustState: 'changed',
          capabilityChangeClass: 'mutation', reviewRequired: true, toolCount: 4,
          resourcesAvailable: true,
        }],
        a2aIdentities: [{ displayName: 'repo-reader', trustState: 'verified_key' }],
        a2aRecoverableTasks: [{ state: 'unknown', locallyVerified: false }],
        quarantinedArtifacts: 2,
      },
    });

    expect(results).toContainEqual(expect.objectContaining({
      group: 'MCP', name: 'MCP repo', passed: false,
      message: expect.stringContaining('mutation drift'),
    }));
    expect(results).toContainEqual(expect.objectContaining({
      group: 'A2A', name: 'A2A RemoteTasks', passed: false,
      message: expect.stringContaining('1 recoverable'),
    }));
    expect(results).toContainEqual(expect.objectContaining({
      group: 'A2A', name: 'A2A quarantine', passed: true,
      message: '2 quarantined artifacts',
    }));
  });

  it('produces stable JSON and redacts credential-shaped values', () => {
    const report: DoctorReport = {
      passed: false, totalMs: 12,
      results: [
        { name: 'provider', group: 'AI', passed: true, message: 'API_KEY=super-secret' },
        { name: 'browser', group: 'Browser', passed: false, message: 'Permission required', suggestion: 'Open Settings' },
      ],
    };
    const json = toDoctorJson(report, () => new Date('2026-08-21T00:00:00Z'));
    expect(json.schemaVersion).toBe(1);
    expect(json.summary).toEqual({ passing: 1, warning: 0, failing: 1 });
    expect(JSON.stringify(json)).not.toContain('super-secret');
    expect(json.checks[0].message).toContain('<redacted>');
  });

  it('fix mode creates only safe local runtime directories', async () => {
    const p = await paths();
    await fs.rm(p.root, { recursive: true, force: true });
    const fixes = await applySafeDoctorFixes(p);
    expect(fixes.every((entry) => entry.applied)).toBe(true);
    for (const directory of [p.root, p.logsDir, p.sessionsDir, p.pluginsDir]) {
      expect((await fs.stat(directory)).isDirectory()).toBe(true);
    }
  });

  it('keeps unsafe repairs out of fix mode', async () => {
    const source = await fs.readFile(path.resolve(__dirname, '../../../core/v4/commercial/productDoctor.ts'), 'utf8');
    const fixMode = source.slice(
      source.indexOf('export async function applySafeDoctorFixes'),
      source.indexOf('const SECRET_PATTERN'),
    );
    expect(fixMode).not.toMatch(/install Docker|firewall|trust store|OAuth|provider login/i);
  });
});

