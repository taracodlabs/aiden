import { Writable } from 'node:stream';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ChatSession, type ChatSessionOptions } from '../../../cli/v4/chatSession';
import { CommandRegistry } from '../../../cli/v4/commandRegistry';
import { Display } from '../../../cli/v4/display';
import { SkinEngine } from '../../../cli/v4/skinEngine';
import { resolveConfiguredAutonomyLevel } from '../../../core/v4/config';
import { ApprovalEngine } from '../../../moat/approvalEngine';
import { resolveAutonomyPolicy, type AutonomyLevel } from '../../../moat/autonomy';

const stringWidth: (value: string) => number = require('string-width');

function stripAnsi(value: string): string {
  return value.replace(
    // eslint-disable-next-line no-control-regex
    /\x1b\[[0-?]*[ -/]*[@-~]/g,
    '',
  );
}

function captureDisplay(columns: number): { display: Display; chunks: string[] } {
  const chunks: string[] = [];
  const out = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  }) as unknown as NodeJS.WriteStream;
  const err = new Writable({
    write(_chunk, _encoding, callback) { callback(); },
  }) as unknown as NodeJS.WriteStream;
  Object.assign(out, { isTTY: true, columns });
  Object.assign(err, { isTTY: true, columns });
  const display = new Display({
    skin: new SkinEngine({ forceMono: true }),
    stdout: out,
    stderr: err,
  });
  return { display, chunks };
}

function buildSession(
  level: AutonomyLevel,
  columns = 100,
): { session: ChatSession; chunks: string[] } {
  const { display, chunks } = captureDisplay(columns);
  const approvalEngine = new ApprovalEngine('smart', {});
  approvalEngine.setAutonomyPolicy(resolveAutonomyPolicy(level, {
    workspaceRoots: [process.cwd()],
  }));

  const options: ChatSessionOptions = {
    agent: {} as never,
    display,
    commandRegistry: new CommandRegistry(),
    callbacks: {} as never,
    sessionManager: {} as never,
    approvalEngine,
    skin: new SkinEngine({ forceMono: true }),
    toolRegistry: { list: () => [] } as never,
    skillLoader: { list: async () => [] } as never,
    resolver: {} as never,
    config: {} as never,
    initialProviderId: 'groq',
    initialModelId: 'llama-3.3-70b-versatile',
    installSignalHandler: false,
  };
  return { session: new ChatSession(options), chunks };
}

let priorStdoutTty: boolean | undefined;

beforeAll(() => {
  priorStdoutTty = process.stdout.isTTY;
  (process.stdout as unknown as { isTTY: boolean }).isTTY = true;
});

afterAll(() => {
  (process.stdout as unknown as { isTTY: boolean | undefined }).isTTY = priorStdoutTty;
});

describe('startup trust chrome', () => {
  it.each<AutonomyLevel>(['Observer', 'Assistant', 'Partner'])(
    'renders the active %s policy exactly once without an auto fallback',
    async (level) => {
      const { session, chunks } = buildSession(level);
      await session.renderStartupCard();
      const output = stripAnsi(chunks.join(''));
      const declarations = output.match(/trust\s+(?:Observer|Assistant|Partner)\b/gi) ?? [];

      expect(declarations).toHaveLength(1);
      expect(declarations[0]).toContain(level);
      expect(output).not.toMatch(/mode\s+auto/i);
      expect(output).not.toMatch(/auto\s*[—-]\s*auto/i);
      if (level !== 'Partner') expect(output).not.toMatch(/trust\s+Partner/i);
    },
  );

  it('renders the policy resolved from persisted configuration', async () => {
    const config = {
      getValue: (key: string, fallback: unknown) =>
        key === 'agent.autonomy' ? 'Observer' : fallback,
    } as never;
    const persistedLevel = resolveConfiguredAutonomyLevel(config);
    const { session, chunks } = buildSession(persistedLevel);

    await session.renderStartupCard();
    const output = stripAnsi(chunks.join(''));
    expect(output).toMatch(/trust\s+Observer\b/i);
    expect(output).not.toMatch(/mode\s+auto|trust\s+Partner/i);
  });
});

describe('responsive startup status rows', () => {
  it.each([
    { columns: 50, expectedLines: 2, tier: 'narrow' },
    { columns: 79, expectedLines: 2, tier: 'narrow' },
    { columns: 80, expectedLines: 2, tier: 'medium' },
    { columns: 100, expectedLines: 2, tier: 'medium' },
    { columns: 140, expectedLines: 1, tier: 'wide' },
  ])('fits the $tier layout at $columns columns', ({ columns, expectedLines, tier }) => {
    const { display } = captureDisplay(columns);
    const rendered = display.statusPillsRow({
      coreOnline: true,
      trust: 'Partner',
      model: 'llama-3.3-70b-versatile',
      memoryActive: true,
      providerOk: true,
      version: '4.14.9',
    });
    const lines = rendered.split('\n');
    const plain = stripAnsi(rendered);

    expect(lines).toHaveLength(expectedLines);
    for (const line of lines) {
      expect(stringWidth(stripAnsi(line))).toBeLessThanOrEqual(columns);
    }
    expect(plain).toMatch(/core\s+online/i);
    expect(plain).toMatch(/trust\s+Partner/i);
    expect(plain).toMatch(/model\s+llama/i);

    if (tier === 'narrow') {
      expect(plain).not.toMatch(/memory\s+(?:active|off)/i);
      expect(plain).not.toContain('v4.14.9');
    } else {
      expect(plain).toMatch(/memory\s+active/i);
      expect(plain).toContain('v4.14.9');
    }
  });
});
