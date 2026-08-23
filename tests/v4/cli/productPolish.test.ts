import { Writable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CommandRegistry, type SlashCommandContext } from '../../../cli/v4/commandRegistry';
import { help } from '../../../cli/v4/commands/help';
import { history } from '../../../cli/v4/commands/history';
import { runModelPicker, type PickerPrompts } from '../../../cli/v4/commands/modelPicker';
import { skills } from '../../../cli/v4/commands/skills';
import { Display } from '../../../cli/v4/display';
import { getReplyRenderer } from '../../../cli/v4/replyRenderer';
import { SkinEngine } from '../../../cli/v4/skinEngine';
import { renderRuntimeSlot } from '../../../core/v4/capabilities';
import { CredentialResolver } from '../../../providers/v4/credentialResolver';
import { RuntimeResolver } from '../../../providers/v4/runtimeResolver';

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;

function plain(value: string): string {
  return value.replace(ANSI, '');
}

function captureDisplay(columns = 100): { display: Display; output: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  }) as NodeJS.WriteStream;
  Object.defineProperty(stream, 'columns', { configurable: true, value: columns });
  return {
    display: new Display({ stdout: stream, skin: new SkinEngine({ forceMono: true }) }),
    output: () => plain(chunks.join('')),
  };
}

function resolver(): RuntimeResolver {
  return new RuntimeResolver(new CredentialResolver({ authJson: 'C:/missing/auth.json' } as never));
}

describe('CLI product presentation contracts', () => {
  let originalColumns: number | undefined;

  beforeEach(() => {
    originalColumns = process.stdout.columns;
    delete process.env.NO_COLOR;
  });

  afterEach(() => {
    (process.stdout as { columns?: number }).columns = originalColumns;
  });

  it('groups default help without listing /skills twice', async () => {
    const registry = new CommandRegistry();
    for (const command of [help, history, skills]) registry.register(command);
    registry.register({
      name: 'mode', description: 'Choose an operating mode.', category: 'system',
      handler: async () => ({}),
    });
    const { display, output } = captureDisplay(100);

    await help.handler({ args: [], rawArgs: '', display, registry } as SlashCommandContext);

    const rendered = output();
    expect(rendered).toContain('Work');
    expect(rendered).toContain('Memory & skills');
    expect(rendered.match(/^\s*\/skills\b/gm)).toHaveLength(1);
  });

  it('describes /history as a list command and documents explicit clearing', async () => {
    expect(history.description).toMatch(/list/i);
    expect(history.description).not.toMatch(/^clear/i);

    const registry = new CommandRegistry();
    registry.register(help);
    registry.register(history);
    const { display, output } = captureDisplay(100);
    await help.handler({ args: ['history'], rawArgs: 'history', display, registry } as SlashCommandContext);

    expect(output()).toContain('/history [list [N] | clear --yes]');
  });

  it('renders a bounded, searchable Skills list with truthful source labels', async () => {
    const installed = Array.from({ length: 15 }, (_, index) => ({
      name: index === 12 ? 'repository-review' : `skill-${String(index + 1).padStart(2, '0')}`,
      description: index === 12 ? 'Review repository architecture safely.' : `Useful workflow ${index + 1}.`,
      version: '1.0.0',
      filePath: `C:/skills/${index}/SKILL.md`,
      trustLevel: index < 2 ? 'builtin' : 'community',
      author: index === 2 ? 'Example Author' : undefined,
    }));
    const skillLoader = { list: vi.fn(async () => installed) };
    const registry = new CommandRegistry();

    const first = captureDisplay(60);
    await skills.handler({
      args: ['list'], rawArgs: 'list', display: first.display, registry, skillLoader,
    } as unknown as SlashCommandContext);
    expect(first.output()).toContain('page 1/2');
    expect(first.output()).toContain('Bundled');
    expect(first.output()).not.toContain('(uncredited)');
    expect(first.output()).not.toContain('skill-13');

    const filtered = captureDisplay(60);
    await skills.handler({
      args: ['search', 'repository'], rawArgs: 'search repository', display: filtered.display, registry, skillLoader,
    } as unknown as SlashCommandContext);
    expect(filtered.output()).toContain('repository-review');
    expect(filtered.output()).not.toContain('skill-01');
    expect(filtered.output()).toContain('1 match');
  });

  it('uses full model columns when wide and only name/status when narrow', async () => {
    const messages: string[] = [];
    const choicesByStage: Array<Array<{ name: string; value: string }>> = [];
    const prompts: PickerPrompts = {
      async select(options) {
        messages.push(options.message);
        choicesByStage.push(options.choices);
        return messages.length % 2 === 1 ? 'anthropic' : 'claude-opus-4-7';
      },
    };

    (process.stdout as { columns?: number }).columns = 120;
    await runModelPicker({
      resolver: resolver(), promptModule: prompts,
      currentProviderId: 'anthropic', currentModelId: 'claude-opus-4-7',
      isProviderAuthed: () => 'readiness_verified',
    });
    const wideHeader = messages[1].split('\n')[1] ?? '';
    expect(wideHeader).toMatch(/Name\s+Provider\s+Context\s+Tools\s+Status/);

    messages.length = 0;
    choicesByStage.length = 0;
    (process.stdout as { columns?: number }).columns = 50;
    await runModelPicker({
      resolver: resolver(), promptModule: prompts,
      currentProviderId: 'anthropic', currentModelId: 'claude-opus-4-7',
      isProviderAuthed: () => 'readiness_verified',
    });
    expect(messages[1]).not.toContain('Context');
    const current = choicesByStage[1].find((choice) => choice.value === 'claude-opus-4-7');
    expect(current?.name).toContain('current');
    expect(current?.name).not.toContain('ctx');
    expect(current?.name).not.toContain('per M');
    expect(current?.name.length).toBeLessThanOrEqual(48);
  });

  it('keeps the default task outcome concise and exposes axes only in verbose mode', () => {
    const outcome = {
      kind: 'verified' as const,
      severity: 'success' as const,
      label: 'Verified',
      evidenceCount: 1,
      hasRequiredEvidenceGap: false,
      executionStarted: true,
      inspectable: true,
      prominent: false,
      requiredCompletedCount: 1,
      requiredDeniedCount: 0,
      requiredFailedCount: 0,
      requiredSkippedCount: 0,
      requiredUnresolvedCount: 0,
      optionalDeniedCount: 0,
    };
    const concise = captureDisplay();
    concise.display.taskOutcome(outcome);
    expect(concise.output()).toMatch(/^(?:✓|\[\+\]) Completed and verified\n$/u);
    expect(concise.output()).not.toContain('Validation not reported');

    const verbose = captureDisplay();
    verbose.display.taskOutcome(outcome, { verbose: true });
    expect(verbose.output()).toContain('Execution succeeded');
    expect(verbose.output()).toContain('Verification verified');
  });

  it('gives a truthful setup route for an unconfigured coding runtime', () => {
    const captured = captureDisplay();
    captured.display.taskOutcome({
      kind: 'failed', severity: 'error', label: 'External coding model is not configured.',
      evidenceCount: 0, hasRequiredEvidenceGap: false, executionStarted: false,
      inspectable: true, prominent: true, requiredCompletedCount: 0,
      requiredDeniedCount: 0, requiredFailedCount: 1, requiredSkippedCount: 0,
      requiredUnresolvedCount: 0, optionalDeniedCount: 0,
    });
    expect(captured.output()).toContain('Failed — External coding model is not configured.');
    expect(captured.output()).toContain('Fix: Open Workbench → Settings → External Coding.');
  });

  it('states the A2A mutation boundary as a canonical runtime fact', () => {
    const slot = renderRuntimeSlot({
      version: '4.20.0', toolCount: 1, skillCount: 1, channels: ['cli'],
    });
    expect(slot).toContain('A2A mutation is disabled.');
    expect(slot).not.toContain('not automatically');
  });

  it('renders terminal Markdown structure centrally', () => {
    const rendered = plain(getReplyRenderer().render([
      '# Result',
      '',
      '1. First',
      '   - Nested',
      '2. Second',
      '',
      '| Item | State |',
      '| --- | --- |',
      '| Build | Ready |',
      '',
      '```json',
      '{"ok":true}',
      '```',
    ].join('\n')));
    expect(rendered).toContain('RESULT');
    expect(rendered).toMatch(/\b1\.\s+First/);
    expect(rendered).toContain('Nested');
    expect(rendered).toContain('Build');
    expect(rendered).toContain('{"ok":true}');
  });
});
