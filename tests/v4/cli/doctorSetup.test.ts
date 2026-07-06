/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.14.x — the doctor "Setup" group: current runtime state (active model,
 * enabled tools, permission mode, memory files, daemon) rendered through the
 * existing grouped health box. Proves the pure formatter's rows/labels, the
 * live-vs-saved resolution, and that the group folds into renderHealthBox.
 */
import { describe, it, expect } from 'vitest';
import {
  setupResults,
  resolveSetupInputs,
  renderHealthBox,
  type SetupInputs,
  type DoctorReport,
} from '../../../cli/v4/doctor';
import { resolveAidenPaths } from '../../../core/v4/paths';

const paths = resolveAidenPaths();

const base: SetupInputs = {
  paths,
  model: { provider: 'anthropic', model: 'claude-opus-4-8', source: 'saved' },
  enabledToolNames: ['file_read', 'web_search', 'execute_code'],
  mode: { level: 'Assistant', source: 'saved' },
  daemonRunning: false,
};

describe('doctor Setup group — pure formatter (setupResults)', () => {
  it('emits the Setup group with a row per item (model, tools, mode, MEMORY.md, USER.md, daemon)', () => {
    const rows = setupResults(base);
    expect(rows.every((r) => r.group === 'Setup')).toBe(true);
    expect(rows.map((r) => r.name)).toEqual([
      'active model', 'tools enabled', 'mode', 'MEMORY.md', 'USER.md', 'daemon',
    ]);
    // Informational — every row passes, so the group never moves the exit code.
    expect(rows.every((r) => r.passed)).toBe(true);
  });

  it('the memory rows print the FULL MEMORY.md and USER.md paths', () => {
    const rows = setupResults(base);
    expect(rows.find((r) => r.name === 'MEMORY.md')?.message).toBe(paths.memoryMd);
    expect(rows.find((r) => r.name === 'USER.md')?.message).toBe(paths.userMd);
  });

  it('active model + mode carry the source label; mode shows the friendly short form', () => {
    const live = setupResults({
      ...base,
      model: { provider: 'openai', model: 'gpt-x', source: 'live' },
      mode: { level: 'Partner', source: 'live' },
    });
    expect(live.find((r) => r.name === 'active model')?.message).toBe('openai / gpt-x  (live)');
    expect(live.find((r) => r.name === 'mode')?.message).toBe('Partner (auto)  (live)');
    expect(setupResults(base).find((r) => r.name === 'mode')?.message).toBe('Assistant (safe)  (saved)');
  });
});

// ── Phase 6 — the provider decision row (where the active model came from) ────
describe('doctor Setup — Phase 6 provider decision row', () => {
  it('no decision origin → no "model source" row (shape unchanged)', () => {
    expect(setupResults(base).some((r) => r.name === 'model source')).toBe(false);
  });

  it('a non-fallback decision shows where the pick came from', async () => {
    const setup = await resolveSetupInputs({
      paths,
      providerDecision: {
        provider: 'ollama', model: 'llama3.2', source: 'cli-flag',
        requestedExplicit: true, attempts: [{ providerId: 'ollama', ok: true }],
      },
    });
    const row = setupResults(setup).find((r) => r.name === 'model source');
    expect(row?.message).toContain('from --provider/--model');
  });

  it('a fallback decision surfaces the durable reason + fix command (queryable from doctor)', async () => {
    const setup = await resolveSetupInputs({
      paths,
      providerDecision: {
        provider: 'groq', model: 'llama-3.3-70b-versatile', source: 'persisted-config',
        requestedProvider: 'claude-pro', requestedExplicit: false,
        fallbackReason: 'OAuth token for claude-pro is expired. Run `/auth refresh claude-pro`.',
        attempts: [
          { providerId: 'claude-pro', ok: false, reason: 'expired' },
          { providerId: 'groq', ok: true },
        ],
      },
    });
    const row = setupResults(setup).find((r) => r.name === 'model source');
    expect(row?.message).toContain('claude-pro unavailable');
    expect(row?.message).toContain('/auth refresh claude-pro');   // fix command reaches doctor
    expect(row?.message).toContain('fell back to groq');
  });

  it('an EXPLICIT --provider failure is labelled explicit, never a "default"', async () => {
    const setup = await resolveSetupInputs({
      paths,
      providerDecision: {
        provider: 'chatgpt-plus', model: 'gpt-5.5', source: 'cli-flag',
        requestedProvider: 'ollama', requestedExplicit: true,
        fallbackReason: "Model 'gemma4:e4b' not found for provider 'ollama'.",
        attempts: [],
      },
    });
    const row = setupResults(setup).find((r) => r.name === 'model source');
    expect(row?.message).toContain('you asked for ollama');
    expect(row?.message).not.toContain('previous default');
  });

  it('tools row shows the count and caps the preview at six', () => {
    const many = setupResults({ ...base, enabledToolNames: Array.from({ length: 10 }, (_, i) => `t${i}`) });
    const msg = many.find((r) => r.name === 'tools enabled')!.message;
    expect(msg).toContain('10 enabled');
    expect(msg).toContain('+6 more');           // 10 total − 4 shown
    expect(setupResults({ ...base, enabledToolNames: [] }).find((r) => r.name === 'tools enabled')?.message)
      .toBe('none enabled');
  });
});

describe('doctor Setup group — live-vs-saved resolution (resolveSetupInputs)', () => {
  // A ConfigManager-shaped stub (getValue) so no disk read happens.
  const savedCfg = {
    getValue<T = unknown>(key: string, fallback?: T): T {
      const m: Record<string, unknown> = {
        'model.provider': 'groq',
        'model.modelId': 'llama-3.3-70b',
        'agent.autonomy': 'Observer',
      };
      return (key in m ? m[key] : fallback) as T;
    },
  };
  const toolReg = { getSchemas: () => [{ name: 'alpha' }, { name: 'beta' }] };

  it('SAVED — no live session/engine → config values, labelled saved', async () => {
    const inp = await resolveSetupInputs({
      paths, config: savedCfg, toolRegistry: toolReg, daemonRunning: false,
    });
    expect(inp.model).toEqual({ provider: 'groq', model: 'llama-3.3-70b', source: 'saved' });
    expect(inp.mode).toEqual({ level: 'Observer', source: 'saved' });
    expect(inp.enabledToolNames).toEqual(['alpha', 'beta']);
    expect(inp.daemonRunning).toBe(false);
  });

  it('LIVE — a session + approval engine present → their values, labelled live (override saved)', async () => {
    const inp = await resolveSetupInputs({
      paths, config: savedCfg, toolRegistry: toolReg, daemonRunning: true,
      session: { getCurrentProvider: () => 'openai', getCurrentModel: () => 'gpt-x' },
      approvalEngine: { getAutonomyPolicy: () => ({ level: 'Partner' }) },
    });
    expect(inp.model).toEqual({ provider: 'openai', model: 'gpt-x', source: 'live' });
    expect(inp.mode).toEqual({ level: 'Partner', source: 'live' });
    expect(inp.daemonRunning).toBe(true);
  });

  it('daemon check opens NOTHING — registers no signal handlers (light lock read, not the daemon barrel)', async () => {
    // Regression: the daemon-liveness check must not import `core/v4/daemon`
    // (the barrel), which pulls proper-lockfile → signal-exit registers ref'd
    // SIGNALWRAP handles that pin the event loop and force a teardown-racing
    // process.exit() (the Windows UV_HANDLE_CLOSING crash). The light lock-file
    // read registers zero signal listeners. Run with NO daemonRunning seam so
    // the real check executes, and stubs elsewhere so nothing else loads.
    const sig = () =>
      process.listenerCount('SIGINT') + process.listenerCount('SIGTERM') + process.listenerCount('SIGHUP');
    const before = sig();
    const inp = await resolveSetupInputs({ paths, config: savedCfg, toolRegistry: toolReg });
    expect(typeof inp.daemonRunning).toBe('boolean');   // the read still works
    expect(sig()).toBe(before);                         // …and pulled no signal handlers
  });

  it('a session missing a value falls back to saved (no half-live row)', async () => {
    const inp = await resolveSetupInputs({
      paths, config: savedCfg, toolRegistry: toolReg, daemonRunning: false,
      session: { getCurrentProvider: () => '', getCurrentModel: () => '' },  // empty → not live
    });
    expect(inp.model.source).toBe('saved');
    expect(inp.model.provider).toBe('groq');
  });
});

describe('doctor Setup group — folds into the health box', () => {
  it('renderHealthBox shows the Setup header + rows (incl. the full memory paths)', () => {
    const report: DoctorReport = { results: setupResults(base), passed: true, totalMs: 3 };
    const display = { brand: (s: string) => s, muted: (s: string) => s, paint: (s: string) => s } as never;
    const out = renderHealthBox(report, display);
    expect(out).toContain('Setup');
    expect(out).toContain('active model');
    expect(out).toContain('anthropic / claude-opus-4-8');
    expect(out).toContain(paths.memoryMd);   // full path, uncut (fits the box)
    expect(out).toContain('stopped');
  });
});
