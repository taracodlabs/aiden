import { confirm, select, input } from '@inquirer/prompts';
import { InputAuthority, type RawStdinLike } from '../../../cli/v4/inputAuthority';

type Snapshot = {
  paused: boolean;
  flowing: boolean | null;
  raw: boolean;
  data: number;
  keypress: number;
  readable: number;
  sigint: number;
};

const scenario = process.argv[2] ?? 'complete';
const stdin = process.stdin as unknown as RawStdinLike & NodeJS.ReadStream;

function snapshot(): Snapshot {
  return {
    paused: stdin.isPaused(),
    flowing: stdin.readableFlowing,
    raw: stdin.isRaw === true,
    data: stdin.listenerCount('data'),
    keypress: stdin.listenerCount('keypress'),
    readable: stdin.listenerCount('readable'),
    sigint: stdin.listenerCount('SIGINT'),
  };
}

function diagnostic(name: string, value: unknown): void {
  process.stdout.write(`\n[P2A:${name}]${JSON.stringify(value)}\n`);
}

async function main(): Promise<void> {
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    throw new Error('The input-authority regression requires a real TTY');
  }

  const authority = new InputAuthority({ stdin });
  let rawLine = '';
  const rawLines: string[] = [];
  let normalResolve!: (line: string) => void;
  const normalLine = new Promise<string>((resolve) => { normalResolve = resolve; });
  let restoreCount = 0;

  const unmount = authority.mountRawOwner('during_turn', (str, key) => {
    if (key.name === 'return') {
      rawLines.push(rawLine);
      normalResolve(rawLine);
      rawLine = '';
      return;
    }
    if (typeof str === 'string' && !key.ctrl && !key.meta) rawLine += str;
  });
  const baseline = snapshot();
  let firstCleanup!: Snapshot;
  let secondCleanup!: Snapshot;

  if (scenario === 'skill-normal') {
    const first = await authority.runExclusive('skill_prompt', async (modalInput) => {
      const answer = await confirm(
        { message: 'Save this as a reusable skill?', default: false },
        { input: modalInput },
      );
      firstCleanup = snapshot();
      diagnostic('FIRST_CLEANUP', firstCleanup);
      return answer;
    });
    restoreCount += 1;
    const firstRestored = snapshot();
    diagnostic('FIRST_RESTORED', firstRestored);
    const leakedBeforeNormal = [...rawLines, rawLine];
    diagnostic('NORMAL_READY', { owner: authority.currentOwner() });
    const typedAfterward = await normalLine;
    diagnostic('RESULT', {
      scenario, first, baseline, firstCleanup, firstRestored,
      leakedBeforeNormal, typedAfterward, rawLines,
      owner: authority.currentOwner(), restoreCount,
    });
    unmount();
    return;
  }

  const first = await authority.runExclusive(
    scenario === 'approval-clarify' ? 'approval' : 'clarify',
    async (modalInput) => {
    const answer = await select({
      message: scenario === 'approval-clarify'
        ? 'Decision'
        : 'Which format would you like for the report?',
      choices: scenario === 'approval-clarify'
        ? [{ name: 'Allow', value: 'allow' }, { name: 'Deny', value: 'deny' }]
        : [{ name: 'Markdown', value: 'Markdown' }, { name: 'Plain text', value: 'Plain text' }],
    }, { input: modalInput });
    firstCleanup = snapshot();
    diagnostic('FIRST_CLEANUP', firstCleanup);
    return answer;
    },
  );
  restoreCount += 1;
  const firstRestored = snapshot();
  diagnostic('FIRST_RESTORED', firstRestored);

  const turn = new AbortController();
  const second = await authority.runExclusive('clarify', async (modalInput) => {
    try {
      const answer = await input(
        { message: scenario === 'approval-clarify'
          ? 'Clarification after approval'
          : 'What topic should the Markdown report cover?' },
        { input: modalInput },
      );
      secondCleanup = snapshot();
      diagnostic('SECOND_CLEANUP', secondCleanup);
      return answer;
    } catch {
      secondCleanup = snapshot();
      diagnostic('SECOND_CLEANUP', secondCleanup);
      return null;
    }
  });
  restoreCount += 1;
  const secondRestored = snapshot();
  diagnostic('SECOND_RESTORED', secondRestored);
  const leakedBeforeNormal = [...rawLines, rawLine];

  diagnostic('NORMAL_READY', { owner: authority.currentOwner() });
  const typedAfterward = await normalLine;

  diagnostic('RESULT', {
    scenario,
    first,
    second,
    baseline,
    firstCleanup,
    secondCleanup,
    firstRestored,
    secondRestored,
    leakedBeforeNormal,
    typedAfterward,
    rawLines,
    owner: authority.currentOwner(),
    restoreCount,
    turnAborted: turn.signal.aborted,
  });
  unmount();
}

main().then(
  () => process.exit(0),
  (error) => {
    diagnostic('ERROR', { message: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  },
);
