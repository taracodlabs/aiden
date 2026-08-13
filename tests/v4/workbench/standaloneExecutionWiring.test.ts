import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('standalone Workbench execution wiring', () => {
  const source = () => fs.readFileSync(path.resolve('cli/v4/aidenCLI.ts'), 'utf8');
  const webSource = () => {
    const value = source();
    return value.slice(value.indexOf(".command('web')"), value.indexOf(".command('setup')"));
  };

  it('builds the real runtime and hosts the existing dispatcher inside aiden web', () => {
    const web = webSource();
    expect(web).toContain('buildAgentRuntime({ headless: true }, opts)');
    expect(web).toContain('createWorkbenchExecutionHost({');
    expect(web).toContain('agentBuilder: workbenchRuntime.daemonAgentBuilder');
    expect(web).toContain('executionHost.start()');
    expect(web).not.toContain('start the daemon (AIDEN_DAEMON=1)');
  });

  it('drains the execution host before closing durable stores', () => {
    const web = webSource();
    expect(web.indexOf('await executionHost.stop()')).toBeGreaterThan(0);
    expect(web.indexOf('await executionHost.stop()')).toBeLessThan(web.indexOf('await bridge.close()'));
    expect(web.indexOf('await bridge.close()')).toBeLessThan(web.indexOf('closeDaemonDb(dbPath)'));
  });
});
