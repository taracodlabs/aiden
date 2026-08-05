import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function normalize(value) {
  return value.replaceAll('\\', '/').replace(/^\.\//, '');
}

const root = resolve(option('--root') ?? process.cwd());
const allowedUntracked = new Set(
  process.argv.flatMap((value, index) => value === '--allow-untracked' ? [process.argv[index + 1]] : [])
    .filter(Boolean)
    .map(normalize),
);
const protectedSpec = option('--protected');
const status = spawnSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
  cwd: root,
  encoding: 'utf8',
});
if (status.status !== 0) {
  process.stderr.write(status.stderr || 'Unable to inspect repository baseline.\n');
  process.exit(2);
}

const entries = status.stdout.split('\0').filter(Boolean).map((entry) => ({
  status: entry.slice(0, 2),
  path: normalize(entry.slice(3)),
}));
const trackedDirty = entries.filter((entry) => entry.status !== '??');
const unexpectedUntracked = entries.filter(
  (entry) => entry.status === '??' && !allowedUntracked.has(entry.path),
);
let protectedFile = null;
if (protectedSpec) {
  const split = protectedSpec.lastIndexOf('=');
  if (split <= 0) throw new Error('--protected expects relative-path=SHA256');
  const path = normalize(protectedSpec.slice(0, split));
  const expectedSha256 = protectedSpec.slice(split + 1).toUpperCase();
  const sha256 = createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex').toUpperCase();
  protectedFile = { path, expectedSha256, sha256, matches: sha256 === expectedSha256 };
}
const clean = trackedDirty.length === 0
  && unexpectedUntracked.length === 0
  && (protectedFile?.matches ?? true);
process.stdout.write(`${JSON.stringify({
  root,
  clean,
  trackedDirty,
  allowedUntracked: entries.filter((entry) => entry.status === '??' && allowedUntracked.has(entry.path)),
  unexpectedUntracked,
  protectedFile,
})}\n`);
process.exitCode = clean ? 0 : 1;
