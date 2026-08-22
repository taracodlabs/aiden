'use strict';

const path = require('node:path');

const [repoRoot, dbPath, installPath, invocationId] = process.argv.slice(2);
if (!repoRoot || !dbPath || !installPath || !invocationId) throw new Error('host-kill fixture arguments are required');

const Database = require(path.join(repoRoot, 'node_modules', 'better-sqlite3'));
const { runMigrations } = require(path.join(repoRoot, 'dist', 'core', 'v4', 'daemon', 'db', 'migrations.js'));
const { createCapabilityStore } = require(path.join(repoRoot, 'dist', 'core', 'v4', 'capabilities', 'store.js'));
const { DockerCapabilityProcessHost } = require(path.join(repoRoot, 'dist', 'core', 'v4', 'capabilities', 'processHost.js'));
const { getProcessCreationTime } = require(path.join(repoRoot, 'dist', 'core', 'v4', 'util', 'spawnCommand.js'));
const { capabilityIdentity } = require(path.join(repoRoot, 'dist', 'packages', 'capability-sdk', 'src', 'manifest.js'));
const manifest = require(path.join(installPath, 'capability.json'));

const db = new Database(dbPath);
db.pragma('foreign_keys = ON');
runMigrations(db);
const store = createCapabilityStore(db);
store.createInvocation({
  invocationId,
  identity: capabilityIdentity(manifest),
  toolName: 'hang',
  jobId: 'job_host_kill',
  attemptId: 'attempt_host_kill',
  generation: 1,
  state: 'running',
  permissionDigest: 'sha256:host-kill',
  effectRefs: [],
  evidenceRefs: [],
  startedAt: Date.now(),
  terminalAt: null,
  runtimeMs: null,
  exitCode: null,
  exitSignal: null,
  detail: null,
  hostInstanceId: `host_${process.pid}`,
  hostPid: process.pid,
  hostStartTime: getProcessCreationTime(process.pid),
});
process.stdout.write(`${JSON.stringify({ ready: true, invocationId, pid: process.pid })}\n`);

const host = new DockerCapabilityProcessHost({
  runtimePath: path.join(repoRoot, 'dist', 'core', 'v4', 'capabilities', 'containerRuntime.js'),
});
void host.run({
  manifest,
  identity: capabilityIdentity(manifest),
  invocationId,
  installPath,
  tool: 'hang',
  value: {},
  broker: {},
});

setInterval(() => undefined, 1_000);
