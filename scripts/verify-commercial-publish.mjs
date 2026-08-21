#!/usr/bin/env node

import { readFile } from 'node:fs/promises';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const publicRegistry = !process.env.npm_config_registry || /registry\.npmjs\.org/i.test(process.env.npm_config_registry);
const publicCommunityName = pkg.name === 'aiden-runtime';

if (pkg.private !== true) {
  process.stderr.write('Commercial publish guard: package.json must remain private during development.\n');
  process.exit(1);
}

if (publicRegistry || publicCommunityName) {
  process.stderr.write([
    'Commercial publish guard: publication rejected.',
    `Package: ${pkg.name}`,
    `Registry: ${process.env.npm_config_registry || 'https://registry.npmjs.org/'}`,
    'Private development must never publish as the public Community package.',
    'Use a separately reviewed commercial release manifest and private distribution workflow.',
    '',
  ].join('\n'));
  process.exit(1);
}

process.stderr.write('Commercial publish guard: no approved commercial release manifest is configured.\n');
process.exit(1);

