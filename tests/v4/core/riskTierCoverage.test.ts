/**
 * v4.4 Phase 1 — Risk-tier annotation coverage tests.
 *
 * Asserts that:
 *   1. Every registered ToolHandler has an explicit `riskTier` OR
 *      can be inferred via `inferDefaultRiskTier(mutates)`.
 *   2. Tier distribution is within expected ranges (catches drift).
 *   3. The 7 known-dangerous tools are annotated `dangerous` —
 *      regression sentinel against accidental demotion.
 *   4. The high-trust read-only tools are annotated `safe`.
 */
import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../../../core/v4/toolRegistry';
import { registerAllTools } from '../../../tools/v4';
import {
  inferDefaultRiskTier,
  type RiskTier,
} from '../../../core/v4/sandboxConfig';

function buildRegistry(): ToolRegistry {
  const reg = new ToolRegistry();
  registerAllTools(reg);
  return reg;
}

function effectiveTier(name: string, reg: ToolRegistry): RiskTier {
  const handler = reg.get(name);
  if (!handler) throw new Error(`unknown tool: ${name}`);
  return handler.riskTier ?? inferDefaultRiskTier(handler.mutates);
}

const DANGEROUS_TOOLS = [
  'shell_exec',
  'file_delete',
  'process_kill',
  'process_spawn',
  'aiden_self_update',
  'browser_upload',
  'external_coding',
];

describe('Risk-tier annotation coverage', () => {
  const reg = buildRegistry();
  const names = reg.list();

  it('registers at least 50 tools (sanity check)', () => {
    expect(names.length).toBeGreaterThanOrEqual(50);
  });

  it('every tool has a resolvable risk tier (explicit or inferred)', () => {
    for (const name of names) {
      const tier = effectiveTier(name, reg);
      expect(['safe', 'caution', 'dangerous']).toContain(tier);
    }
  });

  it('every registered tool has an EXPLICIT riskTier annotation (v4.4 Phase 1)', () => {
    const missing: string[] = [];
    for (const name of names) {
      const h = reg.get(name);
      if (!h?.riskTier) missing.push(name);
    }
    expect(missing).toEqual([]);
  });
});

describe('Dangerous-tier sentinel (regression guard)', () => {
  const reg = buildRegistry();

  for (const name of DANGEROUS_TOOLS) {
    it(`${name} MUST be annotated 'dangerous'`, () => {
      const h = reg.get(name);
      expect(h, `tool ${name} not registered`).toBeDefined();
      expect(h!.riskTier).toBe('dangerous');
    });
  }
});

describe('Safe-tier sentinel (high-trust read-only)', () => {
  const reg = buildRegistry();
  const SAFE_TOOLS = [
    'file_read', 'file_list',
    'web_search', 'system_info',
    'session_list', 'session_search',
    'skill_view', 'skills_list',
    'browser_extract', 'browser_get_url', 'browser_screenshot',
    'screenshot', 'clipboard_read',
  ];

  for (const name of SAFE_TOOLS) {
    it(`${name} MUST be annotated 'safe'`, () => {
      const h = reg.get(name);
      expect(h, `tool ${name} not registered`).toBeDefined();
      expect(h!.riskTier).toBe('safe');
    });
  }
});

describe('Tier distribution', () => {
  const reg = buildRegistry();
  const counts = { safe: 0, caution: 0, dangerous: 0 };
  for (const name of reg.list()) {
    counts[effectiveTier(name, reg)] += 1;
  }

  it('dangerous tier matches the canonical set', () => {
    const dangerous = reg.list()
      .filter((name) => effectiveTier(name, reg) === 'dangerous')
      .sort();
    expect(dangerous).toEqual([...DANGEROUS_TOOLS].sort());
  });

  it('safe tier has at least 15 tools (read-only majority)', () => {
    expect(counts.safe).toBeGreaterThanOrEqual(15);
  });

  it('caution tier has at least 15 tools (filesystem/state writers)', () => {
    expect(counts.caution).toBeGreaterThanOrEqual(15);
  });

  it('sum across tiers equals registered tool count', () => {
    const total = counts.safe + counts.caution + counts.dangerous;
    expect(total).toBe(reg.list().length);
  });
});
