import { describe, it, expect, vi } from 'vitest';
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

describe('runModelPicker', () => {
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

  it('interactive picker shows all 19 providers when no tier filter', async () => {
    const select = vi.fn(async (opts: any) => {
      // First call = provider, second call = model
      if (opts.message.startsWith('Select provider')) {
        // Phase 21 #5 unification: removed the two legacy snake_case
        // OAuth stubs (claude_subscription, chatgpt_subscription) so the
        // picker now exposes ONE entry per OAuth service: the canonical
        // claude-pro and chatgpt-plus IDs. 21 providers → 19.
        expect(opts.choices.length).toBe(19);
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
      if (opts.message.startsWith('Select provider')) {
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
      if (opts.message.startsWith('Select provider')) return 'anthropic';
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
      if (opts.message.startsWith('Select provider')) return 'ollama';
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

  it('returns null when user cancels provider prompt', async () => {
    const result = await runModelPicker({
      resolver: realResolver(),
      promptModule: mockPrompts(['__CANCEL__']),
    });
    expect(result).toBeNull();
  });

  it('returns null when user cancels model prompt', async () => {
    const result = await runModelPicker({
      resolver: realResolver(),
      promptModule: mockPrompts(['anthropic', '__CANCEL__']),
    });
    expect(result).toBeNull();
  });

  it('tier filter restricts provider list', async () => {
    let count = 0;
    const select = vi.fn(async (opts: any) => {
      if (opts.message.startsWith('Select provider')) {
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
    expect(count).toBe(1); // only ollama is tier 'local'
  });
});
