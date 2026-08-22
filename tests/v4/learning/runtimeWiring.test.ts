import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Learning runtime wiring source contract', () => {
  const cli = readFileSync(path.resolve(__dirname, '../../../cli/v4/aidenCLI.ts'), 'utf8');
  const daemon = readFileSync(path.resolve(__dirname, '../../../cli/v4/daemonAgentBuilder.ts'), 'utf8');

  it('uses one scoped ledger and provider-neutral retrieval port in the interactive runtime', () => {
    expect(cli).toContain('createLearningAuthority');
    expect(cli).toContain('createLearningContextProvider');
    expect(cli).toContain('learningContextProvider: learningContext');
    expect(cli).toContain('learningScopes');
    expect(cli).toContain('migrateLegacyMemorySnapshot');
  });

  it('passes the same Learning context boundary into daemon-built agents', () => {
    expect(daemon).toContain("learningContextProvider?: AidenAgentOptions['learningContextProvider']");
    expect(daemon).toContain('learningScopes?: AidenAgentOptions[\'learningScopes\']');
    expect(daemon).toContain('learningContextProvider: deps.learningContextProvider');
    expect(daemon).toContain('learningScopes: deps.learningScopes');
  });

  it('never injects learned context into the privileged system-prompt options', () => {
    const start = cli.indexOf('const promptBuilderOptions = {');
    const end = cli.indexOf('\n  };', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(cli.slice(start, end)).not.toContain('learningContext');
  });
});
