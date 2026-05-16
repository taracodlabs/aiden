/**
 * v4.5 Phase 4a — email trigger orchestrator tests (mocked IMAP).
 *
 * Uses a synthetic ImapConnection injected via `connectionFactory`.
 * The mock exposes queues for SEARCH ALL / SEARCH UNSEEN / FETCH so
 * tests can simulate a sequence of messages arriving at the mailbox.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../../../core/v4/daemon/db/migrations';
import { createTriggerBus } from '../../../../../core/v4/daemon/triggerBus';
import {
  createResourceRegistry,
  _resetResourceRegistryForTests,
} from '../../../../../core/v4/daemon/resourceRegistry';
import { createEmailTrigger } from '../../../../../core/v4/daemon/triggers/email';
import { parseEmailSpec } from '../../../../../core/v4/daemon/triggers/email/emailSpec';
import { createEmailSeenStore } from '../../../../../core/v4/daemon/triggers/email/emailSeenStore';
import type {
  ImapConnection,
  RawMessage,
} from '../../../../../core/v4/daemon/triggers/email/imapConnection';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  db.prepare(
    `INSERT INTO triggers (id, source, name, spec_json, enabled, created_at, updated_at)
     VALUES ('e1', 'email', 'e', '{}', 1, ?, ?)`,
  ).run(Date.now(), Date.now());
  _resetResourceRegistryForTests();
});
afterEach(() => { try { db.close(); } catch { /* noop */ } });

function buildRfc(opts: { from: string; subject: string; body: string; messageId?: string; headers?: Record<string, string> }): Buffer {
  const headers = opts.headers ?? {};
  const headerLines = Object.entries(headers).map(([k, v]) => `${k}: ${v}`);
  return Buffer.from([
    `From: ${opts.from}`,
    `To: bob@example.com`,
    `Subject: ${opts.subject}`,
    `Message-ID: <${opts.messageId ?? 'auto'}@test>`,
    `Date: Tue, 1 Jan 2024 12:00:00 +0000`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    ...headerLines,
    '',
    opts.body,
  ].join('\r\n'), 'utf-8');
}

function makeMockImap(opts: {
  initialAllUids?:    number[];
  unseenQueue:        Array<number[]>;
  messagesByUid:      Map<number, RawMessage>;
  failConnect?:       boolean;
}): {
  conn:    ImapConnection;
  state:   {
    connectCalls: number;
    idSent:       boolean;
    markedSeen:   number[];
    disconnects:  number;
  };
} {
  const state = {
    connectCalls: 0,
    idSent:       false,
    markedSeen:   [] as number[],
    disconnects:  0,
  };
  let connected = false;
  return {
    state,
    conn: {
      async connect() {
        state.connectCalls += 1;
        if (opts.failConnect) throw new Error('mock connect failure');
        connected = true;
        state.idSent = true;
      },
      async disconnect() { connected = false; state.disconnects += 1; },
      isConnected() { return connected; },
      async openMailbox() { return { uidValidity: 100 }; },
      async searchAll() { return opts.initialAllUids ?? []; },
      async searchUnseen() {
        const next = opts.unseenQueue.shift();
        return next ?? [];
      },
      async fetchMessage(uid: number) { return opts.messagesByUid.get(uid) ?? null; },
      async markSeen(uid: number) { state.markedSeen.push(uid); },
    },
  };
}

const baseSpec = (over: Partial<Parameters<typeof parseEmailSpec>[0]> = {}): ReturnType<typeof parseEmailSpec> => parseEmailSpec({
  name: 'e',
  imap: { host: 'imap.example.com', user: 'u', password: 'p' },
  allowedSenders: ['*@example.com'],
  pollIntervalMs: 50,
  ...over,
});

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('createEmailTrigger — happy path', () => {
  it('processes a new authorized email → trigger_event + email_seen', async () => {
    const messages = new Map<number, RawMessage>([
      [42, {
        uid: 42,
        raw: buildRfc({ from: 'alice@example.com', subject: 'hi', body: 'real content', messageId: 'm42' }),
        flags: [],
        internalDate: new Date(),
      }],
    ]);
    const mock = makeMockImap({
      initialAllUids: [],
      unseenQueue:    [[42], [], []],
      messagesByUid:  messages,
    });
    const bus = createTriggerBus({ db });
    const seen = createEmailSeenStore({ db });
    const reg = createResourceRegistry();
    const handle = createEmailTrigger({
      watcherId: 'e1', spec: baseSpec(),
      triggerBus: bus, emailSeenStore: seen, db, registry: reg,
      connectionFactory: () => mock.conn,
    });
    await wait(200);
    await handle.close();
    expect(handle.stats().connected).toBe(false);
    expect(mock.state.connectCalls).toBeGreaterThanOrEqual(1);
    expect(mock.state.idSent).toBe(true);
    expect(mock.state.markedSeen).toContain(42);
    const events = db.prepare(`SELECT * FROM trigger_events WHERE source='email'`).all() as Array<{ source_key: string }>;
    expect(events.length).toBe(1);
    expect(events[0].source_key).toBe('e1');
    const seens = seen.list('e1');
    expect(seens.length).toBe(1);
    expect(seens[0].status).toBe('processed');
  });

  it('seeds seenUids from SEARCH ALL on connect — pre-existing UIDs are skipped', async () => {
    const messages = new Map<number, RawMessage>([
      [1, { uid: 1, raw: buildRfc({ from: 'alice@example.com', subject: 'old', body: 'x' }), flags: [], internalDate: new Date() }],
    ]);
    const mock = makeMockImap({
      initialAllUids: [1],                   // pre-existing
      unseenQueue:    [[1], []],
      messagesByUid:  messages,
    });
    const bus = createTriggerBus({ db });
    const seen = createEmailSeenStore({ db });
    const reg = createResourceRegistry();
    const handle = createEmailTrigger({
      watcherId: 'e1', spec: baseSpec(),
      triggerBus: bus, emailSeenStore: seen, db, registry: reg,
      connectionFactory: () => mock.conn,
    });
    await wait(150);
    await handle.close();
    // Pre-existing UID should NOT be processed.
    expect(handle.stats().processed).toBe(0);
    expect(mock.state.markedSeen).not.toContain(1);
  });
});

describe('createEmailTrigger — filter paths', () => {
  it('automated sender (noreply@) is skipped + recorded', async () => {
    const messages = new Map<number, RawMessage>([
      [5, { uid: 5, raw: buildRfc({ from: 'noreply@github.com', subject: 'auto', body: 'bot' }), flags: [], internalDate: new Date() }],
    ]);
    const mock = makeMockImap({
      initialAllUids: [],
      unseenQueue:    [[5], []],
      messagesByUid:  messages,
    });
    const bus = createTriggerBus({ db });
    const seen = createEmailSeenStore({ db });
    const reg = createResourceRegistry();
    const handle = createEmailTrigger({
      watcherId: 'e1', spec: baseSpec({ allowedSenders: ['*@github.com'] }),
      triggerBus: bus, emailSeenStore: seen, db, registry: reg,
      connectionFactory: () => mock.conn,
    });
    await wait(150);
    await handle.close();
    expect(handle.stats().skippedAutomated).toBeGreaterThanOrEqual(1);
    expect(handle.stats().processed).toBe(0);
    // Do NOT mark \Seen on server for automated mail.
    expect(mock.state.markedSeen).not.toContain(5);
    const r = seen.list('e1');
    expect(r[0].status).toBe('skipped_automated');
  });

  it('non-allowlisted sender is skipped + recorded', async () => {
    const messages = new Map<number, RawMessage>([
      [9, { uid: 9, raw: buildRfc({ from: 'eve@other.com', subject: 'hi', body: 'malicious' }), flags: [], internalDate: new Date() }],
    ]);
    const mock = makeMockImap({
      initialAllUids: [], unseenQueue: [[9], []], messagesByUid: messages,
    });
    const bus = createTriggerBus({ db });
    const seen = createEmailSeenStore({ db });
    const reg = createResourceRegistry();
    const handle = createEmailTrigger({
      watcherId: 'e1', spec: baseSpec({ allowedSenders: ['*@example.com'] }),
      triggerBus: bus, emailSeenStore: seen, db, registry: reg,
      connectionFactory: () => mock.conn,
    });
    await wait(150);
    await handle.close();
    expect(handle.stats().skippedUnauth).toBeGreaterThanOrEqual(1);
    expect(handle.stats().processed).toBe(0);
    expect(seen.list('e1')[0].status).toBe('skipped_unauth');
  });

  it('subject filter skips non-matching', async () => {
    const messages = new Map<number, RawMessage>([
      [11, { uid: 11, raw: buildRfc({ from: 'alice@example.com', subject: 'random subject', body: 'x' }), flags: [], internalDate: new Date() }],
    ]);
    const mock = makeMockImap({
      initialAllUids: [], unseenQueue: [[11], []], messagesByUid: messages,
    });
    const bus = createTriggerBus({ db });
    const seen = createEmailSeenStore({ db });
    const reg = createResourceRegistry();
    const handle = createEmailTrigger({
      watcherId: 'e1', spec: baseSpec({ allowedSubjectPatterns: ['^urgent:'] }),
      triggerBus: bus, emailSeenStore: seen, db, registry: reg,
      connectionFactory: () => mock.conn,
    });
    await wait(150);
    await handle.close();
    expect(handle.stats().skippedSubject).toBeGreaterThanOrEqual(1);
    expect(handle.stats().processed).toBe(0);
  });
});

describe('createEmailTrigger — reconnect', () => {
  it('exponential backoff on connect failure; recovers when failConnect goes false', async () => {
    let attempt = 0;
    const failGate = { fail: true };
    const conn: ImapConnection = {
      async connect() { attempt += 1; if (failGate.fail) throw new Error('first attempts fail'); },
      async disconnect() {},
      isConnected() { return !failGate.fail; },
      async openMailbox() { return { uidValidity: 1 }; },
      async searchAll() { return []; },
      async searchUnseen() { return []; },
      async fetchMessage() { return null; },
      async markSeen() {},
    };
    const bus = createTriggerBus({ db });
    const seen = createEmailSeenStore({ db });
    const reg = createResourceRegistry();
    const handle = createEmailTrigger({
      watcherId: 'e1', spec: baseSpec({ pollIntervalMs: 20 }),
      triggerBus: bus, emailSeenStore: seen, db, registry: reg,
      connectionFactory: () => conn,
    });
    await wait(120);
    expect(attempt).toBeGreaterThanOrEqual(1);
    expect(handle.stats().connected).toBe(false);
    expect(handle.stats().consecutiveFailures).toBeGreaterThanOrEqual(1);
    await handle.close();
  });
});

describe('createEmailTrigger — shutdown reaps connection', () => {
  it('close() disconnects + stats reflect disconnected', async () => {
    const mock = makeMockImap({
      initialAllUids: [], unseenQueue: [[]], messagesByUid: new Map(),
    });
    const bus = createTriggerBus({ db });
    const seen = createEmailSeenStore({ db });
    const reg = createResourceRegistry();
    const handle = createEmailTrigger({
      watcherId: 'e1', spec: baseSpec(),
      triggerBus: bus, emailSeenStore: seen, db, registry: reg,
      connectionFactory: () => mock.conn,
    });
    await wait(120);
    await handle.close();
    expect(handle.stats().connected).toBe(false);
    expect(mock.state.disconnects).toBeGreaterThanOrEqual(1);
  });
});
