/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dockerConstructor: vi.fn(),
  createContainer: vi.fn(),
  getContainer: vi.fn(),
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock('dockerode', () => ({
  default: class DockerClient {
    constructor(...args: unknown[]) {
      mocks.dockerConstructor(...args);
    }

    createContainer(options: unknown) {
      return mocks.createContainer(options);
    }

    getContainer(id: string) {
      return mocks.getContainer(id);
    }
  },
}));

vi.mock('node:fs', () => ({
  default: {
    existsSync: mocks.existsSync,
    readFileSync: mocks.readFileSync,
    mkdirSync: mocks.mkdirSync,
    writeFileSync: mocks.writeFileSync,
  },
}));

async function loadVault() {
  return (await import('../../../security/browserVault')).browserVault;
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.existsSync.mockReturnValue(false);
});

describe('BrowserVault Docker client configuration', () => {
  it('uses Dockerode local/default socket resolution without a supplied host', async () => {
    await loadVault();

    expect(mocks.dockerConstructor).toHaveBeenCalledTimes(1);
    expect(mocks.dockerConstructor).toHaveBeenCalledWith();
  });

  it('passes a structured container configuration with fixed command and limits', async () => {
    const start = vi.fn(async () => undefined);
    mocks.createContainer.mockResolvedValue({ id: 'container-1', start });
    const vault = await loadVault();

    await vault.createBrowserVault('api-fallback-123');

    expect(mocks.createContainer).toHaveBeenCalledTimes(1);
    const options = mocks.createContainer.mock.calls[0][0];
    expect(options).toMatchObject({
      name: 'devos-browser-api-fallback-123',
      Image: 'mcr.microsoft.com/playwright:v1.40.0-jammy',
      Cmd: ['sh', '-c', expect.any(String)],
      Env: ['DISPLAY=:99'],
      ExposedPorts: { '6080/tcp': {} },
      HostConfig: {
        PortBindings: { '6080/tcp': [{ HostPort: '6100' }] },
        Memory: 1024 * 1024 * 1024,
        NanoCpus: 1_000_000_000,
        AutoRemove: true,
        ShmSize: 256 * 1024 * 1024,
        CapAdd: ['SYS_ADMIN'],
      },
    });
    expect(options.HostConfig).not.toHaveProperty('Binds');
    expect(options.HostConfig).not.toHaveProperty('Mounts');
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('keeps generated container names within Docker name syntax', async () => {
    mocks.createContainer.mockResolvedValue({
      id: 'container-safe-name',
      start: vi.fn(async () => undefined),
    });
    const vault = await loadVault();

    await vault.createBrowserVault('../unsafe task / name?token=value');

    const name = mocks.createContainer.mock.calls[0][0].name as string;
    expect(name).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/);
    expect(name).not.toContain('token=value');
  });
});

describe('BrowserVault lifecycle and failure handling', () => {
  it('starts once, reuses the vault, then stops it during cleanup', async () => {
    const start = vi.fn(async () => undefined);
    const stop = vi.fn(async () => undefined);
    mocks.createContainer.mockResolvedValue({ id: 'container-2', start });
    mocks.getContainer.mockReturnValue({ stop });
    const vault = await loadVault();

    const first = await vault.createBrowserVault('api-fallback-456');
    const second = await vault.createBrowserVault('api-fallback-456');
    await vault.destroyBrowserVault('api-fallback-456');

    expect(second).toBe(first);
    expect(mocks.createContainer).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(mocks.getContainer).toHaveBeenCalledWith('container-2');
    expect(stop).toHaveBeenCalledWith({ t: 5 });
    expect(vault.listBrowserVaults()).toEqual([]);
  });

  it('removes a created container when startup fails', async () => {
    const remove = vi.fn(async () => undefined);
    mocks.createContainer.mockResolvedValue({
      id: 'container-3',
      start: vi.fn(async () => { throw new Error('startup failed'); }),
      remove,
    });
    const vault = await loadVault();

    await expect(vault.createBrowserVault('api-fallback-789')).rejects.toThrow(
      'Failed to create container',
    );
    expect(remove).toHaveBeenCalledWith({ force: true });
    expect(vault.listBrowserVaults()).toEqual([]);
  });

  it('does not expose Docker endpoint or credential details on daemon failure', async () => {
    mocks.createContainer.mockRejectedValue(
      new Error('connect npipe:////./pipe/private?token=secret-value'),
    );
    const vault = await loadVault();

    const error = await vault.createBrowserVault('api-fallback-999').catch((value) => value);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe(
      '[BrowserVault] Failed to create container. Ensure Docker is available.',
    );
    expect(error.message).not.toMatch(/npipe|token|secret-value/i);
    expect(vault.listBrowserVaults()).toEqual([]);
  });

  it('destroying an unknown vault remains a non-fatal no-op', async () => {
    const vault = await loadVault();

    await expect(vault.destroyBrowserVault('missing')).resolves.toBeUndefined();
    expect(mocks.getContainer).not.toHaveBeenCalled();
  });
});
