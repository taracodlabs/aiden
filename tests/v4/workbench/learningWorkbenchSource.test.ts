import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Workbench Learning privacy surface source contract', () => {
  const page = readFileSync(path.resolve(__dirname, '../../../dashboard-next/app/page.tsx'), 'utf8');
  const client = readFileSync(path.resolve(__dirname, '../../../dashboard-next/lib/aidenClient.ts'), 'utf8');

  it('locates What Aiden has learned under Privacy rather than primary navigation', () => {
    expect(page).toContain('What Aiden has learned');
    expect(page).toContain('<LearningSettingsTab />');
    expect(page).not.toContain("type MainView = 'learning'");
  });

  it('shows bounded review groups and evidence-linked history controls', () => {
    for (const label of ['Trusted', 'Needs review', 'Conflicts', 'Archived']) {
      expect(page).toContain(label);
    }
    for (const action of ['Review', 'Stop using automatically', 'Archive', 'Delete learned content', 'Export JSON', 'Roll back']) {
      expect(page).toContain(action);
    }
    expect(page).toContain('Editing preserves history.');
    expect(page).toContain('Why Aiden remembers this');
  });

  it('uses typed bridge calls and never queries Learning tables from the browser', () => {
    expect(client).toContain('loadLearning');
    expect(client).toContain('loadLearningReview');
    expect(client).toContain('rememberLearning');
    expect(client).toContain('deleteLearning');
    expect(page).not.toMatch(/learning_(?:entries|events|sources|fts)/);
  });
});
