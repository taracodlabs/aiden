import { describe, it, expect, vi } from 'vitest';
import {
  ApprovalEngine,
  argSignature,
  type ApprovalRequest,
  type ApprovalDecision,
} from '../../../moat/approvalEngine';

const writeReq = (over: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  toolName: 'shell_exec',
  category: 'execute',
  args: { command: 'echo hi' },
  ...over,
});

describe('ApprovalEngine — manual mode', () => {
  it('1. read tool is auto-allowed without prompting', async () => {
    const promptUser = vi.fn();
    const engine = new ApprovalEngine('manual', { promptUser });
    const ok = await engine.checkApproval({
      toolName: 'file_read',
      category: 'read',
      args: {},
    });
    expect(ok).toBe(true);
    expect(promptUser).not.toHaveBeenCalled();
  });

  it('2. write tool prompts the user', async () => {
    const promptUser = vi.fn().mockResolvedValue('allow' as ApprovalDecision);
    const engine = new ApprovalEngine('manual', { promptUser });
    const ok = await engine.checkApproval(writeReq());
    expect(ok).toBe(true);
    expect(promptUser).toHaveBeenCalledOnce();
  });

  it('3. user denies → returns false', async () => {
    const engine = new ApprovalEngine('manual', {
      promptUser: async () => 'deny',
    });
    expect(await engine.checkApproval(writeReq())).toBe(false);
  });

  it('4. allow_session adds to session allowlist; subsequent calls auto-allow', async () => {
    const promptUser = vi
      .fn()
      .mockResolvedValueOnce('allow_session' as ApprovalDecision);
    const engine = new ApprovalEngine('manual', { promptUser });
    const r1 = await engine.checkApproval(writeReq());
    const r2 = await engine.checkApproval(writeReq());
    expect(r1).toBe(true);
    expect(r2).toBe(true);
    expect(promptUser).toHaveBeenCalledOnce();
  });

  it('5. allow_always persists via callback', async () => {
    const persistAllow = vi.fn();
    const engine = new ApprovalEngine('manual', {
      promptUser: async () => 'allow_always',
      persistAllow,
    });
    await engine.checkApproval(writeReq());
    expect(persistAllow).toHaveBeenCalledOnce();
  });

  it('6. resetSession clears session entries but keeps permanent ones', async () => {
    const promptUser = vi
      .fn()
      .mockResolvedValueOnce('allow_session' as ApprovalDecision)
      .mockResolvedValueOnce('allow_always' as ApprovalDecision)
      .mockResolvedValueOnce('deny' as ApprovalDecision);
    const engine = new ApprovalEngine('manual', { promptUser });
    await engine.checkApproval(writeReq({ args: { command: 'a' } }));
    await engine.checkApproval(writeReq({ args: { command: 'b' } }));
    engine.resetSession();
    // 'a' was session-only — should now reprompt and we deny.
    expect(await engine.checkApproval(writeReq({ args: { command: 'a' } }))).toBe(
      false,
    );
    // 'b' was always — should still pass without prompt.
    expect(await engine.checkApproval(writeReq({ args: { command: 'b' } }))).toBe(
      true,
    );
  });
});

describe('ApprovalEngine — smart mode', () => {
  it('7. safe-rated commands auto-approve', async () => {
    const riskAssess = vi
      .fn()
      .mockResolvedValue({ tier: 'safe', rationale: 'fine' });
    const promptUser = vi.fn();
    const engine = new ApprovalEngine('smart', { riskAssess, promptUser });
    const ok = await engine.checkApproval(writeReq());
    expect(ok).toBe(true);
    expect(promptUser).not.toHaveBeenCalled();
  });

  it('8. dangerous-rated auto-deny', async () => {
    const riskAssess = vi
      .fn()
      .mockResolvedValue({ tier: 'dangerous', rationale: 'rm -rf /' });
    const promptUser = vi.fn();
    const engine = new ApprovalEngine('smart', { riskAssess, promptUser });
    const ok = await engine.checkApproval(writeReq({ args: { command: 'rm -rf /' } }));
    expect(ok).toBe(false);
    expect(promptUser).not.toHaveBeenCalled();
  });

  it('9. caution-rated falls through to user prompt', async () => {
    const riskAssess = vi
      .fn()
      .mockResolvedValue({ tier: 'caution', rationale: 'maybe ok' });
    const promptUser = vi.fn().mockResolvedValue('deny' as ApprovalDecision);
    const engine = new ApprovalEngine('smart', { riskAssess, promptUser });
    const ok = await engine.checkApproval(writeReq());
    expect(ok).toBe(false);
    expect(promptUser).toHaveBeenCalledOnce();
  });

  it('10. pre-flagged riskTier is trusted (no riskAssess call)', async () => {
    const riskAssess = vi.fn();
    const engine = new ApprovalEngine('smart', { riskAssess });
    const ok = await engine.checkApproval(
      writeReq({ riskTier: 'safe' }),
    );
    expect(ok).toBe(true);
    expect(riskAssess).not.toHaveBeenCalled();
  });
});

describe('ApprovalEngine — off / mode switching', () => {
  it('11. off mode auto-allows everything; logs decisions', async () => {
    const onDecision = vi.fn();
    const engine = new ApprovalEngine('off', { onDecision });
    const ok = await engine.checkApproval(
      writeReq({ args: { command: 'rm -rf /' } }),
    );
    expect(ok).toBe(true);
    expect(onDecision).toHaveBeenCalledWith(expect.any(Object), 'allow');
  });

  it('12. setMode mid-session changes behavior', async () => {
    const promptUser = vi.fn().mockResolvedValue('deny' as ApprovalDecision);
    const engine = new ApprovalEngine('manual', { promptUser });
    expect(await engine.checkApproval(writeReq())).toBe(false);
    engine.setMode('off');
    expect(await engine.checkApproval(writeReq())).toBe(true);
    expect(promptUser).toHaveBeenCalledOnce(); // only the manual call prompted
  });

  it('13. fail-closed when no promptUser wired in manual mode', async () => {
    const engine = new ApprovalEngine('manual', {});
    expect(await engine.checkApproval(writeReq())).toBe(false);
  });

  it('14. argSignature is stable for same primary arg', () => {
    const a = argSignature('shell_exec', { command: 'echo 1', timeoutMs: 100 });
    const b = argSignature('shell_exec', { command: 'echo 1', timeoutMs: 999 });
    expect(a).toBe(b);
  });
});

describe('ApprovalEngine — Phase 16f built-in safe policy', () => {
  it('15. smart mode auto-approves BUILTIN_SAFE_TOOLS without prompting', async () => {
    const promptUser = vi.fn();
    const onDecision = vi.fn();
    const eng = new ApprovalEngine('smart', { promptUser, onDecision });
    const ok = await eng.checkApproval({
      toolName: 'fetch_url',
      category: 'network',
      args: { url: 'https://example.com/api' },
    });
    expect(ok).toBe(true);
    expect(promptUser).not.toHaveBeenCalled();
    expect(onDecision).toHaveBeenCalledWith(expect.anything(), 'allow');
  });

  it('16. smart mode auto-approves browser_navigate to allowlisted domains', async () => {
    const promptUser = vi.fn();
    const eng = new ApprovalEngine('smart', { promptUser });
    const ok = await eng.checkApproval({
      toolName: 'browser_navigate',
      category: 'browser',
      args: { url: 'https://github.com/anthropics/anthropic-sdk-typescript' },
    });
    expect(ok).toBe(true);
    expect(promptUser).not.toHaveBeenCalled();
  });

  it('17. smart mode prompts for browser_navigate to non-allowlisted domains', async () => {
    const promptUser = vi.fn(async () => 'deny' as const);
    const eng = new ApprovalEngine('smart', { promptUser });
    const ok = await eng.checkApproval({
      toolName: 'browser_navigate',
      category: 'browser',
      args: { url: 'https://random-evil-site.example.com' },
    });
    expect(ok).toBe(false);
    expect(promptUser).toHaveBeenCalledOnce();
  });

  it('18. smart mode still prompts for non-safe tools', async () => {
    const promptUser = vi.fn(async () => 'allow' as const);
    const eng = new ApprovalEngine('smart', { promptUser });
    await eng.checkApproval({
      toolName: 'shell_exec',
      category: 'execute',
      args: { command: 'ls -la' },
    });
    expect(promptUser).toHaveBeenCalledOnce();
  });

  it('19. manual mode does NOT short-circuit on built-in safe tools', async () => {
    // The built-in policy is smart-mode-only — manual stays paranoid.
    const promptUser = vi.fn(async () => 'allow' as const);
    const eng = new ApprovalEngine('manual', { promptUser });
    await eng.checkApproval({
      toolName: 'fetch_url',
      category: 'network',
      args: { url: 'https://example.com' },
    });
    expect(promptUser).toHaveBeenCalledOnce();
  });

  it('20. loadPersistentAllowlist hydrates session + permanent allow sets', async () => {
    const promptUser = vi.fn(async () => 'deny' as const);
    const eng = new ApprovalEngine('manual', { promptUser });
    eng.loadPersistentAllowlist([
      { tool: 'shell_exec', signature: 'shell_exec::pytest' },
    ]);
    const ok = await eng.checkApproval({
      toolName: 'shell_exec',
      category: 'execute',
      args: { command: 'pytest' },
    });
    expect(ok).toBe(true);
    expect(promptUser).not.toHaveBeenCalled();
  });

  it('21. loadPersistentAllowlist survives resetSession (permanent ⊂ session)', async () => {
    const promptUser = vi.fn(async () => 'deny' as const);
    const eng = new ApprovalEngine('manual', { promptUser });
    eng.loadPersistentAllowlist([
      { tool: 'shell_exec', signature: 'shell_exec::pytest' },
    ]);
    eng.resetSession();
    const ok = await eng.checkApproval({
      toolName: 'shell_exec',
      category: 'execute',
      args: { command: 'pytest' },
    });
    expect(ok).toBe(true);
  });

  it('22. hostnameOf parses URLs correctly and returns null on garbage', async () => {
    const { hostnameOf } = await import('../../../moat/approvalEngine');
    expect(hostnameOf('https://www.GitHub.com/foo')).toBe('www.github.com');
    expect(hostnameOf('not a url')).toBeNull();
    expect(hostnameOf('')).toBeNull();
  });
});

// ─── v4.10 Slice 10.6 — onDecision coverage + audit metadata ──────────

describe('ApprovalEngine — Slice 10.6 onDecision for all four outcomes', () => {
  it('fires onDecision with `allow` when off-mode auto-approves a mutating tool', async () => {
    const onDecision = vi.fn();
    const engine = new ApprovalEngine('off', { onDecision });
    await engine.checkApproval(writeReq({ args: { command: 'ls' } }));
    expect(onDecision).toHaveBeenCalledWith(expect.any(Object), 'allow');
  });

  it('fires onDecision with `deny` when promptUser denies', async () => {
    const onDecision = vi.fn();
    const promptUser = vi.fn(async () => 'deny' as const);
    const engine = new ApprovalEngine('manual', { promptUser, onDecision });
    await engine.checkApproval(writeReq({ args: { command: 'rm' } }));
    expect(onDecision).toHaveBeenLastCalledWith(expect.any(Object), 'deny');
  });

  it('fires onDecision with `allow_session` and records sessionAllow membership', async () => {
    const onDecision = vi.fn();
    const promptUser = vi.fn(async () => 'allow_session' as const);
    const engine = new ApprovalEngine('manual', { promptUser, onDecision });
    await engine.checkApproval(writeReq({ args: { command: 'pytest' } }));
    expect(onDecision).toHaveBeenLastCalledWith(expect.any(Object), 'allow_session');
    // Second call short-circuits via sessionAllow — onDecision fires
    // again, this time with the short-circuit verb.
    await engine.checkApproval(writeReq({ args: { command: 'pytest' } }));
    expect(promptUser).toHaveBeenCalledTimes(1);
    expect(onDecision).toHaveBeenCalledTimes(2);
  });

  it('fires onDecision with `allow_always` and persists via persistAllow sink', async () => {
    const onDecision  = vi.fn();
    const persistAllow = vi.fn();
    const promptUser  = vi.fn(async () => 'allow_always' as const);
    const engine = new ApprovalEngine('manual', { promptUser, onDecision, persistAllow });
    await engine.checkApproval(writeReq({ args: { command: 'pytest' } }));
    expect(onDecision).toHaveBeenLastCalledWith(expect.any(Object), 'allow_always');
    expect(persistAllow).toHaveBeenCalledOnce();
  });
});

describe('ApprovalEngine — Slice 10.6 allowlist audit metadata', () => {
  it('loadPersistentAllowlist defaults missing timestamps to Date.now() (legacy migration)', async () => {
    const engine = new ApprovalEngine('manual', {});
    const before = Date.now();
    engine.loadPersistentAllowlist([
      // legacy shape — no createdAt/lastUsedAt
      { tool: 'shell_exec', signature: 'shell_exec::pytest' },
    ]);
    const after = Date.now();
    const [entry] = engine.listAllowlistEntries();
    expect(entry.tool).toBe('shell_exec');
    expect(entry.signature).toBe('shell_exec::pytest');
    expect(entry.createdAt).toBeGreaterThanOrEqual(before);
    expect(entry.createdAt).toBeLessThanOrEqual(after);
    expect(entry.lastUsedAt).toBeGreaterThanOrEqual(before);
    expect(entry.scope).toBe('global');   // default when caller didn't tag
  });

  it('loadPersistentAllowlist preserves provided timestamps + scope', () => {
    const engine = new ApprovalEngine('manual', {});
    engine.loadPersistentAllowlist([
      { tool: 'shell_exec', signature: 'shell_exec::pytest',
        createdAt: 1000, lastUsedAt: 2000, scope: 'project' },
    ]);
    const [entry] = engine.listAllowlistEntries();
    expect(entry.createdAt).toBe(1000);
    expect(entry.lastUsedAt).toBe(2000);
    expect(entry.scope).toBe('project');
  });

  it('refresh sink fires when a permanent-allow entry short-circuits a prompt', async () => {
    const engine = new ApprovalEngine('manual', { promptUser: vi.fn(async () => 'deny' as const) });
    const refresh = vi.fn();
    engine.setRefreshSink(refresh);
    engine.loadPersistentAllowlist([
      { tool: 'shell_exec', signature: 'shell_exec::pytest',
        createdAt: 1000, lastUsedAt: 1000, scope: 'global' },
    ]);
    const before = Date.now();
    await engine.checkApproval(writeReq({ args: { command: 'pytest' } }));
    const after = Date.now();
    expect(refresh).toHaveBeenCalledOnce();
    const refreshedEntry = refresh.mock.calls[0][0];
    expect(refreshedEntry.tool).toBe('shell_exec');
    // lastUsedAt got bumped from 1000 to roughly now.
    expect(refreshedEntry.lastUsedAt).toBeGreaterThanOrEqual(before);
    expect(refreshedEntry.lastUsedAt).toBeLessThanOrEqual(after);
    expect(refreshedEntry.createdAt).toBe(1000);   // createdAt unchanged
  });

  it('refresh sink does NOT fire for session-only entries (no persisted backing)', async () => {
    const engine = new ApprovalEngine('manual', { promptUser: vi.fn(async () => 'allow_session' as const) });
    const refresh = vi.fn();
    engine.setRefreshSink(refresh);
    // First call grants session permission via promptUser.
    await engine.checkApproval(writeReq({ args: { command: 'pytest' } }));
    refresh.mockClear();
    // Second call short-circuits via sessionAllow, but there's no
    // persistent backing — refresh sink stays silent.
    await engine.checkApproval(writeReq({ args: { command: 'pytest' } }));
    expect(refresh).not.toHaveBeenCalled();
  });

  it('allowAlways seeds metadata + persistAllow sink fires', () => {
    const persistAllow = vi.fn();
    const engine = new ApprovalEngine('manual', { persistAllow });
    engine.allowAlways('shell_exec', 'shell_exec::pytest');
    expect(persistAllow).toHaveBeenCalledOnce();
    const [entry] = engine.listAllowlistEntries();
    expect(entry.tool).toBe('shell_exec');
    expect(entry.signature).toBe('shell_exec::pytest');
    expect(entry.scope).toBe('global');
    expect(entry.createdAt).toBeGreaterThan(0);
    expect(entry.lastUsedAt).toBeGreaterThan(0);
  });
});

describe('ApprovalEngine — Slice 10.6c riskTier reassignment on smart-mode auto-paths', () => {
  // Pre-10.6c bug: smart-mode safe-auto-allow and dangerous-auto-deny
  // fired onDecision with the request's PRE-classification riskTier
  // (undefined → defaulted to 'caution' in callbacks). The
  // approval.decided trace row therefore reported the wrong tier:
  // "decision=allow, riskTier=caution" when the aux LLM had actually
  // rated it 'safe'. Fix: reassign req.riskTier = tier BEFORE firing
  // onDecision on both auto-paths. Behaviour change: zero (decision
  // outcomes are identical); audit accuracy improves.
  it('safe-auto-allow path fires onDecision with riskTier=`safe` (not undefined/caution)', async () => {
    const onDecision = vi.fn();
    const riskAssess = vi.fn(async () => ({ tier: 'safe' as const, rationale: 'aux says safe' }));
    const engine = new ApprovalEngine('smart', { onDecision, riskAssess });
    await engine.checkApproval({
      toolName: 'mystery_tool',     // not in BUILTIN_SAFE_TOOLS, no pre-flagged tier
      category: 'execute',
      args:     { foo: 'bar' },
    });
    expect(onDecision).toHaveBeenCalledOnce();
    const [decidedReq, verb] = onDecision.mock.calls[0];
    expect(verb).toBe('allow');
    expect(decidedReq.riskTier).toBe('safe');      // reassigned to gate's actual decision
    expect(decidedReq.reason).toBe('aux says safe'); // rationale threaded through too
  });

  it('dangerous-auto-deny path fires onDecision with riskTier=`dangerous`', async () => {
    const onDecision = vi.fn();
    const riskAssess = vi.fn(async () => ({ tier: 'dangerous' as const, rationale: 'aux says dangerous' }));
    const engine = new ApprovalEngine('smart', { onDecision, riskAssess });
    await engine.checkApproval({
      toolName: 'mystery_tool',
      category: 'execute',
      args:     { foo: 'bar' },
    });
    const [decidedReq, verb] = onDecision.mock.calls[0];
    expect(verb).toBe('deny');
    expect(decidedReq.riskTier).toBe('dangerous');
    expect(decidedReq.reason).toBe('aux says dangerous');
  });

  it('caution-fallthrough still works (pre-existing behaviour preserved)', async () => {
    const onDecision = vi.fn();
    const promptUser = vi.fn(async () => 'allow' as const);
    const riskAssess = vi.fn(async () => ({ tier: 'caution' as const, rationale: 'needs review' }));
    const engine = new ApprovalEngine('smart', { onDecision, promptUser, riskAssess });
    await engine.checkApproval({
      toolName: 'mystery_tool',
      category: 'execute',
      args:     { foo: 'bar' },
    });
    expect(promptUser).toHaveBeenCalledOnce();
    const [decidedReq] = onDecision.mock.calls[0];
    expect(decidedReq.riskTier).toBe('caution');   // caution path already reassigned pre-10.6c
    expect(decidedReq.reason).toBe('needs review');
  });
});

describe('ApprovalEngine — Slice 10.6 effects metadata threads through', () => {
  it('checkApproval forwards `effects` to promptUser via ApprovalRequest', async () => {
    let seenReq: import('../../../moat/approvalEngine').ApprovalRequest | undefined;
    const promptUser = vi.fn(async (req) => {
      seenReq = req;
      return 'allow' as const;
    });
    const engine = new ApprovalEngine('manual', { promptUser });
    await engine.checkApproval({
      toolName: 'file_write',
      category: 'write',
      args:     { path: '/tmp/x' },
      effects:  { writesFiles: true, irreversible: true },
    });
    expect(seenReq?.effects?.writesFiles).toBe(true);
    expect(seenReq?.effects?.irreversible).toBe(true);
  });
});

describe('ApprovalEngine — Slice 10.6 per-project + global grant coexistence', () => {
  it('global + project entries load together; project scope marker preserved', () => {
    const engine = new ApprovalEngine('manual', {});
    // Simulate aidenCLI's loader merging global → project (project
    // last so it wins on collision via Map last-write).
    engine.loadPersistentAllowlist([
      { tool: 'shell_exec', signature: 'shell_exec::npm test',
        createdAt: 1000, lastUsedAt: 1500, scope: 'global' },
      { tool: 'file_write', signature: 'file_write::/proj/x',
        createdAt: 2000, lastUsedAt: 2500, scope: 'project' },
    ]);
    const entries = engine.listAllowlistEntries();
    expect(entries.length).toBe(2);
    const byScope = Object.fromEntries(entries.map((e) => [e.scope, e]));
    expect(byScope.global.tool).toBe('shell_exec');
    expect(byScope.project.tool).toBe('file_write');
    expect(byScope.project.signature).toBe('file_write::/proj/x');
  });

  it('project entry shadows a global entry for the same tool::signature (last-write-wins)', () => {
    const engine = new ApprovalEngine('manual', {});
    engine.loadPersistentAllowlist([
      { tool: 'shell_exec', signature: 'shell_exec::pytest',
        createdAt: 1000, lastUsedAt: 1500, scope: 'global' },
      // Project entry with same tool::signature should override
      // the global metadata. The shared `permanentAllow` Set
      // remains a single membership entry by design.
      { tool: 'shell_exec', signature: 'shell_exec::pytest',
        createdAt: 5000, lastUsedAt: 5500, scope: 'project' },
    ]);
    const entries = engine.listAllowlistEntries();
    expect(entries.length).toBe(1);            // de-duped membership
    expect(entries[0].scope).toBe('project');  // project metadata won
    expect(entries[0].createdAt).toBe(5000);
  });
});

// ── Notes on PTY approval-flow regression layer ───────────────────────
//
// The Slice 10.5 PTY harness (tests/v4/cli/aidenPromptFooterGhost.test.ts)
// could drive the slash-command dropdown because that flow needs zero
// LLM — the dropdown is a pure rendering surface. An end-to-end PTY
// test of the APPROVAL flow needs a tool to actually fire from inside
// the agent loop, which currently requires either:
//   (a) a real LLM call that the harness can drive into invoking a
//       mutating tool, OR
//   (b) a synthetic test-only entry point that injects an approval
//       request without going through the model.
//
// Neither is in this slice's scope (LOC budget, complexity). Coverage
// is provided by:
//   - The source-contract symmetric-coverage guard in
//     tests/v4/cli/chatSessionUiPersist.test.ts:Slice-10.6 which
//     catches regressions to the onDecision wire on both REPL and
//     daemon paths.
//   - The 32 unit tests in this file covering ApprovalEngine
//     state-machine semantics for all four decision outcomes plus
//     metadata + refresh-sink behaviour.
//   - The integration test in chatSessionUiPersist.test.ts:Slice-10.6
//     which drives the production onDecision closure shape against a
//     real DB and asserts the rich row lands.
//
// A future slice (10.6b or 10.7+) that adds an LLM-stub PTY harness
// can layer a real approval-flow test on top of this substrate.
