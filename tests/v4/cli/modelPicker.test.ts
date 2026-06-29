import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runModelPicker, type PickerPrompts } from '../../../cli/v4/commands/modelPicker';
import { CredentialResolver } from '../../../providers/v4/credentialResolver';
import { RuntimeResolver } from '../../../providers/v4/runtimeResolver';

function realResolver(): RuntimeResolver {
  // CredentialResolver needs a paths-like object — but the picker only reads
  // listProviders() / listModels(), so a minimal stub is fine here.
  const cr = new CredentialResolver({ authJson: 'C:/nonexistent/auth.json' } as any);
  return new RuntimeResolver(cr);
}

function mockPrompts(answers: string[]): PickerPrompts {
  let i = 0;
  return {
    async select() {
      const ans = answers[i];
      i += 1;
      if (ans === '__CANCEL__') {
        throw new Error('user cancelled');
      }
      return ans;
    },
  };
}

/** Phase 22: stage-1 messages start with `⚙ Model Picker — Select Provider`. */
function isStage1(message: string): boolean {
  return message.includes('⚙ Model Picker — Select Provider');
}

describe('runModelPicker', () => {
  // v4.11 — the table layout depends on terminal width. Pin a wide width
  // so the column/price assertions are deterministic regardless of the
  // dev's real terminal (CI has no TTY → 80; we pin 100 = full table).
  let origCols: number | undefined;
  beforeEach(() => {
    origCols = process.stdout.columns;
    (process.stdout as { columns?: number }).columns = 100;
  });
  afterEach(() => {
    (process.stdout as { columns?: number }).columns = origCols;
  });

  it('parses provider:model spec without prompting', async () => {
    const result = await runModelPicker({
      resolver: realResolver(),
      spec: 'anthropic:claude-opus-4-7',
    });
    expect(result).toEqual({ providerId: 'anthropic', modelId: 'claude-opus-4-7' });
  });

  it('parses bare unique model', async () => {
    const result = await runModelPicker({
      resolver: realResolver(),
      spec: 'llama-3.3-70b-versatile',
    });
    expect(result).toEqual({ providerId: 'groq', modelId: 'llama-3.3-70b-versatile' });
  });

  it('returns null on ambiguous bare model', async () => {
    // claude-opus-4-7 is served by both anthropic and claude-pro
    // (Phase 21 #5: canonical OAuth ID — legacy claude_subscription removed).
    const result = await runModelPicker({
      resolver: realResolver(),
      spec: 'claude-opus-4-7',
    });
    expect(result).toBeNull();
  });

  it('returns null on completely invalid spec', async () => {
    const result = await runModelPicker({
      resolver: realResolver(),
      spec: 'totally-not-a-real-model',
    });
    expect(result).toBeNull();
  });

  it('interactive picker shows all 19 providers + Cancel row', async () => {
    const select = vi.fn(async (opts: any) => {
      if (isStage1(opts.message)) {
        // Phase 22 Task 3: 19 providers + a Cancel row = 20 stage-1 rows.
        expect(opts.choices.length).toBe(20);
        return 'groq';
      }
      return 'llama-3.3-70b-versatile';
    });
    const result = await runModelPicker({
      resolver: realResolver(),
      promptModule: { select },
    });
    expect(result).toEqual({ providerId: 'groq', modelId: 'llama-3.3-70b-versatile' });
    expect(select).toHaveBeenCalledTimes(2);
  });

  it('renders tier badges in provider choices', async () => {
    const seen: string[] = [];
    const select = vi.fn(async (opts: any) => {
      if (isStage1(opts.message)) {
        for (const c of opts.choices) seen.push(c.name);
        return 'ollama';
      }
      return 'llama3.2';
    });
    await runModelPicker({
      resolver: realResolver(),
      promptModule: { select },
    });
    const joined = seen.join('\n');
    expect(joined).toMatch(/⭐ Pro|🔑 Subscription/);
    expect(joined).toMatch(/🆓 Free/);
    expect(joined).toMatch(/💲 Paid/);
    expect(joined).toMatch(/🏠 Local/);
  });

  it('model choice includes context length and pricing when available', async () => {
    let modelChoices: any[] = [];
    const select = vi.fn(async (opts: any) => {
      if (isStage1(opts.message)) return 'anthropic';
      modelChoices = opts.choices;
      return 'claude-opus-4-7';
    });
    await runModelPicker({
      resolver: realResolver(),
      promptModule: { select },
    });
    const opus = modelChoices.find((c) => c.value === 'claude-opus-4-7');
    expect(opus.name).toMatch(/200K/);
    expect(opus.name).toMatch(/\$15/);
  });

  it('model choice omits pricing when undefined', async () => {
    let modelChoices: any[] = [];
    const select = vi.fn(async (opts: any) => {
      if (isStage1(opts.message)) return 'ollama';
      modelChoices = opts.choices;
      return 'llama3.2';
    });
    await runModelPicker({
      resolver: realResolver(),
      promptModule: { select },
    });
    const local = modelChoices.find((c) => c.value === 'llama3.2');
    expect(local.name).not.toMatch(/\$/);
    expect(local.name).toMatch(/131K/);
  });

  it('returns null when user cancels provider prompt via Ctrl+C', async () => {
    const result = await runModelPicker({
      resolver: realResolver(),
      promptModule: mockPrompts(['__CANCEL__']),
    });
    expect(result).toBeNull();
  });

  it('returns null when user cancels model prompt via Ctrl+C', async () => {
    const result = await runModelPicker({
      resolver: realResolver(),
      promptModule: mockPrompts(['anthropic', '__CANCEL__']),
    });
    expect(result).toBeNull();
  });

  it('tier filter restricts provider list (+ Cancel row)', async () => {
    let count = 0;
    const select = vi.fn(async (opts: any) => {
      if (isStage1(opts.message)) {
        count = opts.choices.length;
        return 'ollama';
      }
      return 'llama3.2';
    });
    await runModelPicker({
      resolver: realResolver(),
      promptModule: { select },
      tier: 'local',
    });
    // Phase 22 Task 3: 1 provider + Cancel row.
    expect(count).toBe(2);
  });

  // ── Phase 22 Task 3 additions ─────────────────────────────────────────

  it('stage-1 row carries the (N models) count badge per provider', async () => {
    const seen: string[] = [];
    const select = vi.fn(async (opts: any) => {
      if (isStage1(opts.message)) {
        for (const c of opts.choices) seen.push(c.name);
        return 'anthropic';
      }
      return 'claude-opus-4-7';
    });
    await runModelPicker({
      resolver: realResolver(),
      promptModule: { select },
    });
    const anthropicRow = seen.find((s) => s.startsWith('Anthropic'))!;
    expect(anthropicRow).toBeDefined();
    expect(anthropicRow).toMatch(/\(\d+ model[s]?\)/);
  });

  it('stage-1 shows ✓ authed for providers reporting credentials', async () => {
    const seen: string[] = [];
    const select = vi.fn(async (opts: any) => {
      if (isStage1(opts.message)) {
        for (const c of opts.choices) seen.push(c.name);
        return 'anthropic';
      }
      return 'claude-opus-4-7';
    });
    await runModelPicker({
      resolver: realResolver(),
      promptModule: { select },
      isProviderAuthed: (id) => id === 'anthropic',
    });
    const anthropicRow = seen.find((s) => s.startsWith('Anthropic'))!;
    const groqRow = seen.find((s) => s.startsWith('Groq'))!;
    expect(anthropicRow).toMatch(/✓ authed/);
    expect(groqRow).toMatch(/⚠ no API key/);
  });

  it('stage-1 marks the current provider with ← current and stage-2 the current model', async () => {
    let seenStage1: string[] = [];
    let seenStage2: string[] = [];
    const select = vi.fn(async (opts: any) => {
      if (isStage1(opts.message)) {
        seenStage1 = opts.choices.map((c: any) => c.name);
        return 'anthropic';
      }
      seenStage2 = opts.choices.map((c: any) => c.name);
      return 'claude-opus-4-7';
    });
    await runModelPicker({
      resolver: realResolver(),
      promptModule: { select },
      currentProviderId: 'anthropic',
      currentModelId: 'claude-opus-4-7',
    });
    expect(seenStage1.find((r) => r.startsWith('Anthropic'))).toMatch(/← current/);
    expect(seenStage2.find((r) => r.startsWith('Claude Opus 4.7'))).toMatch(/← current/);
  });

  it('stage-1 hint shows "Current: <provider> on <model>" when supplied', async () => {
    let stage1Message = '';
    const select = vi.fn(async (opts: any) => {
      if (isStage1(opts.message)) {
        stage1Message = opts.message;
        return 'anthropic';
      }
      return 'claude-opus-4-7';
    });
    await runModelPicker({
      resolver: realResolver(),
      promptModule: { select },
      currentProviderId: 'groq',
      currentModelId: 'llama-3.3-70b-versatile',
    });
    expect(stage1Message).toMatch(/Current: groq on llama-3\.3-70b-versatile/);
  });

  it('stage-2 message carries the breadcrumb to the chosen provider', async () => {
    let stage2Message = '';
    const select = vi.fn(async (opts: any) => {
      if (isStage1(opts.message)) return 'anthropic';
      stage2Message = opts.message;
      return 'claude-opus-4-7';
    });
    await runModelPicker({
      resolver: realResolver(),
      promptModule: { select },
    });
    expect(stage2Message).toMatch(/⚙ Model Picker — Anthropic/);
    expect(stage2Message).toMatch(/Select a model \(\d+ available\)/);
  });

  it('stage-2 includes ← Back and Cancel rows after the model list', async () => {
    let modelChoices: any[] = [];
    const select = vi.fn(async (opts: any) => {
      if (isStage1(opts.message)) return 'anthropic';
      modelChoices = opts.choices;
      return 'claude-opus-4-7';
    });
    await runModelPicker({
      resolver: realResolver(),
      promptModule: { select },
    });
    expect(modelChoices.at(-2)?.name).toBe('← Back');
    expect(modelChoices.at(-1)?.name).toBe('Cancel');
  });

  it('selecting ← Back returns to stage 1 and re-prompts cleanly', async () => {
    const calls: string[] = [];
    let stage1Calls = 0;
    const select = vi.fn(async (opts: any) => {
      calls.push(opts.message);
      if (isStage1(opts.message)) {
        stage1Calls += 1;
        // First time pick anthropic; second time (after Back) pick groq.
        return stage1Calls === 1 ? 'anthropic' : 'groq';
      }
      // Stage 2: first time return BACK, second time pick a real model.
      const backChoice = opts.choices.find((c: any) => c.name === '← Back');
      if (calls.filter((m) => !isStage1(m)).length === 1) {
        return backChoice.value;
      }
      return 'llama-3.3-70b-versatile';
    });
    const result = await runModelPicker({
      resolver: realResolver(),
      promptModule: { select },
    });
    expect(result).toEqual({ providerId: 'groq', modelId: 'llama-3.3-70b-versatile' });
    // 4 calls: stage1 → stage2(back) → stage1 → stage2(pick).
    expect(stage1Calls).toBe(2);
  });

  it('marks the catalog default model with ⭐ recommended', async () => {
    let modelChoices: any[] = [];
    const select = vi.fn(async (opts: any) => {
      if (isStage1(opts.message)) return 'anthropic';
      modelChoices = opts.choices;
      return 'claude-opus-4-7';
    });
    await runModelPicker({
      resolver: realResolver(),
      promptModule: { select },
    });
    // v4.11 — the recommended flag is now a compact trailing ⭐ (was
    // "⭐ recommended") in the padded table.
    const recommended = modelChoices.filter((c) => /⭐/.test(c.name));
    // At least one model in any provider's catalog must be the default.
    expect(recommended.length).toBeGreaterThan(0);
  });

  // ── v4.11 — table formatting ──────────────────────────────────────────
  it('full-width: stage-2 message carries an aligned column header', async () => {
    let stage2Message = '';
    const select = vi.fn(async (opts: any) => {
      if (isStage1(opts.message)) return 'anthropic';
      stage2Message = opts.message;
      return 'claude-opus-4-7';
    });
    await runModelPicker({ resolver: realResolver(), promptModule: { select } });
    // Header is the second line of the message.
    const header = stage2Message.split('\n')[1] ?? '';
    expect(header).toMatch(/Name/);
    expect(header).toMatch(/Context/);
    expect(header).toMatch(/In\/Out \$\/M/);
    expect(header).toMatch(/Tools/);
  });

  it('strips "(deprecating …)" from the name cell into a trailing ⚠ flag', async () => {
    let modelChoices: any[] = [];
    const select = vi.fn(async (opts: any) => {
      if (isStage1(opts.message)) return 'deepseek';
      modelChoices = opts.choices;
      return 'deepseek-chat';
    });
    await runModelPicker({ resolver: realResolver(), promptModule: { select } });
    const chat = modelChoices.find((c) => c.value === 'deepseek-chat')!;
    expect(chat).toBeDefined();
    // The marker is a trailing flag, not inside the (padded) name cell.
    expect(chat.name).toMatch(/⚠ deprecating 2026-07-24/);
    expect(chat.name).not.toMatch(/\(deprecating/);
    // Tools ✓ present (supportsToolCalling).
    expect(chat.name).toMatch(/✓/);
  });

  it('narrow terminal falls back to single-line rows (no header, no wrap)', async () => {
    (process.stdout as { columns?: number }).columns = 50;
    let stage2Message = '';
    let modelChoices: any[] = [];
    const select = vi.fn(async (opts: any) => {
      if (isStage1(opts.message)) return 'anthropic';
      stage2Message = opts.message;
      modelChoices = opts.choices;
      return 'claude-opus-4-7';
    });
    await runModelPicker({ resolver: realResolver(), promptModule: { select } });
    // No header line appended in plain mode.
    expect(stage2Message.split('\n').length).toBe(1);
    // Rows keep the legacy "<N>K ctx" concat shape.
    const opus = modelChoices.find((c) => c.value === 'claude-opus-4-7')!;
    expect(opus.name).toMatch(/200K ctx/);
  });
});
