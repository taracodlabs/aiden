/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../../..');
const page = fs.readFileSync(path.join(root, 'dashboard-next/app/page.tsx'), 'utf8');
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
