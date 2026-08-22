import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Workbench Agentic Presence source contract', () => {
  const page = readFileSync(path.resolve(__dirname, '../../../dashboard-next/app/page.tsx'), 'utf8');

  it('presents durable attention as Needs you, Review when ready, and Recently resolved', () => {
    expect(page).toContain("['Needs you', presence.needsYou]");
    expect(page).toContain("['Review when ready', presence.reviewWhenReady]");
    expect(page).toContain("['Recently resolved', presence.recentlyResolved]");
    expect(page).toContain('Why shown');
    expect(page).toContain('Snooze 1h');
    expect(page).toContain('Dismiss');
    expect(page).toContain("['Changed', presenceBriefing.groups.changed]");
    expect(page).toContain("['Blocked', presenceBriefing.groups.blocked]");
    expect(page).toContain("['Ready', presenceBriefing.groups.ready]");
    expect(page).toContain("['Next', presenceBriefing.groups.next]");
  });

  it('keeps ProposedJob explicit and never presents proposal creation as execution', () => {
    expect(page).toContain('No Job exists until you accept.');
    expect(page).toContain('loadPresenceProposals');
    expect(page).toContain('Propose task');
    expect(page).toContain('Accept proposed task');
    expect(page.indexOf('proposePresenceJob')).toBeGreaterThan(-1);
    expect(page.indexOf('acceptPresenceProposal')).toBeGreaterThan(page.indexOf('proposePresenceJob'));
  });

  it('uses one durable Presence projection instead of duplicating matching Job cards', () => {
    expect(page).toContain('presenceJobIds');
    expect(page).toContain('!presenceJobIds.has(job.jobId)');
    expect(page).not.toContain('notification center');
  });

  it('keeps legacy market briefing content separate and deterministically deduplicated', () => {
    expect(page).toContain('market_briefing_');
    expect(page).toContain('prev.some((message) => message.id === id) ? prev');
    expect(page).not.toContain('id:             `briefing_${Date.now()}`');
  });
});
