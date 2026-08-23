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
    expect(web).toContain('jobEngineOverride: jobEngine');
    expect(web).toContain('actionAuthorityOverride: actionAuthority');
    expect(web).toContain('createWorkbenchExecutionHost({');
    expect(web).toContain('agentBuilder: workbenchRuntime.daemonAgentBuilder');
    expect(web).toContain('executionHost.start()');
    expect(web).not.toContain('start the daemon (AIDEN_DAEMON=1)');
  });

  it('keeps setup available without admitting work when no provider is configured', () => {
    const web = webSource();
    const runtimeBuild = web.indexOf('workbenchRuntime = await buildAgentRuntime');
    const hostGuard = web.indexOf('if (!workbenchRuntime.exploreMode)', runtimeBuild);
    const hostCreate = web.indexOf('executionHost = createWorkbenchExecutionHost', hostGuard);
    const setupAuthority = web.indexOf('const providerSetup = workbenchRuntime', hostCreate);

    expect(web).toContain('allowUnconfiguredRecovery: true');
    expect(runtimeBuild).toBeGreaterThan(0);
    expect(hostGuard).toBeGreaterThan(runtimeBuild);
    expect(hostCreate).toBeGreaterThan(hostGuard);
    expect(setupAuthority).toBeGreaterThan(hostCreate);
    expect(web).toContain('enqueue: executionHost ? enqueue : undefined');
  });

  it('binds the Workbench runtime tool registry to the same durable authorities as the execution host', () => {
    const value = source();
    const runtimeBuild = value.slice(
      value.indexOf('export async function buildAgentRuntime('),
      value.indexOf('export interface AgentRuntime'),
    );
    expect(runtimeBuild).toMatch(
      /opts\.jobEngineOverride\s*\?\?\s*createJobEngine\(\{\s*db:\s*replDb,\s*skillIntelligence:\s*skillIntelligenceOptions,\s*\}\)/s,
    );
    expect(runtimeBuild).toContain('opts.actionAuthorityOverride ?? createActionAuthority({ db: replDb, jobEngine })');

    const web = webSource();
    expect(web).toContain('jobEngineOverride: jobEngine');
    expect(web).toContain('actionAuthorityOverride: actionAuthority');
    expect(web).toContain('jobEngine,');
    expect(web).toContain('approvalAuthority: actionAuthority');
    expect(web).toContain('jobControlAuthority,');
  });

  it('drains the execution host before closing durable stores', () => {
    const web = webSource();
    expect(web.indexOf('await executionHost.stop()')).toBeGreaterThan(0);
    expect(web.indexOf('await executionHost.stop()')).toBeLessThan(web.indexOf('await bridge.close()'));
    expect(web.indexOf('await bridge.close()')).toBeLessThan(web.indexOf('closeDaemonDb(dbPath)'));
  });
});
