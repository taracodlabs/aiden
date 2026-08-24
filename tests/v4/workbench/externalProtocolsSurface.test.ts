/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */
import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';

describe('Workbench external protocol product surface', () => {
  it('uses the private read-only bridge instead of the legacy direct MCP service', async () => {
    const client = await fs.readFile(path.resolve(__dirname, '../../../dashboard-next/lib/aidenClient.ts'), 'utf8');
    const page = await fs.readFile(path.resolve(__dirname, '../../../dashboard-next/app/page.tsx'), 'utf8');

    expect(client).toContain("fetch('/api/external-protocols'");
    expect(client).toContain("'x-workbench-token': token()");
    expect(page).toContain('loadWorkbenchExternalProtocols');
    expect(page).not.toContain("fetch('http://localhost:4200/api/mcp/list'");
    expect(page).not.toContain("fetch('http://localhost:4200/api/mcp/connect'");
  });

  it('renders exact trust, protocol, capability, RemoteTask, and mutation-disabled facts', async () => {
    const client = await fs.readFile(path.resolve(__dirname, '../../../dashboard-next/lib/aidenClient.ts'), 'utf8');
    const page = await fs.readFile(path.resolve(__dirname, '../../../dashboard-next/app/page.tsx'), 'utf8');
    for (const term of [
      'protocolVersion', 'trustState', 'capabilityChange', 'reviewRequired',
      'readToolCount', 'mutationToolCount', 'recoverableTasks', 'locallyVerified',
      'quarantinedArtifacts', 'Mutation delegation is disabled',
    ]) expect(page).toContain(term);
    expect(client).toContain('cancelExternalRemoteTask');
    expect(client).toContain('reconcileExternalRemoteTask');
    expect(page).toContain('Cancel remote task');
    expect(page).toContain('Reconcile remote task');
    expect(page).toContain('aiden.cancelExternalRemoteTask');
    expect(page).toContain('aiden.reconcileExternalRemoteTask');
  });

  it('mounts the external protocol projection on a reachable Workbench settings surface', async () => {
    const page = await fs.readFile(path.resolve(__dirname, '../../../dashboard-next/app/page.tsx'), 'utf8');
    const capabilitiesSurface = page.match(
      /\{settingsTab === 'capabilities'[\s\S]*?<SettingsSection title="Capabilities">([\s\S]*?)<\/SettingsSection>/,
    )?.[1] ?? '';

    expect(capabilitiesSurface).toContain('<PluginsList />');
    expect(capabilitiesSurface).toContain('<MCPView />');
    expect(capabilitiesSurface).toContain('Advanced protocols and extensions');
  });
});
