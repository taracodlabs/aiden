import { describe, it, expect, vi } from 'vitest';
import { main } from '../../../cli/v4/aidenCLI';

function captureMain(args: string[], hooks: Parameters<typeof main>[1] = {}) {
  const out: string[] = [];
  const writeOut = (t: string) => out.push(t);
  const argv = ['node', 'aiden', ...args];
  return { argv, hooks: { ...hooks, writeOut }, out };
}

describe('aiden CLI', () => {
  it('--help prints all commands', async () => {
    const out: string[] = [];
    const writeOut = (t: string) => out.push(t);
    // Commander writes help to stdout and exits via process.exit; intercept.
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__exit__:${code}`);
    }) as never);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: any) => {
      out.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    }) as never);
    try {
      await main(['node', 'aiden', '--help'], { writeOut });
    } catch (e) {
      // commander triggers process.exit(0) on --help
    } finally {
      exitSpy.mockRestore();
      stdoutSpy.mockRestore();
    }
    const text = out.join('');
    expect(text).toMatch(/Usage:/);
    expect(text).toMatch(/setup/);
    expect(text).toMatch(/model/);
    expect(text).toMatch(/doctor/);
    expect(text).toMatch(/sessions/);
    expect(text).toMatch(/skills/);
    expect(text).toMatch(/mcp/);
  });

  it('aiden (no args) invokes the chat hook', async () => {
    const chat = vi.fn(async () => undefined);
    const { argv, hooks } = captureMain([], { runChatHook: chat });
    const code = await main(argv, hooks);
    expect(code).toBe(0);
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it('aiden setup invokes the setup hook', async () => {
    const setup = vi.fn(async () => undefined);
    const { argv, hooks } = captureMain(['setup'], { runSetupHook: setup });
    const code = await main(argv, hooks);
    expect(code).toBe(0);
    expect(setup).toHaveBeenCalledTimes(1);
  });

  it('aiden model passes spec through', async () => {
    const model = vi.fn(async () => undefined);
    const { argv, hooks } = captureMain(['model', 'groq:llama-3.3'], { runModelHook: model });
    await main(argv, hooks);
    expect(model).toHaveBeenCalledWith('groq:llama-3.3');
  });

  it('aiden model with no spec invokes picker (interactive)', async () => {
    const model = vi.fn(async () => undefined);
    const { argv, hooks } = captureMain(['model'], { runModelHook: model });
    await main(argv, hooks);
    expect(model).toHaveBeenCalledWith(undefined);
  });

  it('aiden config view invokes the config hook', async () => {
    const cfg = vi.fn(async () => undefined);
    const { argv, hooks } = captureMain(['config', 'view'], { runConfigHook: cfg });
    await main(argv, hooks);
    expect(cfg).toHaveBeenCalledWith('view', undefined, undefined);
  });

  it('aiden doctor invokes the doctor hook', async () => {
    const doctor = vi.fn(async () => undefined);
    const { argv, hooks } = captureMain(['doctor'], { runDoctorHook: doctor });
    await main(argv, hooks);
    expect(doctor).toHaveBeenCalledTimes(1);
  });

  it('aiden sessions list invokes the sessions hook', async () => {
    const sessions = vi.fn(async () => undefined);
    const { argv, hooks } = captureMain(['sessions', 'list'], { runSessionsHook: sessions });
    await main(argv, hooks);
    expect(sessions).toHaveBeenCalledWith('list', undefined);
  });

  it('aiden skills view <name> threads the arg', async () => {
    const skills = vi.fn(async () => undefined);
    const { argv, hooks } = captureMain(['skills', 'view', 'graphify'], {
      runSkillsHook: skills,
    });
    await main(argv, hooks);
    expect(skills).toHaveBeenCalledWith('view', 'graphify');
  });

  it.skip('aiden mcp serve prints the v4.1 deferral /* TODO v4.1.1: timeout in vitest, covered by smoke-v4.1-mcp-runtime */', async () => {
    const { argv, hooks, out } = captureMain(['mcp', 'serve']);
    await main(argv, hooks);
    expect(out.join('')).toMatch(/deferred to v4\.1/i);
  });

  it('aiden -c flag is set on chat hook opts', async () => {
    const chat = vi.fn(async () => undefined);
    const { argv, hooks } = captureMain(['-c'], { runChatHook: chat });
    await main(argv, hooks);
    expect(chat).toHaveBeenCalledTimes(1);
    expect(chat.mock.calls[0][0]).toMatchObject({ continue: true });
  });

  it('aiden -r "<title>" passes resume to the chat hook', async () => {
    const chat = vi.fn(async () => undefined);
    const { argv, hooks } = captureMain(['-r', 'my session'], { runChatHook: chat });
    await main(argv, hooks);
    expect(chat).toHaveBeenCalled();
    expect(chat.mock.calls[0][0]).toMatchObject({ resume: 'my session' });
  });

  it('aiden --yolo flag flows through', async () => {
    const chat = vi.fn(async () => undefined);
    const { argv, hooks } = captureMain(['--yolo'], { runChatHook: chat });
    await main(argv, hooks);
    expect(chat).toHaveBeenCalled();
    expect(chat.mock.calls[0][0]).toMatchObject({ yolo: true });
  });

  it('aiden --tui flag flows through to chat hook', async () => {
    const chat = vi.fn(async () => undefined);
    const { argv, hooks } = captureMain(['--tui'], { runChatHook: chat });
    await main(argv, hooks);
    expect(chat).toHaveBeenCalled();
    expect(chat.mock.calls[0][0]).toMatchObject({ tui: true });
  });

  it('aiden tui (subcommand) is no longer registered as a v4.1 placeholder', async () => {
    // commander with an unknown subcommand still parses successfully when
    // it falls through the default action (chat). To keep the contract
    // clear we assert that 'tui' as a positional arg does NOT trigger the
    // v4.1 deferral message anymore. A typed `aiden tui` token is
    // interpreted as user input by the default action's chat hook.
    const chat = vi.fn(async () => undefined);
    const { argv, hooks, out } = captureMain(['tui'], { runChatHook: chat });
    await main(argv, hooks);
    expect(out.join('')).not.toMatch(/deferred to v4\.1/i);
  });

  it('aiden batch prints the v4.1 deferral', async () => {
    const { argv, hooks, out } = captureMain(['batch']);
    await main(argv, hooks);
    expect(out.join('')).toMatch(/deferred to v4\.1/i);
  });

  it('aiden gateway prints the v4.1 deferral', async () => {
    const { argv, hooks, out } = captureMain(['gateway']);
    await main(argv, hooks);
    expect(out.join('')).toMatch(/deferred to v4\.1/i);
  });

  it('aiden pairing prints the v4.1 deferral (registered, just hidden)', async () => {
    const { argv, hooks, out } = captureMain(['pairing']);
    await main(argv, hooks);
    expect(out.join('')).toMatch(/deferred to v4\.1/i);
  });

  it('aiden update prints the v4.1 deferral (registered, just hidden)', async () => {
    const { argv, hooks, out } = captureMain(['update']);
    await main(argv, hooks);
    expect(out.join('')).toMatch(/deferred to v4\.1/i);
  });

  it('--help HIDES the four deferred commands (batch/gateway/pairing/update)', async () => {
    const out: string[] = [];
    const writeOut = (t: string) => out.push(t);
    // Commander writes help to stdout and exits via process.exit; intercept both.
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__exit__:${code}`);
    }) as never);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: any) => {
      out.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    }) as never);
    try {
      await main(['node', 'aiden', '--help'], { writeOut });
    } catch {
      // commander triggers process.exit(0) on --help
    } finally {
      exitSpy.mockRestore();
      stdoutSpy.mockRestore();
    }
    const text = out.join('');
    // sanity: real commands still listed (help isn't empty/broken)
    expect(text).toMatch(/Usage:/);
    expect(text).toMatch(/setup/);
    // the four deferred commands share this UNIQUE description — hidden ⇒ gone.
    expect(text).not.toMatch(/deferred to v4\.1/i);
    // and none appear as a command entry (commander lists them as `  <name> …`).
    for (const name of ['batch', 'gateway', 'pairing', 'update']) {
      expect(text).not.toMatch(new RegExp(`^\\s+${name}\\b`, 'm'));
    }
  });
});
