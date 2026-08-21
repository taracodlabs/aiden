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
    expect(page).toContain('External Coding Agent');
    expect(page).toContain('Requested scope');
    expect(page).toContain('Commit / Push / Tag / Merge disabled');
    expect(page).toContain('Isolated until you review and apply them');
    expect(page).toContain('Provider-reported changes differed from the observed repository state.');
    expect(page).toContain('Aiden used the observed diff and independent validation.');
    expect(page).toContain('Inspect retained attempt');
    expect(page).toContain('Discard isolated attempt');
    expect(page).toContain('aiden.discardUnknownCodingSession(codingSession.codingSessionId)');
    expect(page).toContain('Previous isolated coding attempt was reconciled and closed. A new attempt may start.');
    expect(page).toContain('setDecisionError(error instanceof Error ? error.message');
    expect(page).toContain('role="alert"');
  });

  it('restores durable approval activity even when browser-local messages are empty', () => {
    const chatPanel = page.slice(page.indexOf('function ChatPanel()'), page.indexOf('function GrowthCard'));
    const emptyBranch = chatPanel.slice(
      chatPanel.indexOf('messages.length === 0'),
      chatPanel.indexOf('messages.map('),
    );
    expect(emptyBranch).toContain('hasSelectedWork');
    expect(emptyBranch).toContain('<LiveActivitySurface />');
  });

  it('never renders approval controls from a terminal durable projection', () => {
    const activity = page.slice(page.indexOf('function LiveActivitySurface()'), page.indexOf('function ChatPanel()'));
    expect(activity).toContain('runProjection?.receipt.terminal ? []');
  });

  it('lets an operator discard a drift-blocked coding candidate without offering an unsafe apply', () => {
    const activity = page.slice(page.indexOf('function LiveActivitySurface()'), page.indexOf('function ChatPanel()'));
    const driftBlock = activity.slice(
      activity.indexOf("codingSession.promotion?.state === 'blocked_drift'"),
      activity.indexOf("codingSession.promotion?.state === 'blocked_drift'") + 700,
    );
    expect(driftBlock).toContain("decideCoding('discard')");
    expect(driftBlock).toContain('Discard');
    expect(driftBlock).not.toContain("decideCoding('apply')");
  });

  it('gives artifact opening immediate, accessible feedback on every Workbench surface', () => {
    const card = page.slice(page.indexOf('function ArtifactCard('), page.indexOf('function ArtifactsView()'));
    expect(card).toContain('const [opening, setOpening] = useState(false)');
    expect(card).toContain('aria-expanded={preview !== null}');
    expect(card).toContain('aria-busy={opening}');
    expect(card).toContain("opening ? 'Opening…' : preview ? 'Close' : 'Open'");
    expect(card).toContain('setOpening(false)');
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
    expect(page).toContain("openView('artifacts')");
    const navigation = page.slice(page.indexOf('function HistorySidebar()'), page.indexOf('// ── EmptyState'));
    for (const label of ['New Chat', 'Home', 'Active Work', 'Apps', 'Artifacts', 'Settings']) {
      expect(navigation).toContain(label);
    }
    for (const hiddenLabel of ['>Skills<', '>Plugins<', '>Sponsors<', '>Activity<']) {
      expect(navigation).not.toContain(hiddenLabel);
    }
    expect(page).toContain("section: 'Advanced'");
    expect(page).toContain('settings-section-label');
  });

  it('uses an outcome-first home and editorial conversation surface', () => {
    expect(page).toContain('What should Aiden take care of?');
    expect(page).toContain('Private computer work, with proof.');
    expect(page).toContain('className="starter-workflows"');
    for (const workflow of ['Work on a codebase', 'Research and deliver', 'Use my browser', 'Work with my Apps']) {
      expect(page).toContain(workflow);
    }
    expect(page).toContain('className="conversation-column"');
    expect(page).toContain('className="workbench-composer"');
    expect(page).toContain("hasSelectedWork ? 'Add an instruction…' : 'What should Aiden take care of?'");
    expect(styles).toContain('max-width: 720px');
    expect(styles).toContain('.message-bubble.is-assistant');
  });

  it('centralizes semantic status, attention, progress, and approval presentation', () => {
    expect(page).toContain('presentRuntimeStatus');
    expect(page).toContain('groupActiveWork');
    expect(page).toContain('projectAttentionItems');
    expect(page).toContain('projectSemanticProgress');
    expect(page).toContain('presentApproval');
    expect(page).toContain('presentResult');
    expect(page).toContain('className={`result-card tone-${result.tone}`}');
    expect(page).toContain('className="work-details activity-details"');
    expect(page).toContain('<summary>Detailed activity</summary>');
    for (const label of ['Needs you', 'Running', 'Ready for review', 'Recently completed']) {
      expect(page).toContain(label);
    }
    for (const label of ['What', 'Where', 'Why', 'Impact', 'Risk', 'After approval']) {
      expect(page).toContain(`<dt>${label}</dt>`);
    }
    const navigation = page.slice(page.indexOf('function NavBar()'), page.indexOf('// ── HistorySidebar'));
    expect(navigation).toContain('attentionCount > 0 ? (');
    expect(navigation).toContain("setMainView('activity')");
    expect(navigation).toContain('aria-label="Open work that needs attention"');
  });

  it('makes the global Artifacts destination browsable by recent work, Job, and type', () => {
    const artifacts = page.slice(page.indexOf('function ArtifactsView()'), page.indexOf('function AppsView()'));
    expect(artifacts).toContain('aiden.listArtifacts()');
    expect(artifacts).toContain("useState<'recent' | 'job' | 'type'>('recent')");
    expect(artifacts).toContain('Recent');
    expect(artifacts).toContain('By Job');
    expect(artifacts).toContain('Type');
    expect(artifacts).not.toContain('Current work');
  });

  it('projects external coding health without moving credentials into browser state', () => {
    const settings = page.slice(page.indexOf('function SettingsDrawer()'), page.indexOf('// ── Main component'));
    expect(settings).toContain('aiden.loadExternalCodingHealth()');
    expect(settings).toContain('External Coding');
    expect(settings).toContain('Authentication:');
    expect(settings).toContain('Isolation:');
    expect(settings).toContain('Network: Disabled by default');
    expect(settings).toContain('aiden.configureExternalCoding(model)');
    expect(settings).toContain('Validate and save model');
    expect(settings).not.toContain('AIDEN_CODING_OPENAI_API_KEY');
    expect(settings).not.toContain('auth.json');
  });

  it('provides one functional Apps surface with backend-owned provider credentials', () => {
    expect(page).toContain("setMainView('apps')");
    expect(page).toContain('function AppsView()');
    expect(page).toContain('aiden.loadApps()');
    expect(page).toContain('aiden.connectApp');
    expect(page).toContain('aiden.completeAppConnection');
    expect(page).toContain('aiden.refreshAppAccount');
    expect(page).toContain('aiden.reconnectAppAccount');
    expect(page).toContain('aiden.disconnectAppAccount');
    expect(page).toContain('aiden.configureAppsProvider');
    const apps = page.slice(page.indexOf('function AppsView()'), page.indexOf('function SponsorsView()'));
    expect(apps).not.toContain('apiKey');
    expect(apps).not.toContain('secretHandle');
    expect(apps).toContain('new FormData(form)');
    expect(apps).toContain('type="password"');
    expect(apps).toContain('never retained by the browser');
    expect(apps).not.toContain('Account label');
    expect(apps).not.toContain('accountLabels');
    expect(apps).toContain('projectRecommendedApps(snapshot)');
    expect(apps).toContain('Connect GitHub');
    expect(apps).toContain('Connect Gmail');
    expect(apps).toContain('More apps');
    expect(apps).toContain('Provider status');
    expect(apps).toContain('Add another account');
  });

  it('uses backend provider and readiness authority instead of a frontend model catalog', () => {
    const models = page.slice(page.indexOf('function ReadinessSettings'), page.indexOf('function SettingsDrawer()'));
    expect(models).toContain('aiden.loadSystemReadiness(sessionId)');
    expect(models).toContain('aiden.loadProviderSetup(sessionId)');
    expect(models).toContain('aiden.connectProvider');
    expect(models).toContain('aiden.setSessionModel');
    expect(models).toContain('aiden.setDefaultModel');
    expect(models).toContain('Current chat:');
    expect(models).toContain('Future default:');
    expect(models).toContain('A running Job keeps the provider and model captured when it was admitted.');
    expect(models).not.toContain('PROVIDER_INFO');
    expect(models).not.toContain('localStorage');
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

  it('removes the permanent rail on phone-sized Workbench layouts', () => {
    const narrow = styles.slice(styles.indexOf('@media (max-width: 620px)'));
    expect(narrow).toMatch(/\.history-sidebar\s*\{[^}]*display:\s*none/);
    expect(narrow).toMatch(/\.workbench-grid[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    expect(narrow).toMatch(/\.workbench-main[^}]*grid-column:\s*1/);
    expect(narrow).toMatch(/\.workbench-grid\.sidebar-open \.history-sidebar\s*\{[^}]*display:\s*flex/);
    expect(page).toContain("window.matchMedia('(max-width: 620px)')");
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
