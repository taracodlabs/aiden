/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../../..');
const page = fs.readFileSync(path.join(root, 'dashboard-next/app/page.tsx'), 'utf8');
const css = fs.readFileSync(path.join(root, 'dashboard-next/app/globals.css'), 'utf8');
const terminal = fs.readFileSync(path.join(root, 'dashboard-next/components/LiveExecutionTerminal.tsx'), 'utf8');

describe('Live Execution Workbench source contract', () => {
  it('uses the existing xterm renderer in read-only observation mode', () => {
    expect(terminal).toContain("from '@xterm/xterm'");
    expect(terminal).toContain('disableStdin: true');
    expect(terminal).not.toContain('new WebSocket');
    expect(terminal).not.toContain('onData(');
  });

  it('keeps all mutation controls on existing Workbench backend authorities', () => {
    expect(page).not.toMatch(/process\.kill|child_process|playwright|git\s+(?:apply|commit|checkout)/i);
    expect(page).toContain("controlBrowser('take')");
    expect(page).toContain("decideCoding('apply')");
  });

  it('provides split, drawer, and mobile sheet layouts without a three-column squeeze', () => {
    expect(css).toContain('.workbench-grid.live-execution-open');
    expect(css).toContain('@media (max-width: 1100px)');
    expect(css).toContain('@media (max-width: 620px)');
    expect(css).toContain('.live-execution-pane { position: absolute; inset: 0;');
  });

  it('exposes restrained pane controls and exact surface switching', () => {
    expect(page).toContain('Live Execution');
    expect(page).toContain('Keep this open');
    expect(page).toContain('Collapse');
    expect(page).toContain('selectLiveExecutionSurface(surface.surfaceId)');
  });
});
