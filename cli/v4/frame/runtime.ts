/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 *
 * v4.11 Slice 1 — FrameRuntime (Ink-backed implementation).
 *
 * Public surface for callers (chatSession.readLine, future slices):
 *
 *   const runtime = await getFrameRuntime();
 *   const value   = await runtime.readLine({ prompt: '› ' });
 *
 * Internally:
 *   1. `installGuard()` is idempotent — first call patches stdout.
 *   2. `readLine()` mounts Ink with a fresh driver stream, arms the
 *      guard, awaits the user's submit, paints one busy tick, then
 *      unmounts and disarms.
 *   3. `pause() / resume()` are no-ops in Slice 1 (one mount per
 *      prompt, lifetime ends at submit). They exist so chatSession's
 *      runAgentTurn boundary can call them today and slot in a
 *      persistent-frame implementation in a later slice without
 *      changing the call sites.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const React = require('react') as typeof import('react');

import {
  installGuard,
  arm,
  disarm,
  getDriverStream,
  unsafeWrite,
} from './terminalDriver';
import { makeInitialState, reducer, type FrameState, type FrameAction } from './state';
import { makeComposer, type InkComponents } from './composer';
import { emitComposerReadyForTests } from '../composerReadiness';

// Lazily imported Ink module (ESM). Captured once per process so the
// dynamic import cost is paid only on first frame mount.
//
// We hand-roll the minimal type instead of `typeof import('ink')`
// because ink ships types via package.json `exports` which require
// `moduleResolution: node16+`. The project sits on `moduleResolution:
// node` (changing it sweeps the whole repo). Confining the type
// declaration here keeps the rest of the build untouched.
interface InkModule {
  render: (
    node: React.ReactElement,
    opts?: {
      stdout?:       NodeJS.WriteStream;
      stdin?:        NodeJS.ReadStream;
      exitOnCtrlC?:  boolean;
      patchConsole?: boolean;
      debug?:        boolean;
    },
  ) => {
    unmount:        () => void;
    waitUntilExit:  () => Promise<void>;
    rerender:       (node: React.ReactElement) => void;
    /**
     * Ink 5+ — walks up the painted region and erases it via the
     * `log-update` clear sequence (ansi-escapes `eraseLines(N)`).
     * Called before unmount so the busy heartbeat + cursor cell
     * don't survive into scrollback. No-op in CI (Ink's gate).
     */
    clear:          () => void;
  };
  Box:      React.ComponentType<unknown>;
  Text:     React.ComponentType<unknown>;
  useInput: (handler: (input: string, key: Record<string, boolean>) => void, opts?: { isActive?: boolean }) => void;
}
let inkModuleP: Promise<InkModule> | null = null;
// `new Function('return import(m)')` defers the import-specifier
// resolution past TypeScript's static check. We have to do this
// because TS resolves `import('ink')` against the project's
// moduleResolution setting, which is `node` — and ink's types live
// behind a package-exports map that requires `node16`/`bundler`.
// The runtime import is identical; only the type-check site differs.
const _dynamicImport = new Function('m', 'return import(m)') as (m: string) => Promise<unknown>;
async function loadInk(): Promise<InkModule> {
  if (!inkModuleP) inkModuleP = _dynamicImport('ink') as Promise<InkModule>;
  return inkModuleP;
}

export interface ReadLineOptions {
  prompt:       string;
  /** ms to leave the busy tick visible before unmount. Defaults to 16ms (one frame). */
  busyTickMs?:  number;
}

export interface FrameRuntime {
  /** Mount composer, await submit, unmount, return the captured string. */
  readLine: (opts: ReadLineOptions) => Promise<string>;
  /** Pause the frame (Slice 1: no-op — see file header). */
  pause:    () => void;
  /** Resume the frame (Slice 1: no-op — see file header). */
  resume:   () => void;
  /** Hard-shutdown — restore stdout, clear caches. Test-only mostly. */
  shutdown: () => void;
}

/**
 * Build the singleton frame runtime. The factory shape (rather than a
 * module-level singleton) lets tests construct fresh runtimes with
 * different stdout sinks.
 */
export async function createFrameRuntime(): Promise<FrameRuntime> {
  installGuard();
  const ink: InkModule = await loadInk();
  const inkComponents: InkComponents = {
    Box:       ink.Box      as InkComponents['Box'],
    Text:      ink.Text     as InkComponents['Text'],
    useInput:  ink.useInput as InkComponents['useInput'],
  };
  const Composer = makeComposer(inkComponents);

  let paused = false;

  async function readLine(opts: ReadLineOptions): Promise<string> {
    if (paused) {
      throw new Error('[aiden.frame] readLine called while runtime paused');
    }

    // Each readLine owns its own state + reducer dispatch.
    let state: FrameState = makeInitialState(opts.prompt);

    // Resolver for the submit promise; held outside the component so
    // the callback can fire it cross-render.
    let resolve!: (value: string) => void;
    let reject!:  (err: Error) => void;
    const finished = new Promise<string>((res, rej) => { resolve = res; reject = rej; });

    /**
     * Root component owns state via useState. We hoist `dispatch` and
     * the live state ref to per-readLine closures so the submit /
     * cancel callbacks (defined outside the component to keep the
     * promise contract clean) can mutate without prop-drilling.
     *
     * IMPORTANT: these `let` bindings MUST be declared above
     * `ink.render(...)` below — Ink synchronously invokes
     * `RootComponent` during the render call, and the component's
     * body references `dispatch`. If the `let` lands after
     * `ink.render`, the function body hits a TDZ ReferenceError at
     * render time ("Cannot access 'dispatch' before initialization").
     * Caught in the Phase C PTY diag; do not reorder.
     */
    let dispatch: (action: FrameAction) => void = () => {};
    let getState: () => FrameState = () => state;

    // `instance` is referenced by the onSubmit / onCancel callbacks
    // inside RootComponent for unmount. Like `dispatch` above, the
    // binding must exist before `ink.render` runs the component
    // body the first time — we assign it on the line below.
    let instance: ReturnType<InkModule['render']> | null = null;

    function RootComponent(): React.ReactElement {
      const [s, setS] = React.useState<FrameState>(state);
      dispatch = (action: FrameAction): void => {
        const next = reducer(s, action);
        state = next;
        setS(next);
      };
      getState = (): FrameState => s;

      return React.createElement(Composer, {
        state:     s,
        callbacks: {
          onChange: (value: string, cursor: number): void => {
            dispatch({ type: 'composer/setValue', value, cursor });
          },
          onSubmit: (value: string): void => {
            // Flip to busy so the heartbeat row appears for one tick.
            dispatch({ type: 'status/markBusy', sinceMs: Date.now() });
            // Schedule unmount + resolve on the next macrotask so the
            // busy row gets a chance to paint. busyTickMs is the
            // upper bound; in practice Ink's reconciler flushes
            // within a few ms. Env override
            // `AIDEN_FRAME_BUSY_TICK_MS` lets PTY tests stretch the
            // window so the heartbeat is reliably observable in the
            // captured byte stream — production paths leave it at
            // the default 16ms.
            const envTick = Number.parseInt(process.env.AIDEN_FRAME_BUSY_TICK_MS ?? '', 10);
            const tickMs = opts.busyTickMs ?? (Number.isFinite(envTick) && envTick > 0 ? envTick : 16);
            setTimeout(() => {
              // Clean-unmount sequence (Phase C visual-residue fix):
              //   1. instance.clear() — Ink walks back over the
              //      painted region and erases it (composer line,
              //      cursor inverse-cell, busy heartbeat row).
              //      Without this step the busy row + cursor cell
              //      remain in scrollback after unmount.
              //   2. instance.unmount() — stop the reconciler.
              //   3. unsafeWrite(prompt + value + '\n') — paint a
              //      plain-text scrollback record of what the user
              //      typed, with the cursor landing on a fresh
              //      line below for the legacy painter handoff.
              //      Routed through the driver so the writer-
              //      singleton guard's token-bypass keeps the
              //      invariant honest.
              try { instance?.clear();   } catch { /* noop */ }
              try { instance?.unmount(); } catch { /* already unmounted */ }
              try { unsafeWrite(`${opts.prompt}${value}\n`); } catch { /* noop */ }
              disarm();
              resolve(value);
            }, tickMs);
          },
          onCancel: (): void => {
            // Cancel path: clear the frame region but DON'T echo
            // the partial input — the user explicitly aborted.
            // Drop a single newline so the legacy painter starts
            // on a fresh line.
            try { instance?.clear();   } catch { /* noop */ }
            try { instance?.unmount(); } catch { /* already unmounted */ }
            try { unsafeWrite('\n');   } catch { /* noop */ }
            disarm();
            reject(new Error('User force closed'));
          },
        },
      });
    }

    // Touch getState so the linter doesn't strip it as unused (it's
    // intentionally available for late-binding tests + future slices).
    void getState;

    // Mount the Ink instance. This runs RootComponent synchronously
    // — by here both `dispatch` and `instance` (above) are
    // initialized, so the component body's references resolve.
    const stream = getDriverStream();
    instance = ink.render(
      React.createElement(RootComponent),
      {
        stdout:        stream as unknown as NodeJS.WriteStream,
        stdin:         process.stdin,
        exitOnCtrlC:   false,
        patchConsole:  false,
      },
    );

    // Arm AFTER mount returns. Mounting Ink itself writes to stream
    // (which routes through unsafeWrite — already token-bypassed —
    // but arming first is still cleaner).
    arm();
    emitComposerReadyForTests();

    try {
      return await finished;
    } finally {
      // Defensive: if something threw mid-flight, make sure we
      // disarm and let Ink tear down.
      if (instance) {
        try { instance.unmount(); } catch { /* noop */ }
      }
      // disarm() is safe to call extra times — it floors at zero.
      disarm();
    }
  }

  function pause(): void {
    paused = true;
  }

  function resume(): void {
    paused = false;
  }

  function shutdown(): void {
    // Slice 1: no persistent mount to tear down. Future slices will
    // close a long-lived Ink instance here.
    paused = false;
  }

  return { readLine, pause, resume, shutdown };
}

// ── Process-wide singleton accessor ────────────────────────────────
//
// Most callers want one runtime per process. Tests can sidestep by
// calling `createFrameRuntime()` directly.

let singletonP: Promise<FrameRuntime> | null = null;
export function getFrameRuntime(): Promise<FrameRuntime> {
  if (!singletonP) singletonP = createFrameRuntime();
  return singletonP;
}

/** Test helper — wipe the singleton so the next call rebuilds. */
export function _resetFrameRuntimeForTests(): void {
  singletonP = null;
}
