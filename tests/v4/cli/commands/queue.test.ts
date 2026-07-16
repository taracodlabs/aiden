import { describe, expect, it, vi } from 'vitest';
import { queue } from '../../../../cli/v4/commands/queue';

describe('/queue', () => {
  it('renders a bounded single-line preview without mutating stored messages', async () => {
    const stored = '  first line\n\n\tsecond line with trailing space  ';
    const writes: string[] = [];
    const listQueue = vi.fn(() => [stored]);
    const display = {
      info: vi.fn(),
      write: vi.fn((text: string) => { writes.push(text); }),
      dim: vi.fn(),
      success: vi.fn(),
      warn: vi.fn(),
    };

    await queue.handler({
      args: [],
      display,
      session: { listQueue, clearQueue: vi.fn(() => 0) },
    } as never);
    await queue.handler({
      args: [],
      display,
      session: { listQueue, clearQueue: vi.fn(() => 0) },
    } as never);

    expect(writes).toHaveLength(2);
    expect(writes[0]).not.toContain('\n\n');
    expect(writes[0].split('\n')).toHaveLength(2);
    expect(writes[0].length).toBeLessThanOrEqual(106);
    expect(listQueue()).toEqual([stored]);
  });
});
