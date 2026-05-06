#!/usr/bin/env node
/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */

// Idempotent header inserter. Walks target dirs, prepends AGPL-3.0 header
// to any .ts file missing one. Skips tests, dist, node_modules, third-party.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const TARGETS = [
  'core/v4',
  'providers/v4',
  'tools/v4',
  'cli/v4',
  'moat',
];

const PLUGIN_GLOB_DIR = path.join(ROOT, 'plugins');

const SKIP_DIR_NAMES = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  '__mocks__',
  'tests',
  'test',
  '__tests__',
]);

const HEADER = `/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
`;

const HEADER_MARKER = 'Copyright (c) 2026 Shiva Deore';

function* walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIR_NAMES.has(e.name)) continue;
      yield* walk(full);
    } else if (e.isFile()) {
      if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts') && !e.name.endsWith('.test.ts')) {
        yield full;
      }
    }
  }
}

function applyHeader(file) {
  const text = fs.readFileSync(file, 'utf8');
  if (text.includes(HEADER_MARKER)) return false;
  // Preserve shebang line if present.
  if (text.startsWith('#!')) {
    const nl = text.indexOf('\n');
    const shebang = text.slice(0, nl + 1);
    const rest = text.slice(nl + 1);
    fs.writeFileSync(file, shebang + HEADER + rest, 'utf8');
  } else {
    fs.writeFileSync(file, HEADER + text, 'utf8');
  }
  return true;
}

const dirs = TARGETS.map((t) => path.join(ROOT, t));

if (fs.existsSync(PLUGIN_GLOB_DIR)) {
  for (const name of fs.readdirSync(PLUGIN_GLOB_DIR)) {
    if (name.startsWith('aiden-plugin-')) {
      dirs.push(path.join(PLUGIN_GLOB_DIR, name));
    }
  }
}

let added = 0;
let skipped = 0;
for (const dir of dirs) {
  for (const file of walk(dir)) {
    if (applyHeader(file)) {
      added++;
    } else {
      skipped++;
    }
  }
}

console.log(`headers added: ${added}`);
console.log(`already had header (skipped): ${skipped}`);
