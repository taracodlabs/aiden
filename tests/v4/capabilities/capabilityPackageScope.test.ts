/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Public capability package scope', () => {
  it('ships contracts and safe samples but never adversarial fixtures or runtime state', () => {
    const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
      private?: boolean;
      files?: string[];
      aiden?: { edition?: string };
    };
    expect(manifest.private).not.toBe(true);
    expect(manifest.aiden?.edition).toBe('pro');
    expect(manifest.files).toEqual(expect.arrayContaining([
      'packages/capability-sdk/',
      'capabilities/samples/',
    ]));
    expect(manifest.files?.join('\n')).not.toMatch(/capabilities\/fixtures|capabilities\/versions|\.staging|daemon\.db|capability_grants/iu);
  });
});
