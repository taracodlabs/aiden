/**
 * copy-standalone-assets.js
 *
 * Runs automatically via the `postbuild` npm hook after `next build`.
 *
 * Next.js standalone output does NOT include .next/static or public/
 * by default. Without these files the server serves HTML but every
 * /_next/static/* request returns 404 (no CSS, JS chunks, or fonts).
 *
 * This script copies both directories into the standalone tree so
 * Electron (and any other Node runner) can serve a fully functional
 * dashboard without a separate CDN or `next start`.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT     = path.join(__dirname, '..');
const STANDALONE = path.join(ROOT, '.next', 'standalone');

function copyRecursive(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath  = path.join(src,  entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// .next/static → standalone/.next/static
copyRecursive(
  path.join(ROOT, '.next', 'static'),
  path.join(STANDALONE, '.next', 'static')
);

// public/ → standalone/public/  (only if the folder exists)
copyRecursive(
  path.join(ROOT, 'public'),
  path.join(STANDALONE, 'public')
);

// Reuse the established Aiden product icon for the static Workbench export.
const aidenIcon = path.resolve(ROOT, '../assets/icon.png');
const exportDir = path.join(ROOT, 'out');
if (fs.existsSync(aidenIcon) && fs.existsSync(exportDir)) {
  fs.copyFileSync(aidenIcon, path.join(exportDir, 'favicon.png'));
}

console.log('✓ Static assets copied to standalone');
