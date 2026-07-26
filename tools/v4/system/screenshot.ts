/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/system/screenshot.ts — `screenshot` tool.
 *
 * Captures the full desktop and writes it as a PNG to
 * `<aidenHome>/screenshots/<timestamp>.png`. Returns the absolute path
 * in `path` so a Telegram / Discord channel adapter can attach the
 * file directly without a separate file_read round-trip.
 *
 * Privacy note (Phase v4.1.2-followup-3): this tool reads what is
 * currently visible on the screen — anything in front of the user.
 * The tool description says so explicitly so users know what they're
 * approving when the model invokes it.
 *
 * Implementation: PowerShell-only, no native dependency. Uses
 * `System.Windows.Forms.Screen` + `System.Drawing.Bitmap` /
 * `Graphics.CopyFromScreen()` — both ship with .NET on every modern
 * Windows install. Cross-platform fallback returns a structured error.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { ToolHandler } from '../../../core/v4/toolRegistry';
import { runPowerShell, windowsOnlyError, isWindows } from './_psHelpers';

/**
 * Build the PowerShell capture script. The bitmap dimensions come from
 * `Screen::PrimaryScreen.Bounds` so we get the actual primary-monitor
 * resolution, not a hardcoded value. SaveAs PNG to keep losslessness
 * — file size on a 4K screen is ~4-8 MB which is fine for chat.
 */
function buildScreenshotPs(outPath: string): string {
  const psQuoted = outPath.replace(/'/g, "''"); // PowerShell single-quote escape
  return [
    'Add-Type -AssemblyName System.Windows.Forms;',
    'Add-Type -AssemblyName System.Drawing;',
    '$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds;',
    '$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height;',
    '$gfx = [System.Drawing.Graphics]::FromImage($bitmap);',
    '$gfx.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size);',
    `$bitmap.Save('${psQuoted}', [System.Drawing.Imaging.ImageFormat]::Png);`,
    '$gfx.Dispose(); $bitmap.Dispose();',
    `Write-Output '${psQuoted}';`,
  ].join(' ');
}

export const screenshotTool: ToolHandler = {
  schema: {
    name: 'screenshot',
    description:
      'Capture the current primary-monitor desktop as a PNG. Returns the absolute path of the saved file. Reads whatever is currently visible on screen — privacy-sensitive; only invoke when the user explicitly asks for a screenshot or screen share. Windows-only in v4.1.2.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  category: 'read',
  mutates: true,
  toolset: 'system',
  riskTier: 'safe',   // v4.4 Phase 1
  buildPreview(_args, ctx) {
    return {
      tool: 'screenshot', args: {}, riskTier: 'safe',
      sideEffects: [{ type: 'create_file', path: path.join(ctx.paths.root, 'screenshots', '<timestamp>.png'), bytes: 0 }],
      detectedRisks: ['The captured image may contain private on-screen information.'],
      summary: 'Would capture the primary display to a local screenshot artifact.',
    };
  },
  async execute(_args, ctx) {
    if (!isWindows()) return windowsOnlyError('screenshot');
    if (!ctx.paths) {
      return { success: false, error: 'aiden paths not wired (test mode?)' };
    }
    try {
      const dir = path.join(ctx.paths.root, 'screenshots');
      await fs.mkdir(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const outPath = path.join(dir, `${stamp}.png`);
      const { stdout } = await runPowerShell(buildScreenshotPs(outPath), {
        timeoutMs: 30_000,
      });
      // Verify the file actually landed on disk — PowerShell can exit 0
      // and have written nothing on an exotic display configuration.
      try {
        const stat = await fs.stat(outPath);
        return {
          success:  true,
          path:     outPath,
          size:     stat.size,
          // For Telegram / Discord adapters — they can attach via path.
          attachAs: 'image/png',
        };
      } catch {
        return {
          success: false,
          error:   `screenshot script ran but file not found at ${outPath} (stdout=${stdout.trim().slice(0, 120)})`,
        };
      }
    } catch (e) {
      return {
        success: false,
        error:   e instanceof Error ? e.message : String(e),
      };
    }
  },
};
