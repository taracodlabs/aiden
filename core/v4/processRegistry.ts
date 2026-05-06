/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/processRegistry.ts — Aiden v4.0.0
 *
 * Background-process registry. Long-running commands (dev servers,
 * builds, watchers) the agent kicks off live here so the loop can
 * spawn them, stream their output back later, and reap them on
 * shutdown. Synchronous one-shot commands stay in the `shell_exec`
 * tool — only background work (`process_spawn`) lands in the
 * registry.
 *
 * Hermes reference: hermes-agent/tools/process_registry.py — but
 * Aiden's surface is much smaller. Hermes wraps multiple sandbox
 * environments (local, Docker, SSH, Modal); v4 ships local-only
 * here and routes Docker through `shell_exec` instead.
 *
 * Status: PHASE 8.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export interface ProcessHandle {
  id: string;
  command: string;
  pid: number;
  startedAt: number;
  status: 'running' | 'exited' | 'killed';
  exitCode?: number;
  exitedAt?: number;
}

interface Slot {
  handle: ProcessHandle;
  child: ChildProcess;
  log: string[];
  waiters: Array<(h: ProcessHandle) => void>;
}

const MAX_LOG_LINES = 1000;

export interface SpawnOpts {
  cwd?: string;
  env?: Record<string, string>;
  /** When `true` (default), run the command via the platform shell
   *  (PowerShell on Windows, bash on POSIX). When `false`, the first
   *  whitespace-separated token is the executable; the rest are
   *  argv. */
  shell?: boolean;
}

export class ProcessRegistry {
  private readonly slots = new Map<string, Slot>();

  spawn(command: string, opts: SpawnOpts = {}): ProcessHandle {
    const id = randomUUID();
    const useShell = opts.shell !== false;
    const isWin = process.platform === 'win32';

    let child: ChildProcess;
    if (useShell) {
      if (isWin) {
        child = spawn('powershell.exe', ['-NoProfile', '-Command', command], {
          cwd: opts.cwd,
          env: { ...process.env, ...(opts.env ?? {}) },
        });
      } else {
        child = spawn('bash', ['-lc', command], {
          cwd: opts.cwd,
          env: { ...process.env, ...(opts.env ?? {}) },
        });
      }
    } else {
      const parts = command.split(/\s+/).filter(Boolean);
      const [exe, ...args] = parts;
      child = spawn(exe, args, {
        cwd: opts.cwd,
        env: { ...process.env, ...(opts.env ?? {}) },
      });
    }

    const handle: ProcessHandle = {
      id,
      command,
      pid: child.pid ?? -1,
      startedAt: Date.now(),
      status: 'running',
    };
    const slot: Slot = { handle, child, log: [], waiters: [] };
    this.slots.set(id, slot);

    const onData = (chunk: Buffer) => {
      const text = chunk.toString();
      for (const line of text.split(/\r?\n/)) {
        if (line.length === 0) continue;
        slot.log.push(line);
      }
      while (slot.log.length > MAX_LOG_LINES) slot.log.shift();
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);

    child.on('exit', (code, signal) => {
      handle.exitedAt = Date.now();
      handle.exitCode = typeof code === 'number' ? code : undefined;
      handle.status = signal === 'SIGKILL' || signal === 'SIGTERM'
        ? 'killed'
        : 'exited';
      const waiters = slot.waiters.splice(0);
      for (const w of waiters) w(handle);
    });

    child.on('error', (err) => {
      slot.log.push(`[spawn-error] ${err.message}`);
      handle.exitedAt = Date.now();
      handle.exitCode = -1;
      handle.status = 'exited';
      const waiters = slot.waiters.splice(0);
      for (const w of waiters) w(handle);
    });

    return handle;
  }

  list(): ProcessHandle[] {
    return [...this.slots.values()].map((s) => ({ ...s.handle }));
  }

  get(id: string): ProcessHandle | null {
    const slot = this.slots.get(id);
    return slot ? { ...slot.handle } : null;
  }

  readLog(id: string, lines = 100): string[] {
    const slot = this.slots.get(id);
    if (!slot) return [];
    if (lines <= 0) return [];
    return slot.log.slice(-lines);
  }

  kill(id: string, signal: NodeJS.Signals = 'SIGTERM'): boolean {
    const slot = this.slots.get(id);
    if (!slot) return false;
    if (slot.handle.status !== 'running') return false;
    try {
      return slot.child.kill(signal);
    } catch {
      return false;
    }
  }

  waitFor(id: string, timeoutMs?: number): Promise<ProcessHandle> {
    const slot = this.slots.get(id);
    if (!slot) {
      return Promise.reject(new Error(`Unknown process id: ${id}`));
    }
    if (slot.handle.status !== 'running') {
      return Promise.resolve({ ...slot.handle });
    }
    return new Promise<ProcessHandle>((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null;
      const finish = (h: ProcessHandle) => {
        if (timer) clearTimeout(timer);
        resolve({ ...h });
      };
      slot.waiters.push(finish);
      if (timeoutMs && timeoutMs > 0) {
        timer = setTimeout(() => {
          const idx = slot.waiters.indexOf(finish);
          if (idx >= 0) slot.waiters.splice(idx, 1);
          reject(new Error(`waitFor timeout after ${timeoutMs}ms`));
        }, timeoutMs);
      }
    });
  }

  cleanup(): void {
    for (const slot of this.slots.values()) {
      if (slot.handle.status === 'running') {
        try { slot.child.kill('SIGKILL'); } catch { /* ignore */ }
        slot.handle.status = 'killed';
        slot.handle.exitedAt = Date.now();
      }
    }
  }
}
