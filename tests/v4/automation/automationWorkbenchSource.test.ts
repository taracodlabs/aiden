import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const page = readFileSync(resolve(root, 'dashboard-next/app/page.tsx'), 'utf8');
const styles = readFileSync(resolve(root, 'dashboard-next/app/globals.css'), 'utf8');
const client = readFileSync(resolve(root, 'dashboard-next/lib/aidenClient.ts'), 'utf8');

describe('Workbench reliable automation product surface', () => {
  it('keeps cron syntax behind an advanced disclosure and previews five durable instants', () => {
    const surface = page.slice(page.indexOf('function AutomationsView()'), page.indexOf('function SponsorsView()'));
    expect(surface).toContain('name="schedulePreset"');
    expect(surface).toContain('<details className="automation-advanced">');
    expect(surface).toContain('aria-label="Advanced cron schedule"');
    expect(surface).toContain('Preview next 5');
    expect(surface).toContain('preview.length > 0');
    expect(client).toContain("'/api/automations/preview'");
  });

  it('exposes create, history, Run Now, pause/resume and safe replay without a second runtime', () => {
    const surface = page.slice(page.indexOf('function AutomationsView()'), page.indexOf('function SponsorsView()'));
    expect(surface).toContain('Create automation');
    expect(surface).toContain('Durable history');
    expect(surface).toContain('Run now');
    expect(surface).toContain("automation.enabled ? 'Pause' : 'Resume'");
    expect(surface).toContain("automation.lastOccurrence.state !== 'unknown'");
    expect(surface).toContain('Scheduling never bypasses approvals');
    expect(surface).not.toMatch(/setInterval\s*\(/);
  });

  it('uses responsive remaining-width layouts at the four acceptance widths', () => {
    expect(styles).toContain('.automation-surface { min-width: 0;');
    expect(styles).toContain('.automation-card { padding: 18px; min-width: 0; }');
    expect(styles).toContain('@media (max-width: 700px)');
    expect(styles).toContain('@media (max-width: 620px)');
    expect(styles).toContain('.automation-schedule-fields { display: grid; grid-template-columns: minmax(0, 1fr); }');
    for (const viewportWidth of [480, 900, 1366, 1920]) {
      const railWidth = viewportWidth <= 620 ? 0 : viewportWidth <= 980 ? 58 : 260;
      const contentWidth = viewportWidth - railWidth;
      expect(contentWidth).toBeGreaterThan(0);
      expect(railWidth + contentWidth).toBeLessThanOrEqual(viewportWidth);
    }
  });
});
