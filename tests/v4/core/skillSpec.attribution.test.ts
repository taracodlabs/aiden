/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.9.5 SLICE 1 — validateAttribution pure-function coverage.
 *
 * No mocks. Drives the validator with synthetic SkillFrontmatter
 * shapes and asserts the `missing` array + `ok` flag. Strict vs
 * permissive asymmetry is the load-bearing contract.
 */
import { describe, it, expect } from 'vitest';
import {
  validateAttribution,
  type SkillFrontmatter,
} from '../../../core/v4/skillSpec';

function fm(over: Partial<SkillFrontmatter> = {}): SkillFrontmatter {
  return {
    name:        'x',
    description: 'y',
    version:     '1.0.0',
    ...over,
  };
}

describe('validateAttribution — strict mode (curated source)', () => {
  it('passes when all three required fields are present + non-empty', () => {
    const r = validateAttribution(fm({
      author:          'Jane Doe',
      license:         'MIT',
      upstream_source: 'https://github.com/jdoe/skill',
    }), 'strict');
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
    expect(r.mode).toBe('strict');
  });

  it('reports author missing', () => {
    const r = validateAttribution(fm({
      license:         'MIT',
      upstream_source: 'https://github.com/jdoe/skill',
    }), 'strict');
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['author']);
  });

  it('reports license missing', () => {
    const r = validateAttribution(fm({
      author:          'Jane Doe',
      upstream_source: 'https://github.com/jdoe/skill',
    }), 'strict');
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['license']);
  });

  it('reports upstream_source missing (strict-only field)', () => {
    const r = validateAttribution(fm({
      author:  'Jane Doe',
      license: 'MIT',
    }), 'strict');
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['upstream_source']);
  });

  it('reports ALL missing fields in one pass (not bail-on-first)', () => {
    const r = validateAttribution(fm(), 'strict');
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['author', 'license', 'upstream_source']);
  });

  it('treats whitespace-only values as missing', () => {
    const r = validateAttribution(fm({
      author:          '   ',
      license:         '\t\n',
      upstream_source: '',
    }), 'strict');
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['author', 'license', 'upstream_source']);
  });
});

describe('validateAttribution — permissive mode (community source)', () => {
  it('passes when author + license are present, EVEN IF upstream_source missing', () => {
    // Community skills don't need upstream_source — they ARE the upstream.
    const r = validateAttribution(fm({
      author:  'Community Person',
      license: 'Apache-2.0',
    }), 'permissive');
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
    expect(r.mode).toBe('permissive');
  });

  it('reports author missing in permissive mode (drives "(uncredited)" marker)', () => {
    const r = validateAttribution(fm({ license: 'MIT' }), 'permissive');
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['author']);
  });

  it('reports license missing in permissive mode', () => {
    const r = validateAttribution(fm({ author: 'someone' }), 'permissive');
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['license']);
  });

  it('does NOT report upstream_source missing in permissive mode', () => {
    // Even if entirely empty, permissive ignores upstream_source.
    const r = validateAttribution(fm({
      author:  'someone',
      license: 'MIT',
      // upstream_source intentionally absent
    }), 'permissive');
    expect(r.ok).toBe(true);
    expect(r.missing).not.toContain('upstream_source');
  });

  it('returns mode field for the caller to dispatch on', () => {
    expect(validateAttribution(fm(), 'permissive').mode).toBe('permissive');
    expect(validateAttribution(fm(), 'strict').mode).toBe('strict');
  });
});

describe('validateAttribution — purity', () => {
  it('identical input ⇒ identical output (called three times)', () => {
    const input = fm({ author: 'X', license: 'MIT' });
    const a = validateAttribution(input, 'strict');
    const b = validateAttribution(input, 'strict');
    const c = validateAttribution(input, 'strict');
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  it('does not mutate the input frontmatter', () => {
    const input = fm({ author: 'X' });
    const snapshot = { ...input };
    validateAttribution(input, 'strict');
    expect(input).toEqual(snapshot);
  });
});
