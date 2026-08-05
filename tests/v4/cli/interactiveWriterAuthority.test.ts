import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../../..');
const interactiveAdapters = [
  'cli/v4/chatSession.ts',
  'cli/v4/callbacks.ts',
  'cli/v4/display/progressBar.ts',
  'cli/v4/commands/modelPicker.ts',
  'cli/v4/frame/runtime.ts',
];
const unownedWriter = /process\.(?:stdout|stderr)\.write|console\.(?:log|warn|error)|\.(?:cursorTo|moveCursor|clearLine|clearScreenDown)\s*\(/u;

describe('interactive terminal writer authority', () => {
  it('keeps session, progress, callback, picker and frame adapters free of direct terminal writers', () => {
    for (const relative of interactiveAdapters) {
      const source = readFileSync(resolve(root, relative), 'utf8');
      expect(source, relative).not.toMatch(unownedWriter);
    }
  });

  it('routes setup and picker through named exclusive modal leases', () => {
    const setup = readFileSync(resolve(root, 'cli/v4/commands/setup.ts'), 'utf8');
    const model = readFileSync(resolve(root, 'cli/v4/commands/model.ts'), 'utf8');
    const callbacks = readFileSync(resolve(root, 'cli/v4/callbacks.ts'), 'utf8');
    expect(setup).toContain("withModalLease('setup'");
    expect(model).toContain("withModalLease('model-picker'");
    expect(callbacks).toContain("withModalLease('approval'");
  });
});
