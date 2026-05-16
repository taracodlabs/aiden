/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/daemon/triggers/email/imapConnection.ts — v4.5 Phase 4a.
 *
 * Thin wrapper around imap-simple. Adds:
 *   - exponential backoff reconnect (1s → 60s capped at 60s)
 *   - IMAP ID command on connect (defends against servers that
 *     disconnect unidentified clients — see audit §8)
 *   - UIDVALIDITY tracking for cross-restart UID correctness
 *   - typed Promise interface (imap-simple's surface is mostly
 *     callback-shaped underneath)
 *
 * Lifecycle:
 *   const ic = createImapConnection(spec.imap, log);
 *   await ic.connect();
 *   await ic.openMailbox(spec.mailbox);
 *   const uids = await ic.searchAll();              // seed seenUids
 *   const unseen = await ic.searchUnseen();         // poll
 *   const msg = await ic.fetchMessage(uid);
 *   await ic.markSeen(uid);
 *   await ic.disconnect();
 */

import * as imaps from 'imap-simple';
import type { ImapSimple } from 'imap-simple';
import { VERSION } from '../../../../version';

// `imap-simple` exposes `ImapSimple` as the class; older docs called
// it `Connection`. Alias for readability in this module.
type Connection = ImapSimple;

export interface ImapConfig {
  host:           string;
  port:           number;
  user:           string;
  password:       string;
  tls:            boolean;
  authTimeoutMs:  number;
}

export interface RawMessage {
  uid:         number;
  /** Full RFC822 source for mailparser to consume. */
  raw:         Buffer;
  /** Convenience: flags + date from IMAP attributes. */
  flags:       string[];
  internalDate: Date;
}

export interface ImapConnection {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  openMailbox(mailbox: string): Promise<{ uidValidity: number }>;
  /** UID SEARCH ALL — returns every UID in the open mailbox. */
  searchAll(): Promise<number[]>;
  /** UID SEARCH UNSEEN — returns every unread UID. */
  searchUnseen(): Promise<number[]>;
  /** Fetch one message by UID; returns raw RFC822 source. */
  fetchMessage(uid: number): Promise<RawMessage | null>;
  /** Mark a UID as `\Seen` on the server. Idempotent. */
  markSeen(uid: number): Promise<void>;
}

const BACKOFF_INITIAL_MS  = 1_000;
const BACKOFF_MAX_MS      = 60_000;
const BACKOFF_MULTIPLIER  = 2;

export interface CreateImapConnectionOptions {
  config: ImapConfig;
  log?:   (level: 'info' | 'warn' | 'error', msg: string) => void;
}

const noopLog = (_l: 'info' | 'warn' | 'error', _m: string): void => undefined;

export function createImapConnection(opts: CreateImapConnectionOptions): ImapConnection {
  const cfg = opts.config;
  const log = opts.log ?? noopLog;
  let conn: Connection | null = null;
  let backoffMs = BACKOFF_INITIAL_MS;
  let currentMailbox: string | null = null;
  let currentUidValidity = 0;

  const buildConfig = () => ({
    imap: {
      host:           cfg.host,
      port:           cfg.port,
      user:           cfg.user,
      password:       cfg.password,
      tls:            cfg.tls,
      authTimeout:    cfg.authTimeoutMs,
      // Reasonable production defaults — imap-simple passes these to node-imap.
      tlsOptions: { rejectUnauthorized: true },
    },
  });

  const sendIdCommand = (c: Connection): Promise<void> => new Promise<void>((resolve) => {
    // imap-simple exposes the raw node-imap Connection via .imap.
    // Some servers (NetEase 163) disconnect without an ID exchange:
    //   "BYE Unsafe Login. Please contact kefu@188.com for help".
    // Apply unconditionally — other servers ignore it.
    try {
      const c2 = c as unknown as { imap?: { id?: (args: object, cb: (err: Error | null) => void) => void } };
      if (c2.imap?.id) {
        c2.imap.id({ name: 'Aiden', version: VERSION, vendor: 'Taracod' }, (_err) => resolve());
      } else { resolve(); }
    } catch {
      // Older imap-simple versions don't expose .id — treat as no-op.
      resolve();
    }
  });

  return {
    async connect(): Promise<void> {
      try {
        conn = await imaps.connect(buildConfig());
        await sendIdCommand(conn);
        backoffMs = BACKOFF_INITIAL_MS;          // reset on success
        log('info', `[email] imap connected (${cfg.host}:${cfg.port} ${cfg.user})`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log('error', `[email] imap connect failed: ${msg}`);
        throw e;
      }
    },
    async disconnect(): Promise<void> {
      if (!conn) return;
      try { conn.end(); } catch { /* best-effort */ }
      conn = null;
      currentMailbox = null;
      currentUidValidity = 0;
    },
    isConnected(): boolean {
      return conn !== null;
    },
    async openMailbox(mailbox: string): Promise<{ uidValidity: number }> {
      if (!conn) throw new Error('[email] not connected');
      // imap-simple openBox typed surface is awkward — accept Mailbox
      // object back.
      const box = await conn.openBox(mailbox) as unknown as { uidvalidity?: number };
      currentMailbox = mailbox;
      currentUidValidity = box.uidvalidity ?? 0;
      return { uidValidity: currentUidValidity };
    },
    async searchAll(): Promise<number[]> {
      if (!conn) throw new Error('[email] not connected');
      const results = await conn.search(['ALL'], { bodies: ['HEADER.FIELDS (MESSAGE-ID)'], markSeen: false }) as Array<{ attributes: { uid: number } }>;
      return results.map((r) => r.attributes.uid);
    },
    async searchUnseen(): Promise<number[]> {
      if (!conn) throw new Error('[email] not connected');
      const results = await conn.search(['UNSEEN'], { bodies: ['HEADER.FIELDS (MESSAGE-ID)'], markSeen: false }) as Array<{ attributes: { uid: number } }>;
      return results.map((r) => r.attributes.uid);
    },
    async fetchMessage(uid: number): Promise<RawMessage | null> {
      if (!conn) throw new Error('[email] not connected');
      try {
        const fetched = await conn.search(
          [['UID', String(uid)]],
          {
            // Fetch full RFC822 source — mailparser handles MIME.
            bodies: [''],
            markSeen: false,
          },
        ) as Array<{
          attributes: { uid: number; flags?: string[]; date?: Date };
          parts:      Array<{ which: string; body: string | Buffer }>;
        }>;
        if (fetched.length === 0) return null;
        const m = fetched[0];
        const part = m.parts.find((p) => p.which === '');
        if (!part) return null;
        const raw = Buffer.isBuffer(part.body) ? part.body : Buffer.from(part.body, 'utf-8');
        return {
          uid:          m.attributes.uid,
          raw,
          flags:        m.attributes.flags ?? [],
          internalDate: m.attributes.date ?? new Date(),
        };
      } catch (e) {
        log('warn', `[email] fetch uid ${uid} failed: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
    },
    async markSeen(uid: number): Promise<void> {
      if (!conn) throw new Error('[email] not connected');
      try {
        await conn.addFlags(uid, '\\Seen');
      } catch (e) {
        log('warn', `[email] markSeen uid ${uid} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}

/**
 * Compute the next exponential-backoff delay given the previous one.
 * Pure — used by the orchestrator's reconnect loop.
 */
export function nextBackoffMs(prev: number): number {
  return Math.min(BACKOFF_MAX_MS, Math.max(BACKOFF_INITIAL_MS, prev * BACKOFF_MULTIPLIER));
}

export const BACKOFF_CONSTANTS: { initialMs: number; maxMs: number; multiplier: number } = Object.freeze({
  initialMs:  BACKOFF_INITIAL_MS,
  maxMs:      BACKOFF_MAX_MS,
  multiplier: BACKOFF_MULTIPLIER,
});
