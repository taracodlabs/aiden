// ============================================================
// DevOS — Autonomous AI Execution System
// Copyright (c) 2026 Shiva Deore. All rights reserved.
// ============================================================

// security/browserVault.ts — Playwright-in-Docker with noVNC LiveView.
// Stub for sandbox environment; full implementation committed in Sprint 20.

import Docker from 'dockerode'
import path   from 'path'
import fs     from 'fs'
import { createHash } from 'node:crypto'

// ── Types ──────────────────────────────────────────────────────

export interface BrowserVault {
  taskId:        string
  containerId:   string
  containerName: string
  hostPort:      number
  createdAt:     number
}

// ── Constants ──────────────────────────────────────────────────

const PLAYWRIGHT_IMAGE      = 'mcr.microsoft.com/playwright:v1.40.0-jammy'
const CONTAINER_VNC_WS_PORT = 6080
const HOST_PORT_BASE        = 6100

const ENTRYPOINT_CMD = [
  'sh', '-c',
  [
    'Xvfb :99 -screen 0 1280x900x24 &',
    'export DISPLAY=:99',
    'sleep 1',
    'x11vnc -display :99 -nopw -forever -rfbport 5900 -quiet &',
    `websockify --web /usr/share/novnc 0.0.0.0:${CONTAINER_VNC_WS_PORT} localhost:5900 &`,
    'tail -f /dev/null',
  ].join(' && '),
]

function containerNameForTask(taskId: string): string {
  const safeTaskId = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,47}$/.test(taskId)
    ? taskId
    : `task-${createHash('sha256').update(taskId).digest('hex').slice(0, 12)}`
  return `devos-browser-${safeTaskId}`
}

// ── Persistence ────────────────────────────────────────────────

const WORKSPACE    = path.join(process.cwd(), 'workspace')
const BVAULTS_FILE = path.join(WORKSPACE, 'browser-vaults.json')

function loadPersistedBVaults(): BrowserVault[] {
  try {
    if (!fs.existsSync(BVAULTS_FILE)) return []
    return JSON.parse(fs.readFileSync(BVAULTS_FILE, 'utf-8')) as BrowserVault[]
  } catch { return [] }
}

function savePersistedBVaults(vaults: BrowserVault[]): void {
  fs.mkdirSync(WORKSPACE, { recursive: true })
  fs.writeFileSync(BVAULTS_FILE, JSON.stringify(vaults, null, 2))
}

// ── BrowserVaultManager ───────────────────────────────────────

class BrowserVaultManager {
  private readonly docker  = new Docker()
  private readonly vaults  = new Map<string, BrowserVault>()
  private nextPort         = HOST_PORT_BASE

  constructor() {
    for (const v of loadPersistedBVaults()) {
      this.vaults.set(v.taskId, v)
      if (v.hostPort >= this.nextPort) this.nextPort = v.hostPort + 1
    }
  }

  private allocatePort(): number { return this.nextPort++ }

  private persist(): void {
    savePersistedBVaults(Array.from(this.vaults.values()))
  }

  async createBrowserVault(taskId: string): Promise<BrowserVault> {
    const existing = this.vaults.get(taskId)
    if (existing) return existing

    const containerName = containerNameForTask(taskId)
    const hostPort      = this.allocatePort()

    let container: Docker.Container | undefined
    try {
      container = await this.docker.createContainer({
        name:  containerName,
        Image: PLAYWRIGHT_IMAGE,
        Cmd:   ENTRYPOINT_CMD,
        Env:   ['DISPLAY=:99'],
        ExposedPorts: { [`${CONTAINER_VNC_WS_PORT}/tcp`]: {} },
        HostConfig: {
          PortBindings: {
            [`${CONTAINER_VNC_WS_PORT}/tcp`]: [{ HostPort: String(hostPort) }],
          },
          Memory:     1024 * 1024 * 1024,
          NanoCpus:   1_000_000_000,
          AutoRemove: true,
          ShmSize:    256 * 1024 * 1024,
          CapAdd:     ['SYS_ADMIN'],
        },
      })
      await container.start()
    } catch {
      if (container) {
        try { await container.remove({ force: true }) } catch {}
      }
      throw new Error('[BrowserVault] Failed to create container. Ensure Docker is available.')
    }

    if (!container) throw new Error('[BrowserVault] Failed to create container. Ensure Docker is available.')

    const vault: BrowserVault = {
      taskId, containerId: container.id, containerName, hostPort, createdAt: Date.now(),
    }
    this.vaults.set(taskId, vault)
    this.persist()
    return vault
  }

  getLiveViewUrl(taskId: string): string | null {
    const vault = this.vaults.get(taskId)
    if (!vault) return null
    return `ws://localhost:${vault.hostPort}/websockify`
  }

  isLiveViewAvailable(taskId: string): boolean {
    return this.vaults.has(taskId)
  }

  async destroyBrowserVault(taskId: string): Promise<void> {
    const vault = this.vaults.get(taskId)
    if (vault) {
      try { await this.docker.getContainer(vault.containerId).stop({ t: 5 }) } catch {}
      this.vaults.delete(taskId)
      this.persist()
    }
  }

  listBrowserVaults(): BrowserVault[] {
    return Array.from(this.vaults.values())
  }

  async destroyAll(): Promise<void> {
    const ids = Array.from(this.vaults.keys())
    await Promise.all(ids.map(id => this.destroyBrowserVault(id)))
  }
}

export const browserVault = new BrowserVaultManager()
