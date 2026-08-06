# Aiden v4.19.1

Aiden v4.19.1 is a startup and update reliability patch for `aiden-runtime`.

## Highlights

- A permanent dependency-light bootstrap starts before the full CLI and native
  modules.
- Missing or incomplete package files, unsupported Node versions, native-load
  failures, and Node ABI mismatches now produce concise repair guidance.
- Interactive startup checks the configured npm channel with a short timeout,
  a 24-hour cache, and Update, Later, or Skip choices.
- Manual commands support update checks, unattended installation, and validated
  exact versions without loading the full runtime.
- A temporary external updater installs into the prefix that owns the running
  package and uses the npm CLI associated with the active Node runtime.
- Installation success requires package, entrypoint, command-version, and native
  runtime verification. Failed verification attempts a verified rollback.
- Update checks fail open when the registry is unavailable and never block
  non-interactive use for input.

## Supported runtimes

Aiden v4.19.1 supports Node 20 and Node 22. Node 24 is not claimed as a supported
runtime; the bootstrap provides a compatibility message before native modules
load.

## Upgrade

Healthy installations can run:

```bash
aiden update
```

If an existing v4.19.0 command cannot start because its installation is missing
files or was installed under a different Node runtime, repair it once with:

```bash
npm uninstall -g aiden-runtime
npm install -g aiden-runtime@latest
```

Aiden workspaces, settings, history, Jobs, Attempts, Evidence, Proof, and provider
configuration remain in the Aiden data home and are not removed by reinstalling
the global npm package.

## Manual update commands

```bash
aiden update --check
aiden update
aiden update --yes
aiden update --version 4.19.1
```

The default channel is npm `latest`. Use `AIDEN_UPDATE_CHANNEL=beta` for npm
`beta`, or `AIDEN_UPDATE_CHANNEL=off` to disable bootstrap checks.

## Rollback

```bash
npm uninstall -g aiden-runtime
npm install -g aiden-runtime@4.19.0
```

Rollback changes the installed runtime package only. It does not delete the
Aiden data home.
