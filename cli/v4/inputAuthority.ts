/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */
/** Render-free exclusive-input lease for prompts that run during a turn. */
import type { TurnKey } from './turnInputListener';

export type RawKeyHandler = (str: string | undefined, key: TurnKey) => void;
export type InputOwner = 'during_turn' | 'approval' | 'skill_prompt' | 'clarify';
export type ModalStdin = NodeJS.ReadStream;

export interface RawStdinLike {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?(mode: boolean): unknown;
  readableFlowing?: boolean | null;
  isPaused?(): boolean;
  resume?(): unknown;
  pause?(): unknown;
  on(event: 'keypress', handler: RawKeyHandler): unknown;
  removeListener(event: 'keypress', handler: RawKeyHandler): unknown;
}

export interface InputAuthorityOptions {
  stdin?: RawStdinLike;
  emitKeypressEvents?: (stdin: RawStdinLike) => void;
  onProcessExit?: (fn: () => void) => void;
  offProcessExit?: (fn: () => void) => void;
}

interface RawRegistration {
  kind: 'raw';
  owner: 'during_turn';
  leaseId: number;
  epoch: number;
  handler: RawKeyHandler;
  dispatch: RawKeyHandler;
  subscribed: boolean;
  rawBefore: boolean;
  rawChanged: boolean;
  initialPaused: boolean;
  activationPausedBefore: boolean;
  flowChanged: boolean;
  exitFn: (() => void) | null;
}

interface ModalLease {
  kind: 'modal';
  owner: Exclude<InputOwner, 'during_turn'>;
  leaseId: number;
  epoch: number;
  previous: RawRegistration | null;
  rawBefore: boolean;
  pausedBefore: boolean;
  flowingBefore: boolean | null | undefined;
  rawChanged: boolean;
  flowChanged: boolean;
  logicalPauseRequested: boolean;
  logicalResumeRequested: boolean;
  logicalRawModeRequested: boolean | null;
  facade: ModalStdin;
}

type ActiveLease = RawRegistration | ModalLease;

export class InputAuthority {
  private readonly stdin: RawStdinLike;
  private readonly emitKeypress: (stdin: RawStdinLike) => void;
  private readonly onExit: (fn: () => void) => void;
  private readonly offExit: (fn: () => void) => void;
  private nextLeaseId = 0;
  private epoch = 0;
  private active: ActiveLease | null = null;

  constructor(opts: InputAuthorityOptions = {}) {
    this.stdin = opts.stdin ?? (process.stdin as unknown as RawStdinLike);
    this.emitKeypress = opts.emitKeypressEvents ?? defaultEmitKeypress;
    this.onExit = opts.onProcessExit ?? ((fn) => process.once('exit', fn));
    this.offExit = opts.offProcessExit ?? ((fn) => process.removeListener('exit', fn));
  }

  currentEpoch(): number { return this.epoch; }
  currentLeaseId(): number | null { return this.active?.leaseId ?? null; }
  currentOwner(): InputOwner | null { return this.active?.owner ?? null; }
  previousOwner(): InputOwner | null {
    return this.active?.kind === 'modal' ? this.active.previous?.owner ?? null : null;
  }
  mountedCount(): number { return this.active ? 1 : 0; }
  isRawSubscribed(): boolean { return this.active?.kind === 'raw' && this.active.subscribed; }

  mountRawOwner(owner: 'during_turn', handler: RawKeyHandler): () => void {
    if (this.active?.kind === 'modal') throw new Error('Cannot mount raw input during an exclusive input lease');
    if (this.active?.kind === 'raw') this.deactivateRaw(this.active, true);
    const registration = {} as RawRegistration;
    Object.assign(registration, {
      kind: 'raw' as const,
      owner,
      leaseId: ++this.nextLeaseId,
      epoch: ++this.epoch,
      handler,
      subscribed: false,
      rawBefore: this.stdin.isRaw === true,
      rawChanged: false,
      initialPaused: this.stdin.isPaused?.() === true,
      activationPausedBefore: false,
      flowChanged: false,
      exitFn: null,
      dispatch: (str: string | undefined, key: TurnKey) => {
        if (this.active !== registration || registration.epoch !== this.epoch) return;
        registration.handler(str, key);
      },
    });
    this.active = registration;
    this.activateRaw(registration);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.active !== registration || registration.epoch !== this.epoch) return;
      ++this.epoch;
      this.deactivateRaw(registration, true);
      if (this.active === registration) this.active = null;
    };
  }

  async runExclusive<T>(
    owner: Exclude<InputOwner, 'during_turn'>,
    run: (stdin: ModalStdin) => Promise<T>,
  ): Promise<T> {
    if (this.active?.kind === 'modal') throw new Error('An exclusive input lease is already active');
    const previous = this.active?.kind === 'raw' ? this.active : null;
    if (previous) this.suspendRaw(previous);
    const lease = {} as ModalLease;
    Object.assign(lease, {
      kind: 'modal' as const,
      owner,
      leaseId: ++this.nextLeaseId,
      epoch: ++this.epoch,
      previous,
      rawBefore: this.stdin.isRaw === true,
      pausedBefore: this.stdin.isPaused?.() === true,
      flowingBefore: this.stdin.readableFlowing,
      rawChanged: false,
      flowChanged: false,
      logicalPauseRequested: false,
      logicalResumeRequested: false,
      logicalRawModeRequested: null,
      facade: undefined,
    });
    this.active = lease;
    lease.facade = this.createModalFacade(lease);
    this.establishModalState(lease);
    p2aDiag('lease.acquire.complete', {
      owner, leaseId: lease.leaseId, epoch: lease.epoch,
      previousOwner: previous?.owner ?? null,
      raw: this.stdin.isRaw === true,
      paused: this.stdin.isPaused?.() === true,
      flowing: this.stdin.readableFlowing,
    });
    try {
      const result = await run(lease.facade);
      p2aDiag('lease.callback.resolve', {
        owner, leaseId: lease.leaseId, epoch: lease.epoch,
      });
      return result;
    } finally {
      p2aDiag('lease.release.start', {
        owner, leaseId: lease.leaseId, epoch: lease.epoch,
        isCurrent: this.active === lease && this.epoch === lease.epoch,
      });
      if (this.active === lease && this.epoch === lease.epoch) {
        ++this.epoch;
        this.active = null;
        if (lease.previous) {
          lease.previous.epoch = this.epoch;
          this.active = lease.previous;
          this.restoreSuspendedRaw(lease.previous);
        } else {
          this.restoreModalState(lease);
        }
      }
      p2aDiag('lease.release.complete', {
        owner, leaseId: lease.leaseId,
        activeOwner: this.active?.owner ?? null,
        activeLeaseId: this.active?.leaseId ?? null,
        epoch: this.epoch,
        raw: this.stdin.isRaw === true,
        paused: this.stdin.isPaused?.() === true,
        flowing: this.stdin.readableFlowing,
      });
    }
  }

  private createModalFacade(lease: ModalLease): ModalStdin {
    const authority = this;
    let facade!: ModalStdin;
    const isCurrent = (): boolean => authority.active === lease && authority.epoch === lease.epoch;
    facade = new Proxy(this.stdin as object, {
      get(target, property) {
        if (property === 'pause') {
          return () => {
            if (isCurrent()) lease.logicalPauseRequested = true;
            return facade;
          };
        }
        if (property === 'resume') {
          return () => {
            if (isCurrent()) lease.logicalResumeRequested = true;
            return facade;
          };
        }
        if (property === 'setRawMode') {
          return (mode: boolean) => {
            if (isCurrent()) lease.logicalRawModeRequested = mode;
            return facade;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
      set(target, property, value) {
        return Reflect.set(target, property, value, target);
      },
    }) as unknown as ModalStdin;
    return facade;
  }

  private establishModalState(lease: ModalLease): void {
    if (!this.stdin.isTTY || typeof this.stdin.setRawMode !== 'function') return;
    try {
      if (this.stdin.isRaw !== true) {
        this.stdin.setRawMode(true);
        lease.rawChanged = true;
      }
      if ((this.stdin.isPaused?.() === true || this.stdin.readableFlowing !== true) &&
          typeof this.stdin.resume === 'function') {
        this.stdin.resume();
        lease.flowChanged = true;
      }
    } catch { /* prompt setup will report its own failure */ }
  }

  private restoreModalState(lease: ModalLease): void {
    if (lease.rawChanged) {
      try { this.stdin.setRawMode?.(lease.rawBefore); } catch { /* best effort */ }
      lease.rawChanged = false;
    }
    if (lease.flowChanged) {
      try {
        if (lease.pausedBefore || lease.flowingBefore === false) this.stdin.pause?.();
        else this.stdin.resume?.();
      } catch { /* best effort */ }
      lease.flowChanged = false;
    }
  }

  private activateRaw(reg: RawRegistration): void {
    if (!this.stdin.isTTY || typeof this.stdin.setRawMode !== 'function') return;
    try {
      this.emitKeypress(this.stdin);
      if (this.stdin.isRaw !== true) { this.stdin.setRawMode(true); reg.rawChanged = true; }
      this.stdin.on('keypress', reg.dispatch);
      reg.subscribed = true;
      reg.activationPausedBefore = this.stdin.isPaused?.() === true;
      reg.flowChanged = false;
      if (reg.activationPausedBefore && typeof this.stdin.resume === 'function') {
        this.stdin.resume();
        reg.flowChanged = true;
      }
      reg.exitFn = () => this.restoreRaw(reg);
      this.onExit(reg.exitFn);
    } catch {
      this.deactivateRaw(reg, false);
    }
  }

  private suspendRaw(reg: RawRegistration): void {
    if (!reg.subscribed) return;
    try { this.stdin.removeListener('keypress', reg.dispatch); } catch { /* best effort */ }
    reg.subscribed = false;
  }

  private restoreSuspendedRaw(reg: RawRegistration): void {
    if (!this.stdin.isTTY || typeof this.stdin.setRawMode !== 'function') return;
    try {
      this.emitKeypress(this.stdin);
      if (this.stdin.isRaw !== true) {
        this.stdin.setRawMode(true);
        reg.rawChanged = true;
      }
      this.stdin.on('keypress', reg.dispatch);
      reg.subscribed = true;
      if ((this.stdin.isPaused?.() === true || this.stdin.readableFlowing !== true) &&
          typeof this.stdin.resume === 'function') {
        this.stdin.resume();
        reg.flowChanged = true;
      }
    } catch {
      this.deactivateRaw(reg, false);
    }
  }

  private deactivateRaw(reg: RawRegistration, finalRelease: boolean): void {
    if (reg.subscribed) {
      try { this.stdin.removeListener('keypress', reg.dispatch); } catch { /* best effort */ }
      reg.subscribed = false;
    }
    this.restoreRaw(reg);
    this.restoreFlow(reg, finalRelease);
    if (reg.exitFn) {
      try { this.offExit(reg.exitFn); } catch { /* best effort */ }
      reg.exitFn = null;
    }
  }

  private restoreFlow(reg: RawRegistration, finalRelease: boolean): void {
    if (!reg.flowChanged) return;
    const shouldPause = finalRelease ? reg.initialPaused : reg.activationPausedBefore;
    try {
      if (shouldPause) reg.flowChanged && this.stdin.pause?.();
      else this.stdin.resume?.();
    } catch { /* best effort */ }
    reg.flowChanged = false;
  }

  private restoreRaw(reg: RawRegistration): void {
    if (!reg.rawChanged) return;
    try { this.stdin.setRawMode?.(reg.rawBefore); } catch { /* best effort */ }
    reg.rawChanged = false;
  }
}

function defaultEmitKeypress(stdin: RawStdinLike): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const readline = require('node:readline') as typeof import('node:readline');
  readline.emitKeypressEvents(stdin as unknown as NodeJS.ReadableStream);
}

function p2aDiag(event: string, data: Record<string, unknown>): void {
  if (process.env.AIDEN_P2A_DIAG !== '1') return;
  try {
    const monoMs = Number(process.hrtime.bigint() / 1_000_000n);
    process.stderr.write(`[p2a] ${JSON.stringify({ monoMs, event, ...data })}\n`);
  } catch { /* diagnostics must never affect input ownership */ }
}
