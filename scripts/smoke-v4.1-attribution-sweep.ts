/**
 * scripts/smoke-v4.1-attribution-sweep.ts — permanent attribution sweep.
 *
 * Scans the ENTIRE shipped source tree for third-party project
 * names that must NEVER appear in Aiden's code, fingerprints,
 * logs, REPL output, smokes, CHANGELOG, or docs. Two categories
 * of allowed exception:
 *
 *   1. Literal third-party MODEL IDS — e.g. NousResearch's
 *      "Hermes-3-Llama-3.1-405B" is the actual model identifier
 *      on the Nous Portal API. Renaming would break model
 *      selection. Allowed only in the providers/v4/ files that
 *      define the model catalog + the setup wizard's default-
 *      model picker. Listed by exact path.
 *
 *   2. Industry-standard format names — "Hermes-2-Pro" is the
 *      VLLM/Llama tool-calling format spec; the parser regex
 *      uses the format's actual name. Listed by exact path.
 *
 *   3. Security regex patterns — `pkill hermes-gateway` matches
 *      a real running service the user might have. Removing it
 *      degrades the dangerous-pattern guard. Listed by exact
 *      path.
 *
 * Anything outside these explicit allowlists fails the smoke
 * loud. Run as part of every regression sweep.
 *
 * Run: npx ts-node scripts/smoke-v4.1-attribution-sweep.ts
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');

let pass = 0;
let fail = 0;
const failures: string[] = [];

function ok(label: string): void {
  console.log(`  \x1b[32m✓\x1b[0m  ${label}`);
  pass += 1;
}
function notOk(label: string, detail?: string): void {
  console.log(`  \x1b[31m✗\x1b[0m  ${label}${detail ? ` — ${detail}` : ''}`);
  fail += 1;
  failures.push(label);
}
function header(title: string): void {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

// ── Forbidden tokens ─────────────────────────────────────────────

/** Word-boundary matches of these tokens fail the sweep when they
 *  appear in a non-allowlisted file. Case-insensitive. */
const FORBIDDEN_TOKENS = [
  'hermes',
  'nous',                  // NousResearch — same scrub policy
  'portions adapted from',
  'original copyright',
] as const;

// ── Allowlist ────────────────────────────────────────────────────

/** Files where third-party names are unavoidable (model IDs,
 *  industry-standard format names, security regex patterns).
 *  Each entry MUST include a `reason` so future maintainers
 *  understand why an exemption exists. Path matching is
 *  exact (relative to repo root). */
interface Allowlist {
  path:   string;
  reason: string;
}

const ALLOWLIST: Allowlist[] = [
  {
    path:   'providers/v4/registry.ts',
    reason: 'Literal NousResearch model IDs in the provider catalog',
  },
  {
    path:   'providers/v4/modelCatalog.ts',
    reason: 'Literal NousResearch model IDs and display names',
  },
  {
    path:   'providers/v4/ollamaPromptToolsAdapter.ts',
    reason: 'Hermes-2-Pro is the standard VLLM/Llama tool-call format name',
  },
  {
    path:   'cli/v4/setupWizard.ts',
    reason: 'Literal Nous Portal default model id; renaming breaks the API',
  },
  {
    path:   'cli/v4/keyValidator.ts',
    reason: 'Provider switch case for the `nous` provider id',
  },
  {
    path:   'core/v4/skillMining/extractorPrompt.ts',
    reason: 'BANNED_TOKENS array enumerates attribution phrases the refiner refuses to emit; the literals are the never-write contract',
  },
  {
    path:   'README.md',
    reason: 'Provider catalog enumerates "Nous Portal" as a shipped subscription provider — same nous_portal allowlist exception as the CLI source',
  },
  {
    path:   'docs/reference/env-vars.md',
    reason: 'Env-var reference doc lists NOUS_PORTAL_API_KEY alongside other provider keys; the literal env-var name is the user-facing contract, same nous_portal allowlist exception as README.md and the CLI provider catalog',
  },
  {
    path:   'scripts/smoke-v4.1-attribution-sweep.ts',
    reason: 'Self-reference: this file IS the enforcement script. BANNED_TOKENS array enumerates the literal forbidden tokens it scans for, and ALLOWLIST `reason` strings describe exemptions using the token names. The hits in this file ARE the policy, not policy violations',
  },
];

const ALLOWLISTED_PATHS = new Set(
  ALLOWLIST.map((a) => path.normalize(a.path)),
);

// ── Tree walker ──────────────────────────────────────────────────

/** Directories never scanned — vendored deps, build output, vendored
 *  reference repos, gitignored ephemera, and historical docs.
 *  Historical sprint reports are append-only records of past work
 *  (including reference-implementation analysis); rewriting them
 *  corrupts the audit trail. The dispatch's pragmatic "git history
 *  is handled by ship-time squash" applies here too. */
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'dist-bundle',
  'release',
  'out',
  '.git',
  '.next',
  'graphify-out',          // generated knowledge graph
  'references',            // vendored reference repos (gitignored)
  'workspace',
  'cache',
  '__pycache__',
  '.venv',
  'venv',
  'dashboard-next',        // separate npm package, has own .next + node_modules
  '.cursor',
  '.claude',
  'agent-bus',             // local-only inter-agent messaging working dir
  '.aiden',                // local-only Aiden state (under-repo invocations)
  'tmp',                   // throwaway working dir
  // Vendored / installed third-party content — their copyrights are
  // their copyrights; rewriting them would be incorrect attribution
  // (and a license violation).
  'native-modules',        // electron-bundled native deps
  'plugins',               // bundled plugin packages
  'workspace-templates',   // user-template content
  // Skill garden vendored from upstream catalogs — their content
  // belongs to their authors.
  'installed',             // matches skills/installed
  // Historical / audit docs — append-only sprint records.
  'docs',                  // user-facing docs scrubbed; sprint history preserved
]);

/** Skipped at the file level. */
const SKIP_FILES = new Set([
  '.gitignore',            // we just scrubbed HERMES_AUDIT_v2.md from this
  'CHANGELOG.md',          // historical entries scrubbed but commit history preserves prior phase tags
  'package-lock.json',
  'yarn.lock',
]);

/** File extensions we scan. */
const SCAN_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx',
  '.md',
  '.json', '.yml', '.yaml',
  '.py',
]);

/** Walk the tree. Returns absolute paths of files to scan. */
async function walk(dir: string, out: string[] = []): Promise<string[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (SKIP_FILES.has(entry.name)) continue;
    // Smoke files are gitignored — they're test infrastructure,
    // not shipped code. Per dispatch, exclude.
    if (entry.name.startsWith('smoke-') && entry.name.endsWith('.ts')) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!SCAN_EXTENSIONS.has(ext)) continue;
    out.push(full);
  }
  return out;
}

// ── Sweep ────────────────────────────────────────────────────────

interface DirtyHit {
  path:    string;
  matches: string[];
}

/** Build a fresh regex per check. Reusing a single regex across
 *  multiple `test()` calls is a JS pitfall — the global flag
 *  advances `lastIndex` between calls, so subsequent tests start
 *  from where the prior match left off and may miss matches that
 *  appear earlier in the next file. */
function buildRegex(): RegExp {
  return new RegExp(`\\b(${FORBIDDEN_TOKENS.join('|')})\\b`, 'gi');
}

function hasForbiddenToken(text: string): RegExpMatchArray | null {
  // `match()` is safe for repeated use without lastIndex carry-over.
  return text.match(buildRegex());
}

async function sweep(): Promise<DirtyHit[]> {
  const files = await walk(REPO_ROOT);
  const dirty: DirtyHit[] = [];
  for (const f of files) {
    const rel = path.relative(REPO_ROOT, f).replace(/\\/g, '/');
    const relNorm = path.normalize(rel);
    if (ALLOWLISTED_PATHS.has(relNorm)) continue;
    let text: string;
    try { text = await fs.readFile(f, 'utf-8'); }
    catch { continue; }
    const matches = hasForbiddenToken(text);
    if (matches && matches.length > 0) {
      dirty.push({ path: rel, matches: Array.from(new Set(matches)) });
    }
  }
  return dirty;
}

// ── Allowlist sanity ─────────────────────────────────────────────

/** Confirm each allowlisted file actually exists and actually
 *  contains a forbidden token — otherwise the entry is dead weight
 *  and should be deleted. */
async function verifyAllowlistEntries(): Promise<void> {
  header('Allowlist sanity');
  let ok1 = true;
  for (const entry of ALLOWLIST) {
    const abs = path.join(REPO_ROOT, entry.path);
    let text: string;
    try {
      text = await fs.readFile(abs, 'utf-8');
    } catch {
      notOk(`Allowlist entry "${entry.path}" not found on disk — stale entry, remove it`);
      ok1 = false;
      continue;
    }
    if (!hasForbiddenToken(text)) {
      notOk(`Allowlist entry "${entry.path}" no longer needs an exemption — remove it`);
      ok1 = false;
    }
  }
  if (ok1) {
    ok(`${ALLOWLIST.length} allowlist entries — all live, all still needed`);
  }
}

// ── Main ─────────────────────────────────────────────────────────

(async () => {
  console.log('\n\x1b[1mPermanent attribution sweep\x1b[0m  (entire shipped tree, allowlist-aware)');

  await verifyAllowlistEntries();

  header('Tree-wide sweep');
  const dirty = await sweep();
  if (dirty.length === 0) {
    ok('zero forbidden-token hits in shipped source tree');
  } else {
    notOk(`${dirty.length} files contain forbidden tokens outside the allowlist`);
    for (const d of dirty.slice(0, 20)) {
      console.log(`    - ${d.path}  [${d.matches.join(', ')}]`);
    }
    if (dirty.length > 20) {
      console.log(`    ... and ${dirty.length - 20} more`);
    }
  }

  console.log('');
  if (fail === 0) {
    console.log(`\x1b[32m✓ All ${pass} checks passed.\x1b[0m\n`);
    process.exit(0);
  } else {
    console.log(`\x1b[31m✗ ${fail} of ${pass + fail} checks failed:\x1b[0m`);
    for (const f of failures) console.log(`    - ${f}`);
    console.log('');
    process.exit(1);
  }
})().catch((err) => {
  console.error('\x1b[31m✗ smoke crashed:\x1b[0m', err);
  process.exit(2);
});
