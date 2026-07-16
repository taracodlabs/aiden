import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Writable } from 'node:stream';
import { CommandRegistry, type SlashCommand } from '../../../cli/v4/commandRegistry';
import { Display } from '../../../cli/v4/display';
import { SkinEngine } from '../../../cli/v4/skinEngine';

function mkDisplay() {
  const chunks: string[] = [];
  const errs: string[] = [];
  const out = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  }) as unknown as NodeJS.WriteStream;
  const err = new Writable({
    write(chunk, _enc, cb) {
      errs.push(chunk.toString());
      cb();
    },
  }) as unknown as NodeJS.WriteStream;
  const display = new Display({
    skin: new SkinEngine({ forceMono: true }),
    stdout: out,
    stderr: err,
  });
  return { display, out: chunks, err: errs };
}

function mkCmd(over: Partial<SlashCommand> & Pick<SlashCommand, 'name'>): SlashCommand {
  return {
    name: over.name,
    description: over.description ?? `cmd ${over.name}`,
    category: over.category ?? 'system',
    handler: over.handler ?? (async () => ({})),
    aliases: over.aliases,
    hidden: over.hidden,
    icon: over.icon,
  };
}

describe('CommandRegistry', () => {
  let reg: CommandRegistry;
  beforeEach(() => {
    reg = new CommandRegistry();
  });

  it('registers and retrieves a command by name', () => {
    const cmd = mkCmd({ name: 'help' });
    reg.register(cmd);
    expect(reg.get('help')).toBe(cmd);
  });

  it('unregister removes both name and aliases', () => {
    reg.register(mkCmd({ name: 'quit', aliases: ['q', 'exit'] }));
    reg.unregister('quit');
    expect(reg.get('quit')).toBeNull();
    expect(reg.get('q')).toBeNull();
    expect(reg.get('exit')).toBeNull();
  });

  it('list excludes hidden by default', () => {
    reg.register(mkCmd({ name: 'a' }));
    reg.register(mkCmd({ name: 'b', hidden: true }));
    expect(reg.list().map((c) => c.name)).toEqual(['a']);
    expect(reg.list({ includeHidden: true }).map((c) => c.name)).toEqual(['a', 'b']);
  });

  it('list categoryFilter only returns matching category', () => {
    reg.register(mkCmd({ name: 'help', category: 'system' }));
    reg.register(mkCmd({ name: 'mycmd', category: 'skill' }));
    expect(reg.list({ categoryFilter: 'skill' }).map((c) => c.name)).toEqual(['mycmd']);
    expect(reg.list({ categoryFilter: 'system' }).map((c) => c.name)).toEqual(['help']);
  });

  it('parse identifies slash commands', () => {
    reg.register(mkCmd({ name: 'help' }));
    expect(reg.parse('/help')).toEqual({ name: 'help', args: [], rawArgs: '' });
  });

  it('parse handles arguments', () => {
    reg.register(mkCmd({ name: 'model' }));
    expect(reg.parse('/model groq:llama-3.3')).toEqual({
      name: 'model',
      args: ['groq:llama-3.3'],
      rawArgs: 'groq:llama-3.3',
    });
  });

  it('parse resolves aliases to canonical name', () => {
    reg.register(mkCmd({ name: 'quit', aliases: ['q'] }));
    expect(reg.parse('/q')).toEqual({ name: 'quit', args: [], rawArgs: '' });
  });

  it('parse returns null for non-slash input', () => {
    expect(reg.parse('hello')).toBeNull();
    expect(reg.parse('')).toBeNull();
    expect(reg.parse('  ')).toBeNull();
  });

  it('execute runs the registered handler with parsed args', async () => {
    const handler = vi.fn(async () => ({}));
    reg.register(mkCmd({ name: 'echo', handler }));
    const { display } = mkDisplay();
    const res = await reg.execute('/echo hi there', { display });
    expect(res.handled).toBe(true);
    expect(handler).toHaveBeenCalledOnce();
    const ctx = handler.mock.calls[0][0];
    expect(ctx.args).toEqual(['hi', 'there']);
    expect(ctx.rawArgs).toBe('hi there');
    expect(ctx.registry).toBe(reg);
  });

  it('execute returns handled=false for non-slash input', async () => {
    const { display } = mkDisplay();
    const res = await reg.execute('plain user message', { display });
    expect(res.handled).toBe(false);
  });

  it('execute reports unknown command without throwing', async () => {
    const { display, err } = mkDisplay();
    const res = await reg.execute('/nope', { display });
    expect(res.handled).toBe(true);
    // Display.error returns a string and we wrote nothing on stdout/stderr
    // for the error helper — but Display.error formats via write. The
    // CommandRegistry path calls display.error which returns a string;
    // we just verify it didn't throw.
    expect(err.join('')).toBe(''); // error helper returns string, not stderr
  });

  it('suggests a close visible command but keeps low-confidence commands on /help', async () => {
    reg.register(mkCmd({ name: 'model', description: 'choose model' }));
    reg.register(mkCmd({ name: 'doctor', description: 'diagnose setup' }));
    const { display, out } = mkDisplay();
    await reg.execute('/modle', { display });
    expect(out.join('')).toContain('Did you mean /model?');

    out.length = 0;
    await reg.execute('/unrelated-command', { display });
    expect(out.join('')).toContain('Type /help for a list.');
    expect(out.join('')).not.toContain('Did you mean');
  });

  it('filter("/m") returns prefix-match commands first', () => {
    reg.register(mkCmd({ name: 'model', description: 'switch model' }));
    reg.register(mkCmd({ name: 'memory', description: 'show memory' }));
    reg.register(mkCmd({ name: 'help', description: 'list available' }));
    const out = reg.filter('/m').map((c) => c.name);
    // tier 1 (prefix) first, alphabetical: memory, model.
    expect(out.slice(0, 2)).toEqual(['memory', 'model']);
  });

  it('filter("/") returns all visible commands', () => {
    reg.register(mkCmd({ name: 'help' }));
    reg.register(mkCmd({ name: 'quit' }));
    reg.register(mkCmd({ name: 'secret', hidden: true }));
    const out = reg.filter('/').map((c) => c.name);
    expect(out).toEqual(['help', 'quit']);
  });

  it('filter matches against aliases too', () => {
    reg.register(mkCmd({ name: 'quit', aliases: ['exit'] }));
    expect(reg.filter('/ex').map((c) => c.name)).toEqual(['quit']);
  });

  it('execute propagates exit/clearHistory results', async () => {
    reg.register(mkCmd({ name: 'clear', handler: async () => ({ clearHistory: true }) }));
    reg.register(mkCmd({ name: 'quit', handler: async () => ({ exit: true }) }));
    const { display } = mkDisplay();
    const a = await reg.execute('/clear', { display });
    expect(a.clearHistory).toBe(true);
    const b = await reg.execute('/quit', { display });
    expect(b.exit).toBe(true);
  });
});

describe('CommandRegistry filter polish (Phase 16)', () => {
  let reg: CommandRegistry;
  beforeEach(() => {
    reg = new CommandRegistry();
  });

  it('tier 1: prefix match comes before substring match', () => {
    reg.register(mkCmd({ name: 'model', description: 'show model' }));
    reg.register(mkCmd({ name: 'compress', description: 'force model compression' }));
    const out = reg.filter('/mod').map((c) => c.name);
    expect(out[0]).toBe('model'); // prefix tier
    expect(out).toContain('compress'); // description tier
    expect(out.indexOf('model')).toBeLessThan(out.indexOf('compress'));
  });

  it('tier 2: substring match comes before description match', () => {
    reg.register(mkCmd({ name: 'foo-bar', description: 'unrelated' }));
    reg.register(mkCmd({ name: 'baz', description: 'contains the word bar in description' }));
    const out = reg.filter('/bar').map((c) => c.name);
    expect(out[0]).toBe('foo-bar'); // substring tier
    expect(out[1]).toBe('baz'); // description tier
  });

  it('tier 3: description-only matches are returned', () => {
    reg.register(mkCmd({ name: 'compress', description: 'shrink the conversation context' }));
    const out = reg.filter('/conversation').map((c) => c.name);
    expect(out).toEqual(['compress']);
  });

  it('within a tier, results are sorted alphabetically', () => {
    reg.register(mkCmd({ name: 'mango' }));
    reg.register(mkCmd({ name: 'mint' }));
    reg.register(mkCmd({ name: 'maple' }));
    const out = reg.filter('/m').map((c) => c.name);
    expect(out).toEqual(['mango', 'maple', 'mint']);
  });

  it('recent commands appear first when filter is empty', () => {
    reg.register(mkCmd({ name: 'a' }));
    reg.register(mkCmd({ name: 'b' }));
    reg.register(mkCmd({ name: 'c' }));
    reg.recordRecent('c');
    reg.recordRecent('a');
    const out = reg.filter('/').map((c) => c.name);
    expect(out.slice(0, 2)).toEqual(['a', 'c']); // most-recent-first
    expect(out.slice(2)).toEqual(['b']); // remainder alphabetical
  });

  it('recordRecent dedupes and moves the entry to the front', () => {
    reg.register(mkCmd({ name: 'x' }));
    reg.register(mkCmd({ name: 'y' }));
    reg.recordRecent('x');
    reg.recordRecent('y');
    reg.recordRecent('x');
    expect(reg.serializeRecent()).toEqual(['x', 'y']);
  });

  it('recordRecent caps to RECENT_LIMIT (8)', () => {
    for (let i = 0; i < 12; i++) {
      reg.register(mkCmd({ name: `c${i}` }));
      reg.recordRecent(`c${i}`);
    }
    expect(reg.serializeRecent()).toHaveLength(8);
    expect(reg.serializeRecent()[0]).toBe('c11');
  });

  it('execute auto-records the recent command on success', async () => {
    reg.register(mkCmd({ name: 'noop' }));
    const { display } = mkDisplay();
    await reg.execute('/noop', { display });
    expect(reg.serializeRecent()).toEqual(['noop']);
  });

  it('setRecent ignores unknown names and preserves order', () => {
    reg.register(mkCmd({ name: 'one' }));
    reg.register(mkCmd({ name: 'two' }));
    reg.setRecent(['unknown', 'two', 'one', 'two']); // dup ignored
    expect(reg.serializeRecent()).toEqual(['two', 'one']);
  });

  it('hidden commands never appear via filter or recent', () => {
    reg.register(mkCmd({ name: 'visible' }));
    reg.register(mkCmd({ name: 'secret', hidden: true }));
    reg.recordRecent('secret');
    const empty = reg.filter('/').map((c) => c.name);
    expect(empty).toEqual(['visible']);
    expect(reg.getRecent().map((c) => c.name)).toEqual([]);
  });
});
