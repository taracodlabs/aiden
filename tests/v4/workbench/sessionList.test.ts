/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * Workbench Phase 3 — the sidebar's session labels.
 *
 * Proves createSessionLister produces READABLE labels (never raw ids): the
 * distilled title when present, else a snippet of the first user message, else a
 * neutral fallback — and that the row id aligns with the session for the feed.
 */
import { describe, it, expect } from 'vitest';
import { SessionStore } from '../../../core/v4/sessionStore';
import { createSessionLister } from '../../../core/v4/workbench/sessionList';

function rowFor(store: SessionStore, id: string) {
  return createSessionLister(store).listSessions().find((x) => x.id === id)!;
}

describe('createSessionLister — readable labels, never raw ids', () => {
  it('uses the distilled title when present', () => {
    const s = new SessionStore(':memory:');
    const rec = s.createSession({ title: 'Refactor the auth flow' });
    const row = rowFor(s, rec.id);
    expect(row.label).toBe('Refactor the auth flow');
    expect(row.label).not.toBe(rec.id);
  });

  it('falls back to the first user-message snippet when untitled (whitespace-collapsed)', () => {
    const s = new SessionStore(':memory:');
    const rec = s.createSession({});
    s.appendMessage(rec.id, { role: 'user', content: '  hey, can you   fix the flaky test in parser.ts?  \n more' });
    const row = rowFor(s, rec.id);
    expect(row.label).toBe('hey, can you fix the flaky test in parser.ts? more');
    expect(row.label).not.toMatch(/^[0-9a-f-]{36}$/);   // not a raw UUID
  });

  it('truncates a long snippet with an ellipsis', () => {
    const s = new SessionStore(':memory:');
    const rec = s.createSession({});
    s.appendMessage(rec.id, { role: 'user', content: 'x'.repeat(200) });
    const row = rowFor(s, rec.id);
    expect(row.label.length).toBeLessThanOrEqual(73);
    expect(row.label.endsWith('…')).toBe(true);
  });

  it('falls back to a timestamp label when untitled and no user message', () => {
    const s = new SessionStore(':memory:');
    const rec = s.createSession({});
    const label = rowFor(s, rec.id).label;
    expect(label).toMatch(/^Session · \d{4}-\d\d-\d\d \d\d:\d\d$/);   // readable time, not "(untitled)"
    expect(label).not.toBe(rec.id);
  });

  it('strips bracketed-paste artifacts from a pasted first message', () => {
    const s = new SessionStore(':memory:');
    const rec = s.createSession({});
    s.appendMessage(rec.id, { role: 'user', content: '\x1b[200~paste me\x1b[201~ then more' });
    expect(rowFor(s, rec.id).label).toBe('paste me then more');
  });

  it('strips ESC-stripped leftovers ([200~ / [201~) from a title too', () => {
    const s = new SessionStore(':memory:');
    const rec = s.createSession({ title: '[200~fix the parser[201~' });
    expect(rowFor(s, rec.id).label).toBe('fix the parser');
  });

  it('carries lastActive and keeps the id aligned for /api/sessions/:id/events', () => {
    const s = new SessionStore(':memory:');
    const rec = s.createSession({ title: 't' });
    const row = rowFor(s, rec.id);
    expect(row.id).toBe(rec.id);
    expect(typeof row.lastActive).toBe('number');
  });
});
