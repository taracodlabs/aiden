/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/system/systemInfo.ts — `system_info` wrapper.
 *
 * Reads CPU, RAM, OS, free disk, and current user via PowerShell CIM
 * on Windows. On non-Windows platforms it returns a structured
 * payload built from `os` so the tool stays usable cross-platform —
 * v3 was Windows-only.
 *
 * Status: PHASE 7. Read-only.
 */

import os from 'node:os';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

import type { ToolHandler } from '../../../core/v4/toolRegistry';

const execAsync = promisify(exec);

const WINDOWS_PS = `@{ CPU=(Get-CimInstance Win32_Processor).Name; RAM_GB=[math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory/1GB,1); OS=(Get-CimInstance Win32_OperatingSystem).Caption; FreeGB=[math]::Round((Get-PSDrive C).Free/1GB,1); User=$env:USERNAME } | ConvertTo-Json`;

async function readWindows(): Promise<unknown> {
  const { stdout } = await execAsync(WINDOWS_PS, {
    shell: 'powershell.exe',
    timeout: 15_000,
  });
  return JSON.parse(stdout.trim());
}

function readPosix(): Record<string, unknown> {
  const totalMem = os.totalmem();
  return {
    CPU: os.cpus()[0]?.model ?? 'unknown',
    Cores: os.cpus().length,
    RAM_GB: Math.round((totalMem / 1024 ** 3) * 10) / 10,
    OS: `${os.type()} ${os.release()}`,
    Platform: process.platform,
    Arch: process.arch,
    User: os.userInfo().username,
    Hostname: os.hostname(),
  };
}

export const systemInfoTool: ToolHandler = {
  schema: {
    name: 'system_info',
    description:
      'Get system hardware and OS information (CPU, RAM, OS name/version, free disk, current user).',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  category: 'read',
  mutates: false,
  toolset: 'system',
  async execute() {
    try {
      const info =
        process.platform === 'win32' ? await readWindows() : readPosix();
      return { success: true, info };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { success: false, error: message };
    }
  },
};
