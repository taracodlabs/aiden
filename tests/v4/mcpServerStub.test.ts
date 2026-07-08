import { describe, it, expect } from 'vitest';
import {
  AidenMcpServer,
  AIDEN_MCP_SERVER_TOOLS,
} from '../../core/v4/mcpServerStub';

describe('AidenMcpServer (lightweight stub)', () => {
  it('start() throws a stub error pointing to the real server', async () => {
    const s = new AidenMcpServer({ stdio: true });
    await expect(s.start()).rejects.toThrow(/stub/);
    await expect(s.start()).rejects.toThrow(/core\/v4\/mcp\/server/);
  });

  it('constructor accepts stdio + port options without error', () => {
    expect(() => new AidenMcpServer({ stdio: true })).not.toThrow();
    expect(() => new AidenMcpServer({ port: 7800 })).not.toThrow();
    expect(() => new AidenMcpServer()).not.toThrow();
  });

  it('exposes the planned 10-tool surface', () => {
    expect(AIDEN_MCP_SERVER_TOOLS).toHaveLength(10);
    expect(AIDEN_MCP_SERVER_TOOLS).toEqual([
      'conversations_list',
      'conversation_get',
      'messages_read',
      'attachments_fetch',
      'events_poll',
      'events_wait',
      'messages_send',
      'channels_list',
      'permissions_list_open',
      'permissions_respond',
    ]);
  });

  it('stop() is a no-op and resolves cleanly', async () => {
    const s = new AidenMcpServer();
    await expect(s.stop()).resolves.toBeUndefined();
  });
});
