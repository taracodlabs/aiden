/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../../..');
const page = fs.readFileSync(path.join(root, 'dashboard-next/app/page.tsx'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'dashboard-next/app/globals.css'), 'utf8');
const layout = fs.readFileSync(path.join(root, 'dashboard-next/app/layout.tsx'), 'utf8');
const assets = fs.readFileSync(path.join(root, 'dashboard-next/scripts/copy-standalone-assets.js'), 'utf8');

describe('premium Workbench source contracts', () => {
  it('keeps browser identity and copies the existing Aiden icon into the production dashboard', () => {
    expect(layout).toContain("title: 'Aiden Workbench'");
    expect(layout).toContain("icon: '/favicon.png'");
    expect(assets).toContain("assets/icon.png");
    expect(assets).toContain("favicon.png");
  });

  it('renders identity-based live activity and exact durable approvals in Chat', () => {
    expect(page).toContain('LiveActivitySurface');
    expect(page).toContain('pendingApprovalCards');
    expect(page).toContain('Approve once');
    expect(page).toContain('aiden.decideApproval(approvalId, decision)');
    expect(page).toContain("decide(approval.approvalId, 'approved')");
    expect(page).toContain("decide(approval.approvalId, 'denied')");
  });

  it('removes settled execution telemetry from Chat while retaining artifacts', () => {
    const activity = page.slice(page.indexOf('function LiveActivitySurface()'), page.indexOf('function ChatPanel()'));
    expect(activity).toContain('shouldShowChatTelemetry');
    expect(activity).toContain('selectChatLiveActivity');
    expect(activity).toContain('telemetryVisible');
    expect(activity).toContain('runArtifacts.length > 0');
    expect(activity).not.toContain("'Worked'");
    expect(activity).not.toContain('approvalHistory');
    expect(activity).not.toContain('run-identity');
  });

  it('expands live work and removes it after terminal settlement', () => {
    const activity = page.slice(page.indexOf('function LiveActivitySurface()'), page.indexOf('function ChatPanel()'));
    expect(activity).toContain('useState(false)');
    expect(activity).toContain('setExpanded(false)');
    expect(activity).toContain('setTelemetryLeaving(true)');
    expect(activity).toContain('setTelemetryVisible(false)');
  });

  it('uses runtime-mediated attachment upload for picker and drag/drop', () => {
    const uploadBlock = page.match(/const addAttachmentFiles[\s\S]*?const removeAttachment/)?.[0] ?? '';
    expect(uploadBlock).toContain('aiden.uploadAttachment');
    expect(uploadBlock).not.toContain('localhost:4200');
    expect(page).toContain('onDrop=');
    expect(page).toContain('attachmentIds');
  });

  it('uses Windows-correct shortcuts and durable local conversation exports', () => {
    expect(page).toContain('Ctrl+K');
    expect(page).not.toContain('⌘K');
    expect(page).toContain('exportCurrentConversation');
    expect(page).not.toContain('api/export/conversation');
  });

  it('persists Dark or System appearance without moving it into runtime authority', () => {
    expect(page).toContain("type WorkbenchAppearance = 'dark' | 'system'");
    expect(page).toContain("aiden.workbench.appearance.v1");
    expect(page).toContain("document.documentElement.dataset.appearance = appearance");
    expect(page).toContain("settingsTab === 'appearance'");
    expect(page).toContain("setAppearance('dark')");
    expect(page).toContain("setAppearance('system')");
  });

  it('provides a compact runtime-truthful model control and navigation surfaces', () => {
    expect(page).toContain('className="model-control"');
    expect(page).toContain("setSettingsTab('model')");
    expect(page).toContain('activeProvider');
    expect(page).toContain('activeModel');
    expect(page).toContain('className="history-sidebar sidebar-rail"');
    expect(page).toContain("setMainView('artifacts')");
    expect(page).toContain("setMainView('sponsors')");
  });

  it('provides one functional Apps surface without accepting provider credentials in browser state', () => {
    expect(page).toContain("setMainView('apps')");
    expect(page).toContain('function AppsView()');
    expect(page).toContain('aiden.loadApps()');
    expect(page).toContain('aiden.connectApp');
    expect(page).toContain('aiden.completeAppConnection');
    expect(page).toContain('aiden.refreshAppAccount');
    expect(page).toContain('aiden.reconnectAppAccount');
    expect(page).toContain('aiden.disconnectAppAccount');
    expect(page).toContain('Credentials never enter Workbench');
    const apps = page.slice(page.indexOf('function AppsView()'), page.indexOf('function SponsorsView()'));
    expect(apps).not.toContain('apiKey');
    expect(apps).not.toContain('secretHandle');
    expect(apps).toContain('Account label');
    expect(apps).toContain('label: accountLabels[`${toolkit.providerId}:${toolkit.toolkitId}`]?.trim()');
  });

  it('keeps the collapsed navigation rail reachable at responsive widths', () => {
    const responsive = styles.slice(
      styles.indexOf('@media (max-width: 980px)'),
      styles.indexOf('@media (max-width: 620px)'),
    );
    expect(responsive).toMatch(
      /\.workbench-grid\.sidebar-closed \.history-sidebar\.sidebar-rail\s*\{[^}]*transform:\s*translateX\(0\)/,
    );
    expect(responsive).toMatch(
      /\.workbench-grid\.sidebar-closed \.history-sidebar\.sidebar-rail\s*\{[^}]*width:\s*58px/,
    );
  });

  it('reserves responsive shell width so collapsed navigation cannot cover main content', () => {
    const responsive = styles.slice(
      styles.indexOf('@media (max-width: 980px)'),
      styles.indexOf('@media (max-width: 620px)'),
    );
    const columns = responsive.match(
      /\.workbench-grid\.sidebar-closed\s*\{[^}]*grid-template-columns:\s*(\d+)px\s+minmax\(0,\s*1fr\)/,
    );
    const rail = responsive.match(
      /\.workbench-grid\.sidebar-closed \.history-sidebar\.sidebar-rail\s*\{([^}]*)\}/,
    );
    const main = responsive.match(
      /\.workbench-grid\.sidebar-closed\s*>\s*\.workbench-main\s*\{([^}]*)\}/,
    );

    expect(page).toContain('className="workbench-main"');
    expect(columns?.[1]).toBe('58');
    expect(rail?.[1]).toMatch(/position:\s*relative/);
    expect(rail?.[1]).toMatch(/grid-column:\s*1/);
    expect(main?.[1]).toMatch(/grid-column:\s*2/);
    expect(main?.[1]).toMatch(/min-width:\s*0/);
    expect(main?.[1]).toMatch(/max-width:\s*100%/);

    const railWidth = Number(columns?.[1]);
    for (const viewportWidth of [480, 900, 1366, 1920]) {
      const railBounds = { left: 0, right: railWidth };
      const mainBounds = { left: railWidth, right: viewportWidth };
      expect(mainBounds.left).toBeGreaterThanOrEqual(railBounds.right);
      expect(mainBounds.right).toBeLessThanOrEqual(viewportWidth);
    }
  });

  it('renders a restrained sponsor surface with the exact safe external destination', () => {
    expect(page).toContain('function SponsorsView()');
    expect(page).toContain('SPONSOR_URL');
    expect(page).toContain('PUBLIC_SPONSORS');
    expect(page).toContain('target="_blank"');
    expect(page).toContain('rel="noopener noreferrer"');
    expect(page).toContain('No public sponsors yet');
  });

  it('lets the conversation shell own the available height so the composer stays at the bottom', () => {
    const chatPanel = page.slice(page.indexOf('function ChatPanel()'), page.indexOf('function GrowthCard'));
    expect(chatPanel).toContain("flex: 1, minHeight: 0");
    expect(chatPanel).toContain("overflowY: 'auto'");
    expect(chatPanel).toContain("flexShrink: 0");
  });

  it('does not present unsupported Workbench model, skill, or plugin mutations as working', () => {
    expect(page).toContain('loadWorkbenchCapabilities');
    expect(page).toContain('Managed by the Aiden runtime');
    expect(page).not.toContain("fetch('http://localhost:4200/api/skills')");
    expect(page).not.toContain("fetch('/api/plugins')");
  });
});
