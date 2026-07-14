'use strict';

const path = require('node:path');
const baseUrl = process.env.AIDEN_TEST_PROVIDER_BASE_URL;
if (!baseUrl) throw new Error('AIDEN_TEST_PROVIDER_BASE_URL is required');
const repoRoot = process.env.AIDEN_TEST_REPO_ROOT || process.cwd();
const registry = require(path.resolve(repoRoot, 'dist/providers/v4/registry.js'));
registry.PROVIDER_REGISTRY.custom_openai.baseUrl = baseUrl;
