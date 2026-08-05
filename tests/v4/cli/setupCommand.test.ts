import { describe, expect, it, vi } from 'vitest';

const runSetupWizard = vi.hoisted(() => vi.fn());

vi.mock('../../../cli/v4/setupWizard', () => ({ runSetupWizard }));

import { setup } from '../../../cli/v4/commands/setup';

describe('/setup live provider lifecycle', () => {
  it('rebuilds the active provider after successful setup without requiring restart', async () => {
    runSetupWizard.mockResolvedValue({
      status: 'configured',
      ran: true,
      config: { model: { provider: 'groq', modelId: 'openai/gpt-oss-120b' } },
      readiness: { state: 'complete' },
    });
    const write = vi.fn();
    const printError = vi.fn();
    const setProvider = vi.fn().mockResolvedValue(undefined);
    const withModalLease = vi.fn(async (_owner: string, run: () => Promise<unknown>) => run());

    await setup.handler({
      paths: { root: 'C:\\aiden-home' },
      display: { write, printError, withModalLease },
      session: { setProvider },
    } as never);

    expect(setProvider).toHaveBeenCalledWith('groq', 'openai/gpt-oss-120b');
    expect(withModalLease).toHaveBeenCalledWith('setup', expect.any(Function));
    expect(write).not.toHaveBeenCalledWith(expect.stringMatching(/restart|\/quit/iu));
    expect(printError).not.toHaveBeenCalled();
  });

  it('preserves the prior live provider when rebuilding the configured adapter fails', async () => {
    runSetupWizard.mockResolvedValue({
      status: 'configured',
      ran: true,
      config: { model: { provider: 'groq', modelId: 'openai/gpt-oss-120b' } },
      readiness: { state: 'complete' },
    });
    const write = vi.fn();
    const printError = vi.fn();
    const setProvider = vi.fn().mockRejectedValue(new Error('readiness failed'));
    const withModalLease = vi.fn(async (_owner: string, run: () => Promise<unknown>) => run());

    await setup.handler({
      paths: { root: 'C:\\aiden-home' },
      display: { write, printError, withModalLease },
      session: { setProvider },
    } as never);

    expect(printError).toHaveBeenCalledWith(
      expect.stringMatching(/configured.*could not activate/iu),
      expect.stringMatching(/previous provider/iu),
    );
    expect(write).not.toHaveBeenCalledWith(expect.stringMatching(/restart/iu));
  });
});
