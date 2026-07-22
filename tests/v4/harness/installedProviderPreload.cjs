'use strict';

const path = require('node:path');
const installRoot = process.env.AIDEN_TEST_INSTALLED_ROOT;
const baseUrl = process.env.AIDEN_TEST_PROVIDER_BASE_URL;
if (!installRoot || !baseUrl) throw new Error('Installed provider smoke environment is incomplete.');
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
