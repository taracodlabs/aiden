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
