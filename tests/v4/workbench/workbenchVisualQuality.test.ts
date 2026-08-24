import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../../..');
const page = readFileSync(path.join(root, 'dashboard-next/app/page.tsx'), 'utf8');
const css = readFileSync(path.join(root, 'dashboard-next/app/globals.css'), 'utf8');

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
}

describe('Workbench rendered premium-quality contracts', () => {
  it('lays out the Home hero in an intentional bounded composition', () => {
    expect(rule('.workbench-home')).toMatch(/max-width:\s*\d+px/);
    expect(rule('.workbench-home')).toMatch(/margin:\s*auto/);
    expect(rule('.workbench-home')).toMatch(/align-content:\s*center|justify-content:\s*center/);
    expect(rule('.workbench-home-copy h1')).toMatch(/font:/);
    expect(rule('.workbench-home-copy p')).toMatch(/line-height:|font:/);
  });

  it('keeps starter-card title, description, state, and action in separate layout regions', () => {
    expect(page).toContain('className="starter-copy"');
    expect(page).toContain('className={suggestion.available ? \'starter-state\' : \'starter-state needs-setup\'}');
    expect(rule('.starter-copy')).toMatch(/display:\s*(grid|flex)/);
    expect(rule('.starter-copy strong')).toMatch(/display:\s*block/);
    expect(rule('.starter-copy small')).toMatch(/display:\s*block/);
    expect(rule('.starter-state')).toMatch(/white-space:\s*nowrap/);
  });

  it('renders the action menu as a bounded vertical popover', () => {
    const menu = rule('.composer-action-menu');
    expect(menu).toMatch(/position:\s*absolute/);
    expect(menu).toMatch(/display:\s*(grid|flex)/);
    expect(menu).toMatch(/max-height:/);
    expect(menu).toMatch(/overflow-y:\s*auto/);
    expect(menu).toMatch(/width:\s*min\(/);
    expect(menu).toMatch(/z-index:/);
  });

  it('separates every action title and description without horizontal overflow', () => {
    expect(rule('.composer-action-item')).toMatch(/display:\s*grid/);
    expect(rule('.composer-action-item')).toMatch(/grid-template-columns:/);
    expect(rule('.composer-action-item > span:nth-child(2)')).toMatch(/display:\s*grid/);
    expect(rule('.composer-action-item strong')).toMatch(/display:\s*block/);
    expect(rule('.composer-action-item small')).toMatch(/display:\s*block/);
    expect(rule('.composer-action-item')).toMatch(/min-width:\s*0/);
  });

  it('supports Escape, arrow navigation, and focus return in the action menu', () => {
    const menu = page.slice(page.indexOf('function PlusMenu()'), page.indexOf('// ── ChatPanel'));
    expect(menu).toContain("event.key === 'Escape'");
    expect(menu).toMatch(/ArrowDown|ArrowUp/);
    expect(menu).toContain('.focus()');
    expect(menu).toContain('role="menu"');
  });

  it('presents the composer as one integrated premium control', () => {
    expect(rule('.composer-row')).toMatch(/border:/);
    expect(rule('.composer-row')).toMatch(/border-radius:/);
    expect(rule('.composer-row')).toMatch(/background:/);
    expect(rule('.composer-row textarea')).toMatch(/border:\s*0/);
    expect(rule('.composer-action-trigger')).toMatch(/flex:/);
    expect(rule('.composer-send')).toMatch(/flex:/);
  });

  it('uses one understandable global state and precise privacy wording', () => {
    expect(page).not.toContain('Private and local');
    expect(page).toContain('Local workspace');
    expect(page).toContain('Cloud model connected');
    expect(page).toContain("runtimeConnection === 'connected' && executionAvailable");
    expect(page).toContain('Model setup required');
    expect(page).not.toContain('>Clear view</button>');
    expect(page).toContain('Reset view');
  });

  it('keeps normal product copy readable instead of shrinking it into telemetry', () => {
    expect(rule('.workbench-home-copy p')).toMatch(/font:\s*[^;]*1[5-6]px|font-size:\s*1[5-6]px/);
    expect(rule('.starter-copy small')).toMatch(/font:\s*[^;]*(1[3-6])px|font-size:\s*(1[3-6])px/);
    expect(rule('.sidebar-nav button')).toMatch(/font:\s*[^;]*(1[3-6])px|font-size:\s*(1[3-6])px/);
  });

  it('gives Light theme distinct canvas, card, border, and shadow hierarchy', () => {
    const light = rule(":root[data-appearance='light']");
    expect(light).toContain('--bg:');
    expect(light).toContain('--bg1:');
    expect(light).toContain('--bg2:');
    expect(light).toContain('--border2:');
    expect(light).toContain('--shadow:');
    expect(light).toContain('--shadow-sm:');
    expect(rule(":root[data-appearance='light'] .starter-workflows button")).toMatch(/box-shadow:/);
  });

  it('keeps the popover and Home cards inside the phone viewport', () => {
    const phone = css.slice(css.indexOf('@media (max-width: 620px)'));
    expect(phone).toMatch(/\.composer-action-menu\s*\{[^}]*left:\s*0/);
    expect(phone).toMatch(/\.composer-action-menu\s*\{[^}]*right:\s*0/);
    expect(phone).toMatch(/\.starter-workflows\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    expect(phone).toMatch(/\.workbench-home\s*\{[^}]*padding:/);
  });

  it('keeps keyboard focus visible and respects reduced motion', () => {
    expect(css).toMatch(/:focus-visible\s*\{/);
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('never permits horizontal Workbench page overflow', () => {
    expect(rule('html, body')).toMatch(/overflow-x:\s*hidden/);
    expect(rule('.workbench-grid')).toMatch(/min-width:\s*0/);
    expect(rule('.workbench-main')).toMatch(/min-width:\s*0/);
  });
});
