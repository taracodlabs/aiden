import { describe, it, expect } from 'vitest';
import {
  iconForTool,
  padVerb,
  truncDetail,
  TRAIL_VERB_PAD,
  TRAIL_DETAIL_CAP,
  TRAIL_PIPE,
} from '../../../cli/v4/display/toolTrail';
import { visibleLength } from '../../../cli/v4/box';

/**
 * Pure-function unit tests for the action-trail lookup.
 *
 * Most coverage of the row format happens through `display.test.ts` (which
 * exercises `Display.toolRow()` end-to-end). This file focuses narrowly on
 * the lookup table semantics — exact match vs substring match, category
 * ordering, and the v4.1.4-media regression guards that keep `media_*`
 * tools out of the "launching" verb bucket.
 */

describe('toolTrail constants', () => {
  it('TRAIL_PIPE is the ┊ box-drawing glyph', () => {
    expect(TRAIL_PIPE).toBe('┊');
  });
  it('TRAIL_VERB_PAD = 12, TRAIL_DETAIL_CAP = 40', () => {
    expect(TRAIL_VERB_PAD).toBe(12);
    expect(TRAIL_DETAIL_CAP).toBe(40);
  });
});

describe('iconForTool — exact-match category routing', () => {
  it('file_read → reading', () => {
    // a99d6178: VS16 appended for emoji-presentation width consistency.
    expect(iconForTool('file_read')).toEqual({ icon: '👁️', verb: 'reading' });
  });
  it('file_write → writing', () => {
    expect(iconForTool('file_write')).toEqual({ icon: '✏️', verb: 'writing' });
  });
  it('skill_view → running', () => {
    expect(iconForTool('skill_view')).toEqual({ icon: '⚡', verb: 'running' });
  });
  it('shell_exec → running (v4.1.3-explicit key)', () => {
    expect(iconForTool('shell_exec')).toEqual({ icon: '⚡', verb: 'running' });
  });
  it('clipboard_read → copying (v4.1.3-new category)', () => {
    expect(iconForTool('clipboard_read')).toEqual({ icon: '📋', verb: 'copying' });
  });
  it('web_search → fetching', () => {
    expect(iconForTool('web_search')).toEqual({ icon: '🌐', verb: 'fetching' });
  });
  it('recall_session → recalling', () => {
    expect(iconForTool('recall_session')).toEqual({ icon: '🧠', verb: 'recalling' });
  });
});

// ── v4.1.4-media — regression guard for the media-control split ────────
//
// Before v4.1.4 the launch category held the substring key 'media',
// which falsely matched every media_* tool name and rendered it as
// verb "launching" (see v4.1.4 pre-commit Phase 5.5 visual smoke).
// The fix:
//   - new "Media control" category before "Media launch / open"
//   - explicit keys: media_key, media_sessions, media_transport,
//     now_playing, youtube_search → verb 'media'
//   - 'media' substring key REMOVED from the launch category
// These tests fail loudly if either regression returns.

describe('iconForTool — v4.1.4-media split (regression guards)', () => {
  it('media_key resolves to verb "media", NOT "launching"', () => {
    const r = iconForTool('media_key');
    expect(r.verb).toBe('media');
    expect(r.verb).not.toBe('launching');
  });
  it('media_sessions resolves to verb "media", NOT "launching"', () => {
    const r = iconForTool('media_sessions');
    expect(r.verb).toBe('media');
    expect(r.verb).not.toBe('launching');
  });
  it('media_transport resolves to verb "media", NOT "launching"', () => {
    const r = iconForTool('media_transport');
    expect(r.verb).toBe('media');
    expect(r.verb).not.toBe('launching');
  });
  it('now_playing resolves to verb "media" (media-control category)', () => {
    expect(iconForTool('now_playing')).toEqual({ icon: '▶', verb: 'media' });
  });
  it('youtube_search resolves to verb "media" (media-control category)', () => {
    expect(iconForTool('youtube_search')).toEqual({ icon: '▶', verb: 'media' });
  });
  it('app_launch still resolves to verb "launching" — split did not break launch', () => {
    expect(iconForTool('app_launch')).toEqual({ icon: '▶', verb: 'launching' });
  });
  it('open_url still resolves to launching/fetching family (not media)', () => {
    // open_url is in the fetch category (web/fetch/browse) — declared
    // before the launch category. Either fetching OR launching is
    // acceptable as a non-regression; assert it's NOT 'media'.
    const r = iconForTool('open_url');
    expect(r.verb).not.toBe('media');
  });
  it('arbitrary string containing "media" does NOT misroute as launching', () => {
    // Regression check: someone could re-add 'media' as a launch key
    // and this test would catch it. The fallback is acceptable; the
    // launching mis-route is not.
    const r = iconForTool('some_media_processor');
    expect(r.verb).not.toBe('launching');
  });
});

describe('iconForTool — substring fallback', () => {
  it('readableThing matches "read" → reading', () => {
    expect(iconForTool('readable_thing').verb).toBe('reading');
  });
  it('unknown tool falls back to ⚡ / calling (v4.1.3 default)', () => {
    expect(iconForTool('zzz_no_match_xxx')).toEqual({ icon: '⚡', verb: 'calling' });
  });
  it('empty string falls back to ⚡ / calling', () => {
    expect(iconForTool('')).toEqual({ icon: '⚡', verb: 'calling' });
  });
});

describe('iconForTool — case insensitive', () => {
  it('MEDIA_KEY (uppercase) resolves the same as media_key', () => {
    expect(iconForTool('MEDIA_KEY').verb).toBe('media');
  });
  it('Skill_View (mixed case) resolves to running', () => {
    expect(iconForTool('Skill_View').verb).toBe('running');
  });
});

describe('padVerb', () => {
  it('pads short verbs to TRAIL_VERB_PAD with trailing spaces', () => {
    expect(padVerb('media')).toBe('media       '); // 5 + 7 = 12
    expect(padVerb('media').length).toBe(TRAIL_VERB_PAD);
  });
  it('preserves exact-length verbs unchanged', () => {
    const exact = 'a'.repeat(TRAIL_VERB_PAD);
    expect(padVerb(exact)).toBe(exact);
  });
  it('truncates overlong verbs to TRAIL_VERB_PAD', () => {
    const overlong = 'a'.repeat(TRAIL_VERB_PAD + 5);
    expect(padVerb(overlong).length).toBe(TRAIL_VERB_PAD);
  });
});

describe('truncDetail', () => {
  it('collapses internal whitespace to a single space', () => {
    expect(truncDetail('a   b\n\nc')).toBe('a b c');
  });
  it('returns the input unchanged when ≤ TRAIL_DETAIL_CAP after flattening', () => {
    expect(truncDetail('short detail')).toBe('short detail');
  });
  it('appends "…" when truncated at TRAIL_DETAIL_CAP', () => {
    const long = 'x'.repeat(TRAIL_DETAIL_CAP + 20);
    const out = truncDetail(long);
    expect(out.length).toBe(TRAIL_DETAIL_CAP);
    expect(out.endsWith('…')).toBe(true);
  });
  it('trims leading/trailing whitespace before measuring', () => {
    expect(truncDetail('   hello   ')).toBe('hello');
  });

  it('caps ANSI-coloured text by visible terminal width without splitting escapes', () => {
    const orange = '\x1b[38;2;255;107;53m';
    const reset = '\x1b[0m';
    const out = truncDetail(`${orange}${'segment '.repeat(12)}${reset}`);
    expect(visibleLength(out)).toBeLessThanOrEqual(TRAIL_DETAIL_CAP);
    expect(out).not.toMatch(/\x1b\[[0-9;]*$/u);
  });

  it('measures wide Unicode by terminal columns and keeps whole glyphs', () => {
    const out = truncDetail('界'.repeat(TRAIL_DETAIL_CAP));
    expect(visibleLength(out)).toBeLessThanOrEqual(TRAIL_DETAIL_CAP);
    expect(out.endsWith('…')).toBe(true);
    expect(out).not.toContain('\uFFFD');
  });

  it('prefers a word boundary over a mid-word cut', () => {
    const out = truncDetail('inspect repository configuration and dependency metadata completely');
    expect(out.endsWith('…')).toBe(true);
    expect(out).not.toMatch(/configur…$/u);
  });
});
