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
const onboarding = fs.readFileSync(path.join(root, 'dashboard-next/components/OnboardingModal.tsx'), 'utf8');
const product = fs.readFileSync(path.join(root, 'dashboard-next/lib/workbenchProduct.ts'), 'utf8');

describe('Workbench product-polish source contracts', () => {
  it('uses one reusable button and status component system', () => {
    const ui = fs.readFileSync(path.join(root, 'dashboard-next/components/ProductUI.tsx'), 'utf8');
    for (const variant of ['primary', 'secondary', 'ghost', 'danger', 'icon']) {
      expect(ui).toContain(`'${variant}'`);
    }
    expect(ui).toContain('aria-busy');
    expect(ui).toContain('StatusBadge');
    expect(styles).toContain('.aiden-button');
    expect(styles).toContain('.aiden-field');
    expect(styles).toContain('.aiden-status');
  });

  it('keeps Settings header and navigation stable while only content scrolls', () => {
    expect(page).toContain('className="settings-header"');
    expect(page).toContain('className="settings-body"');
    expect(page).toContain('className="settings-navigation"');
    expect(page).toContain('className="settings-content"');
    expect(styles).toMatch(/\.settings-content\s*\{[^}]*overflow-y:\s*auto/);
    expect(styles).toMatch(/\.settings-content\s*\{[^}]*padding-bottom:/);
  });

  it('renders chat Markdown without raw HTML injection', () => {
    const markdown = fs.readFileSync(path.join(root, 'dashboard-next/components/SafeMarkdown.tsx'), 'utf8');
    expect(page).toContain('<SafeMarkdown content={presentedContent} />');
    expect(page).not.toContain('dangerouslySetInnerHTML');
    expect(markdown).not.toContain('dangerouslySetInnerHTML');
    for (const element of ['h1', 'h2', 'h3', 'blockquote', 'table', 'pre', 'ol', 'ul']) {
      expect(markdown).toContain(`<${element}`);
    }
  });

  it('keeps onboarding readable and keyboard-oriented rather than monospace body copy', () => {
    expect(onboarding).toContain('className="onboarding-dialog"');
    expect(onboarding).toContain('className="onboarding-actions"');
    expect(onboarding).toContain('event.key === \'Escape\'');
    expect(onboarding).not.toContain('JetBrains Mono');
  });

  it('keeps the narrow header usable without horizontal overflow', () => {
    expect(page).toContain('className="workbench-topbar"');
    expect(page).toContain('className="workbench-topbar-actions"');
    const narrow = styles.slice(styles.indexOf('@media (max-width: 620px)'));
    expect(narrow).toContain('.topbar-clear-view');
    expect(narrow).toContain('.topbar-export');
    expect(narrow).toMatch(/\.workbench-topbar\s*\{[^}]*padding:/);
  });

  it('keeps dense Skill inventory searchable, bounded, and source-truthful', () => {
    const skills = page.slice(page.indexOf('function SkillsManager()'), page.indexOf('// ── MCPView'));
    expect(skills).toContain('placeholder="Search Skills"');
    expect(skills).toContain('(capabilities?.skills ?? []).map(projectWorkbenchSkill)');
    expect(product).toContain('projectWorkbenchSkill');
    expect(product).toContain("status: 'Needs review'");
    expect(skills).toContain('visible.slice(0, visibleLimit)');
    expect(skills).toContain('Show more');
    expect(skills).not.toContain('(uncredited)');
  });

  it('keeps automation and protocol identities behind Advanced disclosure', () => {
    const automations = page.slice(page.indexOf('function AutomationsView()'), page.indexOf('function SponsorsView()'));
    const protocols = page.slice(page.indexOf('function MCPView()'), page.indexOf('// ── ChannelModal'));
    expect(automations).toContain('<summary>Advanced details</summary>');
    expect(automations).toContain('Occurrence ID');
    expect(protocols).toContain('<summary>Advanced details</summary>');
    expect(protocols).toContain('Mutation delegation is disabled.');
    expect(protocols).toContain('Read-only delegation');
  });

  it('keeps only useful runtime state in the persistent footer', () => {
    const footer = page.slice(page.indexOf('function StatusBar()'), page.indexOf('// ── MemoryView'));
    expect(footer).toContain('Private and local');
    expect(footer).not.toContain('runtimeVersion');
    expect(footer).not.toContain('taracod.com');
  });

  it('retains exact session identity and goal when a terminal projection becomes an Active Work row', () => {
    const selection = page.slice(page.indexOf('const selectActiveJob = useCallback'), page.indexOf('const saveToConversation = useCallback'));
    expect(page).toContain('projectTerminalActiveJob(projection)');
    expect(page).not.toContain("sessionId: null,\n      jobId: projection.identity.jobId");
    expect(selection).toContain('conversationForExactRun(');
    expect(selection).toContain('conversationsRef.current');
    expect(page).toContain('resolution.projection.identity.sessionId');
  });

  it('does not count blocked or uncertain review items as active execution in the footer', () => {
    const footer = page.slice(page.indexOf('function StatusBar()'), page.indexOf('// ── MemoryView'));
    expect(footer).toContain('foregroundExecutionCount(activeJobs)');
    expect(footer).not.toContain('activeJobs.length > 0');
  });
});
