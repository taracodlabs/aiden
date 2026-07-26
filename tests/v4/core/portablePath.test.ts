/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { describe, expect, it } from 'vitest';

import { isPortablePathWithin, resolvePortablePath } from '../../../core/v4/portablePath';

describe('portable durable paths', () => {
  it('resolves Windows and POSIX paths independently of the current host', () => {
    expect(resolvePortablePath('C:\\workspace', 'result.txt')).toBe('C:\\workspace\\result.txt');
    expect(resolvePortablePath('/workspace', 'result.txt')).toBe('/workspace/result.txt');
  });

  it('enforces component boundaries using the persisted path dialect', () => {
    expect(isPortablePathWithin('c:\\WORKSPACE\\safe\\nested.txt', 'C:\\workspace\\safe')).toBe(true);
    expect(isPortablePathWithin('C:\\workspace\\safe\\..\\escape.txt', 'C:\\workspace\\safe')).toBe(false);
    expect(isPortablePathWithin('C:\\workspace\\safe-other', 'C:\\workspace\\safe')).toBe(false);
    expect(isPortablePathWithin('/workspace/safe/nested.txt', '/workspace/safe')).toBe(true);
    expect(isPortablePathWithin('/workspace/escape.txt', '/workspace/safe')).toBe(false);
    expect(isPortablePathWithin('/workspace/safe', 'C:\\workspace\\safe')).toBe(false);
  });
});
