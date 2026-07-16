/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { Message } from 'node-telegram-bot-api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const gatewayMocks = vi.hoisted(() => ({
  registerChannel: vi.fn(),
  unregisterChannel: vi.fn(),
  routeMessage: vi.fn(async (_message: unknown, delivery?: any) => {
    await delivery?.driver?.deliver('final', { text: 'fixture response' });
    return 'fixture response';
  }),
}));

vi.mock('../../../core/gateway', () => ({ gateway: gatewayMocks }));

import { TelegramAdapter } from '../../../core/channels/telegram';
import { TelegramCommandRouter } from '../../../core/channels/telegram-commands';

class FakeTelegramClient extends EventEmitter {
  readonly getMe = vi.fn(async () => ({ id: 7, is_bot: true, first_name: 'Aiden', username: 'fixture_bot' }));
  readonly getFileStream = vi.fn((_fileId: string) => Readable.from(['fixture bytes']));
  readonly sendMessage = vi.fn(async () => ({ message_id: 1 }));
  readonly sendChatAction = vi.fn(async () => true);
  readonly setMyCommands = vi.fn(async () => true);
  readonly getChatAdministrators = vi.fn(async () => [{ user: { id: 42 } }]);
  readonly stopPolling = vi.fn(async () => { this.polling = false; });
  private polling = true;

  isPolling(): boolean {
    return this.polling;
  }
}

function directMessage(messageId: number, text: string): Message {
  return {
    message_id: messageId,
    date: 1,
    text,
    chat: { id: 100, type: 'private', first_name: 'User' },
    from: { id: 200, is_bot: false, first_name: 'User' },
  };
}

function memoryLogger() {
  const entries: string[] = [];
  const logger = {
    debug: vi.fn((message: string) => entries.push(message)),
    info: vi.fn((message: string) => entries.push(message)),
    warn: vi.fn((message: string) => entries.push(message)),
    error: vi.fn((message: string) => entries.push(message)),
    child: vi.fn(() => logger),
  };
  return { entries, logger };
}

async function startAdapter(client: FakeTelegramClient, options: Record<string, unknown> = {}) {
  const constructor = vi.fn(() => client);
  const adapter = new TelegramAdapter({
    clientFactory: constructor,
    ...options,
  });
  (adapter as any).acquireLocalLock = () => true;
  (adapter as any).releaseLocalLock = () => undefined;
  await adapter.start();
  await Promise.resolve();
  return { adapter, constructor };
}

let home: string;

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'aiden-telegram-compat-'));
  process.env.AIDEN_HOME = home;
  process.env.TELEGRAM_BOT_TOKEN = '123456:fixture-secret-token';
  delete process.env.TELEGRAM_ALLOWED_CHATS;
  delete process.env.TELEGRAM_ALLOWED_GROUPS;
  delete process.env.TELEGRAM_GROUPS_RESPOND_ALL;
  delete process.env.TELEGRAM_TRUST_GROUP_ADMINS;
  delete process.env.TELEGRAM_USER_RATE_LIMIT;
  gatewayMocks.registerChannel.mockClear();
  gatewayMocks.unregisterChannel.mockClear();
  gatewayMocks.routeMessage.mockClear();
  gatewayMocks.routeMessage.mockImplementation(async (_message: unknown, delivery?: any) => {
    await delivery?.driver?.deliver('final', { text: 'fixture response' });
    return 'fixture response';
  });
});

afterEach(() => {
  delete process.env.AIDEN_HOME;
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_ALLOWED_CHATS;
  delete process.env.TELEGRAM_ALLOWED_GROUPS;
  delete process.env.TELEGRAM_GROUPS_RESPOND_ALL;
  delete process.env.TELEGRAM_TRUST_GROUP_ADMINS;
  delete process.env.TELEGRAM_USER_RATE_LIMIT;
  rmSync(home, { recursive: true, force: true });
});

describe('Telegram maintained-client compatibility', () => {
  it('uses the maintained typed package without the legacy request transport', () => {
    const require = createRequire(import.meta.url);
    const entry = require.resolve('node-telegram-bot-api');
    let packageDir = path.dirname(entry);
    while (!path.basename(packageDir).startsWith('node-telegram-bot-api')) {
      const parent = path.dirname(packageDir);
      if (parent === packageDir) throw new Error('package root not found');
      packageDir = parent;
    }
    const manifest = JSON.parse(
      readFileSync(path.join(packageDir, 'package.json'), 'utf8'),
    ) as { version?: string; types?: string; dependencies?: Record<string, string> };

    expect(manifest.version).toMatch(/^1\.2\./);
    expect(manifest.types).toBe('./dist/index.d.ts');
    expect(manifest.dependencies ?? {}).not.toHaveProperty('request');
    expect(manifest.dependencies ?? {}).not.toHaveProperty('@cypress/request');
  });

  it('remains disabled and non-fatal when no token is configured', async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    const client = new FakeTelegramClient();
    const factory = vi.fn(() => client);
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const adapter = new TelegramAdapter({ clientFactory: factory });

    await expect(adapter.start()).resolves.toBeUndefined();

    expect(factory).not.toHaveBeenCalled();
    expect(adapter.getState()).toBe('inactive');
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
    stdout.mockRestore();
    stderr.mockRestore();
  });

  it('preserves polling construction, identity, commands, and shutdown', async () => {
    const client = new FakeTelegramClient();
    const { adapter, constructor } = await startAdapter(client);

    expect(constructor).toHaveBeenCalledWith('123456:fixture-secret-token', {
      polling: {
        interval: 300,
        autoStart: true,
        params: { timeout: 50, allowed_updates: [] },
      },
    });
    expect(client.getMe).toHaveBeenCalledOnce();
    expect(client.setMyCommands).toHaveBeenCalledWith([
      { command: 'help', description: 'Show available commands' },
      { command: 'status', description: 'Bot health check' },
      { command: 'clear', description: "Wipe this chat's memory" },
    ]);
    expect(adapter.getDiagnostics().pollingActive).toBe(true);

    await adapter.stop();

    expect(client.stopPolling).toHaveBeenCalledWith({ cancel: true });
    expect(adapter.getDiagnostics().pollingActive).toBe(false);
    expect(gatewayMocks.unregisterChannel).toHaveBeenCalledWith('telegram');
  });

  it('handles a text update once and preserves outbound reply options', async () => {
    const client = new FakeTelegramClient();
    const { adapter } = await startAdapter(client);
    const message = directMessage(10, 'hello');

    client.emit('message', message);
    client.emit('message', message);

    await vi.waitFor(() => expect(gatewayMocks.routeMessage).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(client.sendMessage).toHaveBeenCalledTimes(1));
    expect(client.sendMessage).toHaveBeenCalledWith(
      '100',
      'fixture response',
      { parse_mode: 'Markdown' },
    );
    await adapter.stop();
  });

  it('enforces direct-chat allowlists before agent execution', async () => {
    process.env.TELEGRAM_ALLOWED_CHATS = '999';
    const client = new FakeTelegramClient();
    const { adapter } = await startAdapter(client);

    client.emit('message', directMessage(11, 'blocked'));

    await vi.waitFor(() => expect(client.sendMessage).toHaveBeenCalledTimes(1));
    expect(gatewayMocks.routeMessage).not.toHaveBeenCalled();
    await adapter.stop();
  });

  it('enforces group rate limits without duplicate execution', async () => {
    process.env.TELEGRAM_GROUPS_RESPOND_ALL = 'true';
    process.env.TELEGRAM_USER_RATE_LIMIT = '1';
    const client = new FakeTelegramClient();
    const { adapter } = await startAdapter(client);
    const groupBase = {
      date: 1,
      chat: { id: -100, type: 'group' as const, title: 'Fixture group' },
      from: { id: 200, is_bot: false, first_name: 'User' },
    };

    client.emit('message', { ...groupBase, message_id: 20, text: 'first' } satisfies Message);
    client.emit('message', { ...groupBase, message_id: 21, text: 'second' } satisfies Message);

    await vi.waitFor(() => expect(gatewayMocks.routeMessage).toHaveBeenCalledTimes(1));
    await adapter.stop();
  });

  it('streams files through the client and keeps sanitized cache names', async () => {
    const client = new FakeTelegramClient();
    const extractPdf = vi.fn(async ({ filePath }: { filePath: string }) => ({
      success: true,
      text: readFileSync(filePath, 'utf8'),
      truncated: false,
    }));
    const { adapter } = await startAdapter(client, { extractPdf });
    const message: Message = {
      message_id: 30,
      date: 1,
      chat: { id: 100, type: 'private', first_name: 'User' },
      from: { id: 200, is_bot: false, first_name: 'User' },
      document: {
        file_id: 'pdf-file-id',
        file_unique_id: 'pdf-unique-id',
        file_name: '../unsafe report?.pdf',
        mime_type: 'application/pdf',
        file_size: 128,
      },
    };

    client.emit('message', message);

    await vi.waitFor(() => expect(extractPdf).toHaveBeenCalledOnce());
    expect(client.getFileStream).toHaveBeenCalledWith('pdf-file-id');
    const filePath = extractPdf.mock.calls[0][0].filePath;
    expect(path.basename(filePath)).toMatch(/^doc_[a-f0-9]{12}_[A-Za-z0-9_. -]+\.pdf$/);
    expect(path.basename(filePath)).not.toMatch(/[\\/?]/);
    expect(filePath.startsWith(path.join(home, 'cache', 'documents'))).toBe(true);
    await adapter.stop();
  });

  it('rejects oversized files before requesting a stream', async () => {
    const client = new FakeTelegramClient();
    const { adapter } = await startAdapter(client);
    const message: Message = {
      message_id: 31,
      date: 1,
      chat: { id: 100, type: 'private', first_name: 'User' },
      from: { id: 200, is_bot: false, first_name: 'User' },
      document: {
        file_id: 'large-pdf',
        file_unique_id: 'large-pdf-unique',
        file_name: 'large.pdf',
        mime_type: 'application/pdf',
        file_size: 21 * 1024 * 1024,
      },
    };

    client.emit('message', message);

    await vi.waitFor(() => expect(client.sendMessage).toHaveBeenCalledOnce());
    expect(client.getFileStream).not.toHaveBeenCalled();
    expect(client.sendMessage.mock.calls[0][1]).toMatch(/PDF too large/);
    await adapter.stop();
  });

  it('redacts token-bearing client errors from logs', async () => {
    const token = process.env.TELEGRAM_BOT_TOKEN!;
    const client = new FakeTelegramClient();
    client.getMe.mockRejectedValueOnce(
      new Error(`request failed https://api.telegram.org/bot${token}/getMe Authorization: ${token}`),
    );
    const { entries, logger } = memoryLogger();
    const { adapter } = await startAdapter(client, { logger });

    expect(adapter.getState()).toBe('inactive');
    expect(entries.join('\n')).not.toContain(token);
    expect(entries.join('\n')).not.toContain('fixture-secret-token');
    expect(entries.join('\n')).toContain('[redacted]');
  });
});

describe('Telegram administrator compatibility', () => {
  it('uses the configured administrator lookup without namespace-style types', async () => {
    process.env.TELEGRAM_TRUST_GROUP_ADMINS = 'true';
    const store = {
      recordAdminAction: vi.fn(),
      setPaused: vi.fn(),
      setAllowedUsers: vi.fn(),
    };
    const fetchGroupAdmins = vi.fn(async () => ['42']);
    const router = new TelegramCommandRouter({ store: store as never, fetchGroupAdmins });
    const message: Message = {
      message_id: 40,
      date: 1,
      text: '/pause',
      chat: { id: -100, type: 'group', title: 'Fixture group' },
      from: { id: 42, is_bot: false, first_name: 'Admin' },
    };

    await expect(router.route(message)).resolves.toEqual({ kind: 'paused', groupId: '-100' });
    expect(fetchGroupAdmins).toHaveBeenCalledWith('-100');
    expect(store.setPaused).toHaveBeenCalledWith('-100', true, '42');
  });
});
