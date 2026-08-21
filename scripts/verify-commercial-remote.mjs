#!/usr/bin/env node

const publicTarget = /(?:github\.com[/:])taracodlabs\/aiden(?:\.git)?$/i;
const remoteName = process.argv[2] ?? '';
const remoteUrl = process.argv[3] ?? '';
const override = process.env.AIDEN_COMMUNITY_MAINTENANCE_PUSH;

if (!publicTarget.test(remoteUrl)) process.exit(0);

if (override === 'I_UNDERSTAND_THIS_PUSH_TARGETS_COMMUNITY') {
  process.stderr.write(
    `Commercial guard: explicit Community-maintenance override accepted for ${remoteName}.\n`,
  );
  process.exit(0);
}

process.stderr.write([
  '',
  'Commercial guard: push rejected.',
  `Remote ${remoteName || '(unknown)'} resolves to the public taracodlabs/aiden repository.`,
  'Private commercial work must be pushed only to taracodlabs/aiden-pro.',
  'A deliberate Community maintenance push requires the documented explicit override.',
  '',
].join('\n'));
process.exit(1);

