import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';

import {
  help,
  SUBSECTION_MAP,
  SUBSECTION_ORDER,
  subsectionFor,
} from '../../../cli/v4/commands/help';
import {
  CommandRegistry,
  type SlashCommand,
  type SlashCommandContext,
} from '../../../cli/v4/commandRegistry';
import { Display } from '../../../cli/v4/display';
import { SkinEngine } from '../../../cli/v4/skinEngine';
import { allCommands } from '../../../cli/v4/commands';

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

function mkDisplay() {
  const chunks: string[] = [];
  const out = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  }) as unknown as NodeJS.WriteStream;
  const display = new Display({
    skin: new SkinEngine({ forceMono: true }),
    stdout: out,
  });
  return { display, chunks };
}

function mkCmd(over: Partial<SlashCommand> & Pick<SlashCommand, 'name'>): SlashCommand {
  return {
    name: over.name,
    description: over.description ?? `cmd ${over.name}`,
    category: over.category ?? 'system',
    handler: over.handler ?? (async () => ({})),
    icon: over.icon,
  };
}

describe('cli/v4/commands/help — Phase 22 Task 2', () => {
  it('SUBSECTION_ORDER lists the six section headers in spec order', () => {
    expect([...SUBSECTION_ORDER]).toEqual([
      'Session',
      'Configuration',
      'Identity',
      'System',
      'Authentication',
      'Help',
    ]);
  });

  it('SUBSECTION_MAP routes the spec-named commands into the right buckets', () => {
    expect(subsectionFor('clear')).toBe('Session');
    expect(subsectionFor('compress')).toBe('Session');
    expect(subsectionFor('save')).toBe('Session');
    expect(subsectionFor('title')).toBe('Session');

    expect(subsectionFor('model')).toBe('Configuration');
    expect(subsectionFor('personality')).toBe('Configuration');
    expect(subsectionFor('skin')).toBe('Configuration');
    expect(subsectionFor('streaming')).toBe('Configuration');
    expect(subsectionFor('reasoning')).toBe('Configuration');
    expect(subsectionFor('verbose')).toBe('Configuration');
    expect(subsectionFor('debug-prompt')).toBe('Configuration');

    expect(subsectionFor('identity')).toBe('Identity');
    expect(subsectionFor('auth')).toBe('Authentication');
    expect(subsectionFor('help')).toBe('Help');
    expect(subsectionFor('doctor')).toBe('System');
    expect(subsectionFor('yolo')).toBe('System');
  });

  it('unknown commands fall through to the "System" bucket', () => {
    expect(subsectionFor('totally-new-command')).toBe('System');
  });

  it('every bundled system command is mapped (no silent System fallthrough)', () => {
    const unmapped: string[] = [];
    for (const c of allCommands) {
      if (c.category === 'system' && !(c.name in SUBSECTION_MAP)) {
        unmapped.push(c.name);
      }
    }
    expect(unmapped).toEqual([]);
  });

  it('every bundled command description fits in 80 chars', () => {
    const overflow: string[] = [];
    for (const c of allCommands) {
      if (c.description.length > 80) overflow.push(`${c.name} (${c.description.length})`);
    }
    expect(overflow).toEqual([]);
  });

  it('renders a section header per non-empty bucket', async () => {
    const reg = new CommandRegistry();
    reg.register(help);
    reg.register(mkCmd({ name: 'clear' }));
    reg.register(mkCmd({ name: 'model' }));
    reg.register(mkCmd({ name: 'identity' }));
    reg.register(mkCmd({ name: 'doctor' }));
    reg.register(mkCmd({ name: 'auth' }));
    reg.register(mkCmd({ name: 'do-the-thing', category: 'skill' }));

    const { display, chunks } = mkDisplay();
    await help.handler({
      args: [],
      rawArgs: '',
      display,
      registry: reg,
    } as unknown as SlashCommandContext);
    const out = stripAnsi(chunks.join(''));

    expect(out).toMatch(/── Session ──/);
    expect(out).toMatch(/── Configuration ──/);
    expect(out).toMatch(/── Identity ──/);
    expect(out).toMatch(/── System ──/);
    expect(out).toMatch(/── Authentication ──/);
    expect(out).toMatch(/── Help ──/);
    expect(out).toMatch(/── Skills ──/);
  });

  it('omits headers for empty buckets', async () => {
    const reg = new CommandRegistry();
    // Only register commands in two sections — the others must NOT show.
    reg.register(mkCmd({ name: 'clear' }));
    reg.register(mkCmd({ name: 'auth' }));

    const { display, chunks } = mkDisplay();
    await help.handler({
      args: [],
      rawArgs: '',
      display,
      registry: reg,
    } as unknown as SlashCommandContext);
    const out = stripAnsi(chunks.join(''));

    expect(out).toMatch(/── Session ──/);
    expect(out).toMatch(/── Authentication ──/);
    expect(out).not.toMatch(/── Configuration ──/);
    expect(out).not.toMatch(/── Identity ──/);
    expect(out).not.toMatch(/── System ──/);
    expect(out).not.toMatch(/── Help ──/);
    expect(out).not.toMatch(/── Skills ──/);
  });
});
