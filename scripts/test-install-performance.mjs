#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { spawnSync } from 'node:child_process'

const timeoutMs = 5 * 60 * 1000
const repoRoot = process.cwd()
const requestedTarball = process.argv[2]
const tarball = requestedTarball
  ? path.resolve(repoRoot, requestedTarball)
  : fs.readdirSync(repoRoot).find((entry) => /^aiden-runtime-.*\.tgz$/.test(entry))

if (!tarball || !fs.existsSync(tarball)) {
  throw new Error('Pass the generated aiden-runtime tarball path as the first argument.')
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiden-install-performance-'))
const prefix = path.join(root, 'prefix')
const cache = path.join(root, 'npm-cache')
const browserCache = path.join(root, 'browser-cache')
fs.mkdirSync(prefix, { recursive: true })
fs.mkdirSync(cache, { recursive: true })
fs.mkdirSync(browserCache, { recursive: true })

const npmCli = process.env.npm_execpath ?? 'D:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js'
const npmCommand = process.platform === 'win32' ? process.execPath : 'npm'
const npmPrefix = process.platform === 'win32' ? [npmCli] : []
const env = {
  ...process.env,
  NODE: process.execPath,
  npm_node_execpath: process.execPath,
  PATH: process.platform === 'win32'
    ? `${path.dirname(process.execPath)};${process.env.PATH ?? ''}`
    : `${path.dirname(process.execPath)}:${process.env.PATH ?? ''}`,
  npm_config_cache: cache,
  npm_config_prefix: prefix,
  PUPPETEER_CACHE_DIR: browserCache,
  PLAYWRIGHT_BROWSERS_PATH: browserCache,
}

function run(args, cwd = root) {
  const result = spawnSync(npmCommand, [...npmPrefix, ...args], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    shell: false,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${npmCommand} ${[...npmPrefix, ...args].join(' ')} failed with ${result.status}\n${result.stdout}\n${result.stderr}`)
  }
  return result
}

function runNode(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${process.execPath} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`)
  return result.stdout.trim()
}

function runBinary(binary, args) {
  const result = spawnSync(binary, args, {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
    shell: process.platform === 'win32',
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${binary} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`)
  return result.stdout.trim()
}

function measureDirectory(dir) {
  let files = 0
  let bytes = 0
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else {
        files += 1
        try { bytes += fs.statSync(full).size } catch {}
      }
    }
  }
  walk(dir)
  return { files, bytes }
}

const started = performance.now()
try {
  run(['init', '-y'], root)
  run(['install', tarball, '--no-audit', '--no-fund', '--foreground-scripts'], root)

  const installedPackage = path.join(root, 'node_modules', 'aiden-runtime', 'package.json')
  const manifest = JSON.parse(fs.readFileSync(installedPackage, 'utf8'))
  const version = manifest.version
  const binDir = path.join(root, 'node_modules', '.bin')
  const binName = process.platform === 'win32' ? 'aiden.cmd' : 'aiden'
  const runtimeBinName = process.platform === 'win32' ? 'aiden-runtime.cmd' : 'aiden-runtime'
  const aidenVersion = runBinary(path.join(binDir, binName), ['--version'])
  const runtimeVersion = runBinary(path.join(binDir, runtimeBinName), ['--version'])
  const help = runBinary(path.join(binDir, binName), ['--help'])
  if (!/Aiden|Usage/i.test(help)) throw new Error('The packaged Aiden help command did not render a usable CLI response.')
  const sqliteVersion = runNode(['-e', "const db=require('better-sqlite3')('audit.sqlite'); try { console.log(db.prepare('select sqlite_version() as version').get().version) } finally { db.close(); require('fs').unlinkSync('audit.sqlite') }"])
  runNode(['-e', "for (const name of ['puppeteer', 'whatsapp-web.js']) { try { require.resolve(name); throw new Error(name + ' is installed in the core runtime') } catch (error) { if (error.message.includes('is installed')) throw error } }"])

  const browserFiles = []
  function scan(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) scan(full)
      else if (/(chrom(e|ium)|headless-shell|chrome-for-testing)/i.test(entry.name)) browserFiles.push(full)
    }
  }
  scan(browserCache)
  if (browserFiles.length > 0) throw new Error(`Browser artifacts appeared in the isolated cache: ${browserFiles.join(', ')}`)

  const activeHandles = typeof process._getActiveHandles === 'function'
    ? process._getActiveHandles().filter((handle) => handle !== process.stdin && handle !== process.stdout && handle !== process.stderr)
    : []
  if (activeHandles.length > 0) throw new Error(`Install harness left ${activeHandles.length} active handles.`)

  const elapsedMs = Math.round(performance.now() - started)
  const nodeModules = measureDirectory(path.join(root, 'node_modules'))
  const packageCount = []
  function findPackages(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith('@')) findPackages(full)
      else if (fs.existsSync(path.join(full, 'package.json'))) packageCount.push(full)
    }
  }
  findPackages(path.join(root, 'node_modules'))
  console.log(JSON.stringify({ version, aidenVersion, runtimeVersion, sqliteVersion, elapsedMs, packageCount: packageCount.length, nodeModules, browserCacheFiles: 0, root }, null, 2))
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
