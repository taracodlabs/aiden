/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/daemon/triggers/email/index.ts — v4.5 Phase 4a.
 *
 * Email IMAP trigger orchestrator. Wires together the supporting
 * modules:
 *   - imapConnection.ts       — IMAP wrapper + reconnect
 *   - automatedSender.ts      — noreply/bounce filter
 *   - allowlist.ts            — per-trigger sender allowlist
 *   - bodyExtractor.ts        — mailparser + text/attachment extraction
 *   - emailSeenStore.ts       — SQLite forensic table
 *   - seenUids.ts             — in-memory bounded dedup set
 *
 * Public API: `createEmailTrigger(opts) → EmailTriggerHandle`.
 *
 * Lifecycle per trigger (one trigger = one IMAP connection):
 *   1. Connect, ID command, open mailbox, capture UIDVALIDITY.
 *   2. Seed seenUids from UID SEARCH ALL — all pre-existing messages
 *      are SKIPPED on first run; reconcile-equivalent of the file
 *      watcher's skip_existing default.
 *   3. Poll loop (spec.pollIntervalMs):
 *      a. UID SEARCH UNSEEN
 *      b. For each new UID not in seenUids:
 *         - fetchMessage(uid) → raw bytes
 *         - mailparser → headers + body + attachments
 *         - isAutomatedSender? → skip (status='skipped_automated')
 *         - allowlist.isAllowed? if not → skip (status='skipped_unauth')
 *         - allowedSubjectPatterns? if mismatched → skip
 *           (status='skipped_subject')
 *         - extractEmailBody(raw, policy)
 *         - INSIDE A DB TRANSACTION:
 *             triggerBus.insert(...) → eventId
 *             emailSeenStore.record(... status='processed', eventId)
 *         - Only AFTER the tx commit: markSeen(uid) on the server.
 *           Order matters — crash mid-write loses our record but
 *           the server flag is still unset, so next poll re-fetches.
 *      c. seenUids.add(uid) in every branch (skip + processed)
 *   4. On error: log, close connection, backoff, reconnect.
 *   5. On shutdown: resourceRegistry.close() → disconnect.
 */

import type { Db } from '../../db/connection';
import type { TriggerBus } from '../../triggerBus';
import type { ResourceRegistry } from '../../resourceRegistry';
import { simpleParser } from 'mailparser';

import {
  createImapConnection,
  nextBackoffMs,
  BACKOFF_CONSTANTS,
} from './imapConnection';
import type { ImapConnection } from './imapConnection';
import {
  createEmailSeenStore,
} from './emailSeenStore';
import type { EmailSeenStore, EmailSeenStatus } from './emailSeenStore';
import { createSeenUids } from './seenUids';
import type { SeenUids } from './seenUids';
import { compileSenderAllowlist } from './allowlist';
import { isAutomatedSender } from './automatedSender';
import { extractEmailBody } from './bodyExtractor';
import type { EmailSpec } from './emailSpec';

export interface EmailStats {
  connected:           boolean;
  totalPolls:          number;
  totalMessages:       number;
  skippedAutomated:    number;
  skippedUnauth:       number;
  skippedSubject:      number;
  processed:           number;
  consecutiveFailures: number;
  lastPollAt:          number | null;
  lastError:           string | null;
  degraded:            boolean;
}

export interface EmailTriggerHandle {
  readonly watcherId:  string;
  readonly resourceId: string;
  pause():   void;
  resume():  void;
  close():   Promise<void>;
  stats():   EmailStats;
}

export interface CreateEmailTriggerOptions {
  watcherId:        string;
  spec:             EmailSpec;
  triggerBus:       TriggerBus;
  emailSeenStore?:  EmailSeenStore;          // optional override for tests
  db:               Db;
  registry:         ResourceRegistry;
  log?:             (level: 'info' | 'warn' | 'error', msg: string) => void;
  /** Inject an alternate ImapConnection factory (tests use a mock). */
  connectionFactory?: (cfg: EmailSpec['imap'], log?: (l: 'info'|'warn'|'error', m: string) => void) => ImapConnection;
}

const noopLog = (_l: 'info' | 'warn' | 'error', _m: string): void => undefined;
const DEGRADED_FAILURE_THRESHOLD = 5;

export function createEmailTrigger(opts: CreateEmailTriggerOptions): EmailTriggerHandle {
  const log = opts.log ?? noopLog;
  const seenUids: SeenUids = createSeenUids();
  const allowlist = compileSenderAllowlist(opts.spec.allowedSenders);
  const subjectRegexes: RegExp[] = (opts.spec.allowedSubjectPatterns ?? [])
    .map((s) => new RegExp(s));
  const seenStore: EmailSeenStore = opts.emailSeenStore ?? createEmailSeenStore({ db: opts.db });

  const stats: EmailStats = {
    connected:           false,
    totalPolls:          0,
    totalMessages:       0,
    skippedAutomated:    0,
    skippedUnauth:       0,
    skippedSubject:      0,
    processed:           0,
    consecutiveFailures: 0,
    lastPollAt:          null,
    lastError:           null,
    degraded:            false,
  };

  const connection: ImapConnection = (opts.connectionFactory
    ? opts.connectionFactory(opts.spec.imap, log)
    : createImapConnection({ config: opts.spec.imap, log }));

  let paused = false;
  let stopped = false;
  let pollTimer: NodeJS.Timeout | null = null;
  let backoffMs = BACKOFF_CONSTANTS.initialMs;
  let currentUidValidity = 0;

  const runConnect = async (): Promise<boolean> => {
    try {
      await connection.connect();
      const box = await connection.openMailbox(opts.spec.mailbox);
      currentUidValidity = box.uidValidity;
      stats.connected = true;
      stats.consecutiveFailures = 0;
      stats.degraded = false;
      backoffMs = BACKOFF_CONSTANTS.initialMs;
      // Seed seenUids from UID SEARCH ALL — all pre-existing UIDs
      // are SKIPPED, not processed. (Matches the file-watcher
      // skip_existing default.)
      try {
        const all = await connection.searchAll();
        seenUids.seed(all);
        log('info', `[email] ${opts.watcherId} seeded ${all.length} pre-existing UIDs (UIDVALIDITY=${currentUidValidity})`);
      } catch (e) {
        log('warn', `[email] ${opts.watcherId} seed failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      return true;
    } catch (e) {
      stats.connected = false;
      stats.consecutiveFailures += 1;
      stats.lastError = e instanceof Error ? e.message : String(e);
      if (stats.consecutiveFailures >= DEGRADED_FAILURE_THRESHOLD) {
        stats.degraded = true;
      }
      return false;
    }
  };

  const processOne = async (uid: number): Promise<void> => {
    stats.totalMessages += 1;
    const fetched = await connection.fetchMessage(uid);
    if (!fetched) {
      // Message vanished (deleted between search + fetch). Mark it
      // seen so we don't loop.
      seenUids.add(uid);
      return;
    }

    // Parse just enough headers + body to make the filter decision.
    // We pass the raw bytes onward to extractEmailBody (which calls
    // simpleParser again — accepted tradeoff: mailparser is fast
    // enough for typical email sizes and the surface stays clean).
    const parsed = await simpleParser(fetched.raw).catch(() => null);
    if (!parsed) {
      stats.lastError = `parse failure for uid ${uid}`;
      seenStore.record({
        routeId:        opts.watcherId,
        mailbox:        opts.spec.mailbox,
        uidValidity:    currentUidValidity,
        uid,
        messageId:      null,
        fromAddress:    null,
        subject:        null,
        receivedAt:     fetched.internalDate.getTime(),
        triggerEventId: null,
        status:         'failed',
      });
      seenUids.add(uid);
      return;
    }

    const fromAddress = parsed.from?.value?.[0]?.address ?? '';
    const messageId   = parsed.messageId ?? null;
    const subject     = parsed.subject ?? null;
    const receivedAt  = (parsed.date ?? fetched.internalDate).getTime();

    // Normalize headers to a plain string→string map for our filter.
    const headers: Record<string, string> = {};
    for (const [k, v] of parsed.headers.entries()) {
      headers[k.toLowerCase()] = Array.isArray(v) ? String(v[0] ?? '') : String(v);
    }

    const skipReason: EmailSeenStatus | null =
      isAutomatedSender(fromAddress, headers) ? 'skipped_automated' :
      !allowlist.isAllowed(fromAddress)       ? 'skipped_unauth' :
      (subjectRegexes.length > 0 && !subjectRegexes.some((r) => subject != null && r.test(subject)))
                                              ? 'skipped_subject' :
                                              null;

    if (skipReason) {
      if (skipReason === 'skipped_automated') stats.skippedAutomated += 1;
      if (skipReason === 'skipped_unauth')    stats.skippedUnauth    += 1;
      if (skipReason === 'skipped_subject')   stats.skippedSubject   += 1;
      seenStore.record({
        routeId:        opts.watcherId,
        mailbox:        opts.spec.mailbox,
        uidValidity:    currentUidValidity,
        uid,
        messageId,
        fromAddress,
        subject,
        receivedAt,
        triggerEventId: null,
        status:         skipReason,
      });
      seenUids.add(uid);
      // For unauth/automated: DO NOT mark \Seen on server — leave
      // the message as unread so the human user sees it in their
      // mail client. (Per audit §6.)
      return;
    }

    // Extract body + attachments per policy.
    const body = await extractEmailBody({
      raw:              fetched.raw,
      maxBodyBytes:     opts.spec.maxBodyBytes,
      attachmentPolicy: opts.spec.attachmentPolicy,
    });

    // Single tx: trigger_events insert + email_seen record. This
    // sequence is the lesson from the audit — persist locally BEFORE
    // marking \Seen on the server. Crash between tx and markSeen
    // means next poll re-fetches; better than losing record.
    const tx = opts.db.transaction((): { eventId: number } => {
      const insertResult = opts.triggerBus.insert({
        source:         'email',
        sourceKey:      opts.watcherId,
        idempotencyKey: `${currentUidValidity}::${uid}::${messageId ?? ''}`,
        payload: {
          from:        fromAddress,
          subject,
          body:        body.text,
          truncated:   body.truncated,
          textKind:    body.textKind,
          quotedReplyStripped: body.quotedReplyStripped,
          messageId,
          inReplyTo:   parsed.inReplyTo ?? null,
          references:  parsed.references ?? null,
          receivedAt,
          mailbox:     opts.spec.mailbox,
          attachments: body.attachments,
          headers,
          deliveryMode: opts.spec.deliverOnly ? 'deliver_only' : 'agent',
        },
      });
      seenStore.record({
        routeId:        opts.watcherId,
        mailbox:        opts.spec.mailbox,
        uidValidity:    currentUidValidity,
        uid,
        messageId,
        fromAddress,
        subject,
        receivedAt,
        triggerEventId: insertResult.id,
        status:         'processed',
      });
      return { eventId: insertResult.id };
    });
    tx();

    // AFTER the tx commits: mark \Seen on the IMAP server.
    await connection.markSeen(uid);

    seenUids.add(uid);
    stats.processed += 1;
  };

  const pollOnce = async (): Promise<void> => {
    if (paused || stopped) return;
    if (!connection.isConnected()) {
      const ok = await runConnect();
      if (!ok) {
        log('warn', `[email] ${opts.watcherId} reconnect backoff ${backoffMs}ms`);
        scheduleNext(backoffMs);
        backoffMs = nextBackoffMs(backoffMs);
        return;
      }
    }
    stats.lastPollAt = Date.now();
    stats.totalPolls += 1;
    try {
      const uids = await connection.searchUnseen();
      for (const uid of uids) {
        if (paused || stopped) break;
        if (seenUids.has(uid)) continue;
        try { await processOne(uid); }
        catch (e) {
          stats.lastError = e instanceof Error ? e.message : String(e);
          log('error', `[email] ${opts.watcherId} processOne uid ${uid} failed: ${stats.lastError}`);
        }
      }
      stats.consecutiveFailures = 0;
      backoffMs = BACKOFF_CONSTANTS.initialMs;
      scheduleNext(opts.spec.pollIntervalMs);
    } catch (e) {
      stats.connected = false;
      stats.consecutiveFailures += 1;
      stats.lastError = e instanceof Error ? e.message : String(e);
      if (stats.consecutiveFailures >= DEGRADED_FAILURE_THRESHOLD) {
        stats.degraded = true;
      }
      try { await connection.disconnect(); } catch { /* noop */ }
      log('warn', `[email] ${opts.watcherId} poll error: ${stats.lastError}; backoff ${backoffMs}ms`);
      scheduleNext(backoffMs);
      backoffMs = nextBackoffMs(backoffMs);
    }
  };

  const scheduleNext = (ms: number): void => {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    if (stopped) return;
    pollTimer = setTimeout(() => { void pollOnce(); }, ms);
    if (typeof pollTimer.unref === 'function') pollTimer.unref();
  };

  // Kick off the first poll cycle async — return the handle synchronously.
  void pollOnce();

  const close = async (): Promise<void> => {
    stopped = true;
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    try { await connection.disconnect(); } catch { /* best-effort */ }
    stats.connected = false;
  };

  const resourceId = opts.registry.register({
    kind:     'imap_connection',
    owner:    opts.watcherId,
    metadata: { host: opts.spec.imap.host, user: opts.spec.imap.user, mailbox: opts.spec.mailbox },
    close,
  });

  return {
    watcherId:  opts.watcherId,
    resourceId,
    pause(): void  { paused = true; },
    resume(): void {
      paused = false;
      // Re-arm immediately on resume.
      scheduleNext(0);
    },
    close,
    stats(): EmailStats { return { ...stats }; },
  };
}
