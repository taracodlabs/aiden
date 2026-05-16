/**
 * v4.4 Phase 3 — dockerSession.ts unit tests.
 *
 * Coverage:
 *   1. Docker-unavailable path: routes to local backend, warns once
 *      per session, never tries to spawn `docker`.
 *   2. _resetDockerSessionForTests wipes state.
 *   3. _inspectDockerSessionsForTests reports the active set.
 *   4. _setDockerAvailableForTests / _clearDockerAvailCacheForTests
 *      give tests deterministic control.
 *
 * NOTE: real container start (docker run -d) is environment-fragile;
 * unit tests stop at the public-API boundary and trust that
 * `localBackendExecute` is already covered by terminal.test.ts.
 * Integration coverage of the docker path itself lives in the smokes,
 * not the vitest gate (which must pass on machines without docker).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  dockerSessionExec,
  reapAllContainers,
  reapSessionContainer,
  _resetDockerSessionForTests,
  _inspectDockerSessionsForTests,
  _setDockerAvailableForTests,
} from '../../../core/v4/dockerSession';
import { _resetSandboxConfigForTests } from '../../../core/v4/sandboxConfig';

interface LoggedMessage { level: 'info' | 'warn' | 'error'; msg: string; }

function makeLogger(): { logs: LoggedMessage[]; log: (lvl: 'info' | 'warn' | 'error', msg: string) => void } {
  const logs: LoggedMessage[] = [];
  return {
    logs,
    log: (level, msg) => { logs.push({ level, msg }); },
  };
}

beforeEach(() => {
  _resetDockerSessionForTests();
  _resetSandboxConfigForTests();
});

describe('dockerSessionExec — Docker unavailable fallback', () => {
  it('routes to local backend and returns backend="local"', async () => {
    _setDockerAvailableForTests(false);
    const { log } = makeLogger();
    const result = await dockerSessionExec(
      { sessionId: 's1', command: process.platform === 'win32' ? 'Write-Output hi' : 'echo hi' },
      { log },
    );
    expect(result.backend).toBe('local');
  });

  it('warns exactly once per session even across multiple calls', async () => {
    _setDockerAvailableForTests(false);
    const { logs, log } = makeLogger();
    for (let i = 0; i < 3; i++) {
      await dockerSessionExec(
        { sessionId: 'warn-session', command: process.platform === 'win32' ? 'Write-Output x' : 'echo x' },
        { log },
      );
    }
    const warnings = logs.filter(
      (l) => l.level === 'warn' && /Docker is not running or unreachable/i.test(l.msg),
    );
    expect(warnings.length).toBe(1);
  });

  it('separate sessions each get their own warning', async () => {
    _setDockerAvailableForTests(false);
    const { logs, log } = makeLogger();
    await dockerSessionExec(
      { sessionId: 'sess-a', command: process.platform === 'win32' ? 'Write-Output a' : 'echo a' },
      { log },
    );
    await dockerSessionExec(
      { sessionId: 'sess-b', command: process.platform === 'win32' ? 'Write-Output b' : 'echo b' },
      { log },
    );
    const warnings = logs.filter(
      (l) => l.level === 'warn' && /Docker is not running or unreachable/i.test(l.msg),
    );
    expect(warnings.length).toBe(2);
  });

  it('does NOT create any container cache entries when falling back', async () => {
    _setDockerAvailableForTests(false);
    await dockerSessionExec(
      { sessionId: 'no-cache', command: 'echo x' },
      {},
    );
    const inspect = _inspectDockerSessionsForTests();
    expect(inspect.count).toBe(0);
  });

  it('records the warned-session set so tests can verify state', async () => {
    _setDockerAvailableForTests(false);
    await dockerSessionExec(
      { sessionId: 's-warn', command: 'echo y' },
      { log: () => undefined },
    );
    const inspect = _inspectDockerSessionsForTests();
    expect(inspect.warnedSessions).toContain('s-warn');
  });

  it('defaults sessionId to "default" when not provided', async () => {
    _setDockerAvailableForTests(false);
    await dockerSessionExec(
      { command: 'echo z' } as { command: string },
      { log: () => undefined },
    );
    const inspect = _inspectDockerSessionsForTests();
    expect(inspect.warnedSessions).toContain('default');
  });
});

describe('reap APIs — no-op when nothing is cached', () => {
  it('reapSessionContainer on unknown session does not throw', async () => {
    await expect(reapSessionContainer('does-not-exist')).resolves.toBeUndefined();
  });

  it('reapAllContainers on empty cache resolves cleanly', async () => {
    await expect(reapAllContainers()).resolves.toBeUndefined();
  });
});

describe('test helpers', () => {
  it('_resetDockerSessionForTests wipes the warned-fallback set', async () => {
    _setDockerAvailableForTests(false);
    await dockerSessionExec(
      { sessionId: 'reset-me', command: 'echo r' },
      { log: () => undefined },
    );
    expect(_inspectDockerSessionsForTests().warnedSessions).toContain('reset-me');
    _resetDockerSessionForTests();
    expect(_inspectDockerSessionsForTests().warnedSessions).toEqual([]);
  });
});
