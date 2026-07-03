import { describe, it, expect, vi } from 'vitest';
import {
  PASTE_BEGIN,
  PASTE_END,
  PASTE_ENABLE,
  PASTE_DISABLE,
  isCompletePaste,
  stripPasteMarkers,
  stripAllPasteMarkers,
  hasPasteMarkers,
  enableBracketedPaste,
  disableBracketedPaste,
  decidePasteBootAction,
} from '../../../cli/v4/bracketedPaste';

describe('stripAllPasteMarkers — remove markers ANYWHERE (streamed input)', () => {
  it('strips boundary markers', () => {
    expect(stripAllPasteMarkers(`${PASTE_BEGIN}hello${PASTE_END}`)).toBe('hello');
  });
  it('strips EMBEDDED / partial markers (mid-string, only begin, only end)', () => {
    expect(stripAllPasteMarkers(`a${PASTE_BEGIN}b${PASTE_END}c`)).toBe('abc');
    expect(stripAllPasteMarkers(`${PASTE_BEGIN}only begin`)).toBe('only begin');
    expect(stripAllPasteMarkers(`only end${PASTE_END}`)).toBe('only end');
    expect(stripAllPasteMarkers(`${PASTE_BEGIN}${PASTE_END}`)).toBe('');
  });
  it('leaves clean text untouched (idempotent)', () => {
    expect(stripAllPasteMarkers('plain text, no markers')).toBe('plain text, no markers');
    expect(stripAllPasteMarkers('')).toBe('');
  });
});

describe('bracketedPaste', () => {
  it('isCompletePaste matches a full payload', () => {
    expect(isCompletePaste(`${PASTE_BEGIN}hello world${PASTE_END}`)).toBe(true);
  });

  it('isCompletePaste tolerates trailing newlines after end marker', () => {
    expect(isCompletePaste(`${PASTE_BEGIN}hi${PASTE_END}\r\n`)).toBe(true);
  });

  it('isCompletePaste rejects unterminated paste', () => {
    expect(isCompletePaste(`${PASTE_BEGIN}hello`)).toBe(false);
  });

  it('isCompletePaste rejects raw input with no markers', () => {
    expect(isCompletePaste('hello world')).toBe(false);
  });

  it('stripPasteMarkers extracts inner content from a complete paste', () => {
    expect(stripPasteMarkers(`${PASTE_BEGIN}line 1\nline 2${PASTE_END}`)).toBe('line 1\nline 2');
  });

  it('stripPasteMarkers preserves multi-line payload exactly', () => {
    const body = 'foo\nbar\nbaz';
    expect(stripPasteMarkers(`${PASTE_BEGIN}${body}${PASTE_END}`)).toBe(body);
  });

  it('stripPasteMarkers tolerates trailing newlines after end marker', () => {
    expect(stripPasteMarkers(`${PASTE_BEGIN}hi${PASTE_END}\n`)).toBe('hi');
  });

  it('stripPasteMarkers strips a stray begin marker on unterminated paste', () => {
    expect(stripPasteMarkers(`${PASTE_BEGIN}truncated`)).toBe('truncated');
  });

  it('stripPasteMarkers is a no-op on clean input', () => {
    expect(stripPasteMarkers('plain text')).toBe('plain text');
  });

  it('stripPasteMarkers handles empty string', () => {
    expect(stripPasteMarkers('')).toBe('');
  });

  it('hasPasteMarkers detects markers anywhere in the string', () => {
    expect(hasPasteMarkers('plain')).toBe(false);
    expect(hasPasteMarkers(`prefix${PASTE_BEGIN}body`)).toBe(true);
    expect(hasPasteMarkers(`body${PASTE_END}suffix`)).toBe(true);
  });

  it('enableBracketedPaste writes the CSI 2004h sequence', () => {
    const writes: string[] = [];
    const stream = { write: (s: string) => writes.push(s) } as unknown as NodeJS.WriteStream;
    expect(enableBracketedPaste(stream)).toBe(true);
    expect(writes).toEqual([PASTE_ENABLE]);
  });

  it('disableBracketedPaste writes the CSI 2004l sequence', () => {
    const writes: string[] = [];
    const stream = { write: (s: string) => writes.push(s) } as unknown as NodeJS.WriteStream;
    expect(disableBracketedPaste(stream)).toBe(true);
    expect(writes).toEqual([PASTE_DISABLE]);
  });

  it('enable/disable return false when stream is missing or invalid', () => {
    expect(enableBracketedPaste(undefined)).toBe(false);
    expect(disableBracketedPaste(undefined)).toBe(false);
    expect(enableBracketedPaste({} as any)).toBe(false);
  });

  it('enable does not throw when stream.write throws', () => {
    const stream = {
      write: vi.fn(() => {
        throw new Error('EIO');
      }),
    } as unknown as NodeJS.WriteStream;
    expect(enableBracketedPaste(stream)).toBe(false);
  });
});

describe('decidePasteBootAction — ROOT FIX gate (v4.12.1)', () => {
  it('legacy interactive TTY → enable (the interceptor needs the paste signal)', () => {
    expect(decidePasteBootAction({ isTty: true, hasPromptApi: false, frameMode: false })).toBe('enable');
  });

  it('frame-mode interactive TTY → disable (never wrap a paste; markers never generated)', () => {
    expect(decidePasteBootAction({ isTty: true, hasPromptApi: false, frameMode: true })).toBe('disable');
  });

  it('non-TTY → none (nothing to enable/disable)', () => {
    expect(decidePasteBootAction({ isTty: false, hasPromptApi: false, frameMode: false })).toBe('none');
    expect(decidePasteBootAction({ isTty: false, hasPromptApi: false, frameMode: true })).toBe('none');
  });

  it('caller-supplied promptApi → none (its own input plumbing owns paste)', () => {
    expect(decidePasteBootAction({ isTty: true, hasPromptApi: true, frameMode: false })).toBe('none');
    expect(decidePasteBootAction({ isTty: true, hasPromptApi: true, frameMode: true })).toBe('none');
  });

  it('the two escape sequences are distinct (enable ≠ disable)', () => {
    // Sanity: the fix hinges on emitting DISABLE (2004l), not ENABLE (2004h).
    expect(PASTE_ENABLE).toBe('\x1b[?2004h');
    expect(PASTE_DISABLE).toBe('\x1b[?2004l');
    expect(PASTE_ENABLE).not.toBe(PASTE_DISABLE);
  });
});
