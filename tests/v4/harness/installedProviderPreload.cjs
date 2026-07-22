'use strict';

const fs = require('node:fs');
const path = require('node:path');
const requestedRoot = process.env.AIDEN_TEST_INSTALLED_ROOT;
const baseUrl = process.env.AIDEN_TEST_PROVIDER_BASE_URL;
if (!requestedRoot || !baseUrl) throw new Error('Installed provider smoke environment is incomplete.');

function findInstallRoot(root) {
  const direct = path.join(root, 'node_modules', 'aiden-runtime', 'dist');
  if (fs.existsSync(direct)) return root;
  const packageRunnerRoot = path.join(root, '_npx');
  if (!fs.existsSync(packageRunnerRoot)) return null;
  for (const entry of fs.readdirSync(packageRunnerRoot)) {
    const candidate = path.join(packageRunnerRoot, entry);
    if (fs.existsSync(path.join(candidate, 'node_modules', 'aiden-runtime', 'dist'))) {
      return candidate;
    }
  }
  return null;
}

const installRoot = findInstallRoot(requestedRoot);
if (!installRoot) {
  // The package runner itself inherits NODE_OPTIONS before it has populated
  // its isolated cache. Its spawned runtime loads this module again after the
  // package exists, which is the process that needs the registry override.
  if (!/npm-cli\.js$/i.test(process.argv[1] ?? '')) {
    throw new Error('Installed runtime could not be located for provider smoke.');
  }
} else {
  const registry = require(path.join(
    installRoot,
    'node_modules',
    'aiden-runtime',
    'dist',
    'providers',
    'v4',
    'registry.js',
  ));
  registry.PROVIDER_REGISTRY.custom_openai.baseUrl = baseUrl;
}
