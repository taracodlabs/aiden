/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * scripts/release.mjs — one atomic release. Run via:
 *
 *   npm run release -- <x.y.z>            ship it
 *   npm run release -- <x.y.z> --dry-run  print every step, execute nothing
 *
 * Shipping used to be three separate manual steps — create the tag, npm
 * publish, cut the GitHub release — so one kept getting forgotten (GitHub
 * releases drifted behind npm for exactly that reason). This folds all three
 * into one ordered command that can't skip a step. The load-bearing line is
 * `git push --follow-tags`: it sends the branch AND the tag together, which is
 * precisely what would have prevented the drift.
 *
 * Order: preflight → bump → commit → tag → push(+tag) → npm publish → GitHub
 * release (notes taken from the matching CHANGELOG entry).
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** The release commit + tag must be authored by this identity. */
const RELEASER = 'Shiva Deore';

// ── args ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const version = argv.find((a) => !a.startsWith('-'));

// ── output helpers (colour only on a TTY, so piped output stays clean) ──────
const TTY = !!process.stdout.isTTY;
const paint = (code, s) => (TTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s) => paint('1', s);
const dim = (s) => paint('2', s);
const green = (s) => paint('32', s);
const red = (s) => paint('31', s);
const yellow = (s) => paint('33', s);

let stepN = 0;
const step = (t) => console.log(`\n${bold(`[${++stepN}] ${t}`)}`);
const ok = (m) => console.log(`  ${green('OK')} ${m}`);
const problems = [];
const fail = (m) => { console.log(`  ${red('FAIL')} ${m}`); problems.push(m); };

/** Read-only command → trimmed stdout (throws on non-zero). Always runs. */
const read = (cmd) => execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }).trim();

/** Mutating command → printed (not executed) under --dry-run. */
function mutate(cmd) {
  if (DRY) { console.log(`  ${yellow('would run:')} ${cmd}`); return; }
  console.log(`  ${dim(`$ ${cmd}`)}`);
  execSync(cmd, { stdio: 'inherit' });
}

function abort(msg) {
  console.log(`\n${red(bold('RELEASE ABORTED'))} — ${msg}\n`);
  process.exit(1);
}

/** Extract the notes body for `## vX.Y.Z` from CHANGELOG.md (up to the next
 *  `## v…` header or `---` divider). Returns null when the entry is absent. */
function changelogNotes(v) {
  const lines = readFileSync('CHANGELOG.md', 'utf8').split(/\r?\n/);
  const head = new RegExp(`^##\\s+v${v.replace(/\./g, '\\.')}\\b`);
  const start = lines.findIndex((l) => head.test(l));
  if (start === -1) return null;
  const body = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s+v?\d/.test(lines[i]) || /^---\s*$/.test(lines[i])) break;
    body.push(lines[i]);
  }
  const text = body.join('\n').trim();
  return text.length ? text : null;
}

// ── go ──────────────────────────────────────────────────────────────────────
console.log(`${bold('Aiden release')}${DRY ? `  ${yellow('(dry-run — nothing will execute)')}` : ''}`);

if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  abort('usage: npm run release -- <x.y.z> [--dry-run]');
}
const tag = `v${version}`;
console.log(`  target: ${bold(tag)}`);

// ═══ PREFLIGHT — fail loudly ═══
step('Preflight');

try {
  const dirty = read('git status --porcelain');
  if (dirty) fail('working tree not clean:\n' + dirty.split('\n').map((l) => '        ' + l).join('\n'));
  else ok('working tree clean');
} catch (e) { fail('git status failed: ' + e.message); }

try {
  const br = read('git rev-parse --abbrev-ref HEAD');
  if (br !== 'main') fail(`not on main (currently on '${br}')`);
  else ok('on main');
} catch { fail('could not read current branch'); }

try {
  const who = read('git config user.name');
  if (who !== RELEASER) fail(`git user.name is '${who}', expected '${RELEASER}' — the tag/commit must be ${RELEASER}'s`);
  else ok(`releaser identity: ${who}`);
} catch { fail('git user.name is not set'); }

try { read('gh auth status'); ok('gh authenticated'); }
catch { fail('gh is not authenticated (run: gh auth login)'); }

try { ok(`npm authenticated (${read('npm whoami')})`); }
catch { fail('npm is not authenticated (run: npm login)'); }

const notes = changelogNotes(version);
if (!notes) fail(`no CHANGELOG.md entry for ${tag} — add "## ${tag} — <date>" with release notes first`);
else ok(`CHANGELOG entry for ${tag} found`);

// Abort on the CHEAP checks BEFORE the slow CI gate — no point running the full
// suite if the tree is dirty, we're off main, or the notes are missing.
if (problems.length) {
  if (!DRY) abort(`${problems.length} preflight check(s) failed:\n  - ${problems.join('\n  - ')}`);
  console.log(`\n  ${yellow(`(dry-run: ${problems.length} preflight issue(s) above would ABORT before the CI gate — showing the remaining steps anyway)`)}`);
}

step('Preflight — CI-mirrored suite (the slow gate)');
if (DRY) {
  console.log(`  ${yellow('would run:')} CI=1 npx vitest run --exclude="tests/v4/integration/**"`);
} else {
  try {
    execSync('npx vitest run --exclude="tests/v4/integration/**"', { stdio: 'inherit', env: { ...process.env, CI: '1' } });
    ok('suite green');
  } catch { abort('CI-mirrored suite failed — do not ship red'); }
}

// ═══ RELEASE — one atomic sequence ═══
step(`Bump version → ${version}`);
mutate(`npm version ${version} --no-git-tag-version`);

step('Commit the bump');
mutate('git add package.json package-lock.json');
mutate(`git commit -m "chore(release): ${tag}"`);

step(`Annotated tag ${tag} (tagger: ${RELEASER})`);
mutate(`git tag -a ${tag} -m "Aiden ${tag}"`);

step('Push branch + tag together  (git push --follow-tags)');
mutate('git push --follow-tags');

step('Publish to npm');
mutate('npm publish');

step(`Create the GitHub release ${tag} (marked Latest) from the CHANGELOG`);
if (DRY) {
  console.log(`  ${yellow('would run:')} gh release create ${tag} --title "Aiden ${tag}" --notes-file <changelog-notes> --latest`);
  console.log(`  ${dim('--- notes that would be used ---')}`);
  console.log((notes || '(none — a real release would have aborted at preflight)').split('\n').map((l) => '    ' + l).join('\n'));
} else {
  const nf = path.join(mkdtempSync(path.join(tmpdir(), 'aiden-relnotes-')), `${tag}.md`);
  writeFileSync(nf, notes + '\n', 'utf8');
  mutate(`gh release create ${tag} --title "Aiden ${tag}" --notes-file "${nf}" --latest`);
}

console.log(`\n${green(bold(DRY ? 'DRY-RUN complete — no changes made.' : `Released ${tag}`))}`);
if (DRY) console.log(`  ${dim('Run the same command without --dry-run to execute.')}`);
