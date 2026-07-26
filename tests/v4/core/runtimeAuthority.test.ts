/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../../..');

const executionAdapters = [
  'cli/v4/aidenCLI.ts',
  'cli/v4/chatSession.ts',
  'core/v4/daemon/dispatcher/agentRunner.ts',
  'core/v4/daemon/dispatcher/realAgentRunner.ts',
  'core/v4/daemon/httpJobIngress.ts',
  'core/v4/mcp/server/toolBridge.ts',
  'core/v4/subagent/spawnSubAgent.ts',
];

const admissionAdapters = [
  'core/v4/daemon/api/runs.ts',
  'core/v4/daemon/dispatcher/dispatcher.ts',
  'core/v4/workbench/jobCommands.ts',
];

const forbiddenLifecycleWrites = [
  /\.submitJob\s*\(/,
  /\.claimAttempt\s*\(/,
  /\.renewAttemptLease\s*\(/,
  /\.transitionAttempt\s*\(/,
  /\.transitionJob\s*\(/,
  /\.finalizeJob\s*\(/,
];

function source(relativePath: string): string {
  return readFileSync(path.join(root, relativePath), 'utf8');
}

describe('production runtime authority contract', () => {
  it.each(executionAdapters)('%s delegates execution lifecycle to the canonical service', (relativePath) => {
    const text = source(relativePath);
    expect(text).toContain('executeDurableJob');
    for (const pattern of forbiddenLifecycleWrites) expect(text).not.toMatch(pattern);
  });

  it.each(admissionAdapters)('%s uses canonical admission without owning execution transitions', (relativePath) => {
    const text = source(relativePath);
    expect(text).toContain('admitDurableJob');
    for (const pattern of forbiddenLifecycleWrites) expect(text).not.toMatch(pattern);
  });
});
