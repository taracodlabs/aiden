import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const root = resolve(option('--root') ?? process.cwd());
const requireFromRoot = createRequire(resolve(root, 'package.json'));
const lockfile = resolve(root, 'package-lock.json');
const report = {
  version: process.version,
  abi: process.versions.modules,
  execPath: process.execPath,
  lockfileSha256: createHash('sha256').update(readFileSync(lockfile)).digest('hex').toUpperCase(),
  betterSqlite3: requireFromRoot.resolve('better-sqlite3'),
  query: null,
};

try {
  const Database = requireFromRoot('better-sqlite3');
  const db = new Database(':memory:');
  try {
    report.query = db.prepare('SELECT 1 AS ok').get();
  } finally {
    db.close();
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ...report, error: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
}
