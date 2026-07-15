import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';

import { CommandRegistry, type SlashCommand, type SlashCommandContext } from '../../../cli/v4/commandRegistry';
import { help } from '../../../cli/v4/commands/help';
import { Display } from '../../../cli/v4/display';
import { SkinEngine } from '../../../cli/v4/skinEngine';

function makeDisplay() {
  const chunks: string[] = [];
  const out = new Writable({ write(chunk, _enc, done) { chunks.push(String(chunk)); done(); } }) as unknown as NodeJS.WriteStream;
  return { display: new Display({ skin: new SkinEngine({ forceMono: true }), stdout: out }), text: () => chunks.join('').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '') };
}

function command(name: string, description: string, opts: Partial<SlashCommand> = {}): SlashCommand {
  return { name, description, category: 'system', handler: async () => ({}), ...opts };
}

describe('help discovery', () => {
  it('shows a compact progressive default instead of the whole command catalog', async () => {
    const registry = new CommandRegistry();
    for (const entry of [
      help,
      command('mode', 'Choose the autonomy level.'),
      command('skills', 'Browse installed skills.'),
      command('model', 'Choose a model.'),
      command('doctor', 'Check local configuration.'),
      command('status', 'Show current runtime state.'),
      command('queue', 'List queued messages.'),
      command('debug-prompt', 'Internal diagnostic.', { hidden: true }),
    ]) registry.register(entry);
    const { display, text } = makeDisplay();

    await help.handler({ args: [], rawArgs: '', display, registry } as SlashCommandContext);

    expect(text()).toContain('Start working');
    expect(text()).toContain('Models and setup');
    expect(text()).toContain('Tasks and recovery');
    expect(text()).toContain('/mode');
    expect(text()).toContain('/model');
    expect(text()).toContain('/status');
    expect(text()).toContain('/help all');
    expect(text()).not.toContain('/debug-prompt');
  });

  it('renders registered command detail and aliases without inventing usage', async () => {
    const registry = new CommandRegistry();
    registry.register(help);
    registry.register(command('model', 'Choose a model.', { aliases: ['m'] }));
    const { display, text } = makeDisplay();

    await help.handler({ args: ['model'], rawArgs: 'model', display, registry } as SlashCommandContext);

    expect(text()).toContain('/model');
    expect(text()).toContain('Choose a model.');
    expect(text()).toContain('/m');
  });

  it('keeps unknown help detail local and sends readers back to /help', async () => {
    const registry = new CommandRegistry();
    registry.register(help);
    const { display, text } = makeDisplay();

    await help.handler({ args: ['missing'], rawArgs: 'missing', display, registry } as SlashCommandContext);

    expect(text()).toContain('Unknown command: /missing');
    expect(text()).toContain('/help');
  });
});
