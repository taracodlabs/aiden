import { describe, expect, it } from 'vitest';

import { skillSourceLabel } from '../../../dashboard-next/lib/skillPresentation';

describe('Workbench Skill presentation', () => {
  it('renders missing legacy source metadata without crashing', () => {
    expect(skillSourceLabel(undefined)).toBe('Installed');
    expect(skillSourceLabel(null)).toBe('Installed');
  });

  it('uses truthful product labels for known and future source kinds', () => {
    expect(skillSourceLabel('built-in')).toBe('Bundled with Aiden');
    expect(skillSourceLabel('learned')).toBe('Learned from verified work');
    expect(skillSourceLabel('runtime')).toBe('Runtime-discovered');
    expect(skillSourceLabel('team_catalog')).toBe('Source: team catalog');
  });
});
