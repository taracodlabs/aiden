/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const PRESENTATION_ADAPTERS = [
  'cli/v4/startupDashboard.ts',
  'cli/v4/startupNotices.ts',
  'cli/v4/commands/theme.ts',
  'cli/v4/commands/skin.ts',
  'cli/v4/commands/clear.ts',
  'cli/v4/commands/newSession.ts',
  'cli/v4/commands/cls.ts',
] as const;

describe('interactive writer ownership', () => {
  it.each(PRESENTATION_ADAPTERS)('%s routes user-visible output through Display', (file) => {
    const source = readFileSync(path.resolve(__dirname, '../../..', file), 'utf8');
    expect(source).not.toMatch(/process\.(?:stdout|stderr)\.write\s*\(/u);
    expect(source).not.toMatch(/console\.(?:log|warn|error)\s*\(/u);
  });

  it('routes onboarding startup output through the session display owner', () => {
    const source = readFileSync(path.resolve(__dirname, '../../..', 'cli/v4/chatSession.ts'), 'utf8');
    const start = source.indexOf('async renderStartupCard()');
    const end = source.indexOf('private async maybeShowBootUpdatePrompt()', start);
    const startup = source.slice(start, end);
    expect(startup).not.toMatch(/out:\s*process\.stdout/u);
  });
});
