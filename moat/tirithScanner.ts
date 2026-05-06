/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * moat/tirithScanner.ts — Aiden v4.0.0
 *
 * Content scanner. Catches injection patterns the dangerous-patterns
 * regex catalog doesn't cover:
 *
 *   - Homograph URLs (Cyrillic / Greek / fullwidth chars in domains)
 *   - Punycode-encoded domains that decode to suspicious mixed scripts
 *   - ANSI escape sequences embedded in content (terminal injection
 *     when later `cat`-ed)
 *   - Pipe-to-interpreter shell patterns (overlap with dangerousPatterns
 *     is fine — tirith scans LLM output / tool args for the same)
 *   - Unicode anomalies — zero-width joiners, RTL bidi overrides
 *
 * Status: PHASE 9.
 */

export type TirithSeverity = 'caution' | 'dangerous';

export type TirithFindingType =
  | 'homograph_url'
  | 'punycode_url'
  | 'terminal_injection'
  | 'pipe_to_interpreter'
  | 'unicode_anomaly';

export interface TirithFinding {
  type: TirithFindingType;
  severity: TirithSeverity;
  description: string;
  matchedText: string;
}

// Cyrillic / Greek / Armenian / fullwidth ranges that overlap visually
// with ASCII. Matching ANY codepoint in these ranges inside a hostname
// is enough to flag homograph.
const HOMOGRAPH_RANGES: Array<[number, number]> = [
  [0x0400, 0x04ff], // Cyrillic
  [0x0370, 0x03ff], // Greek
  [0x0530, 0x058f], // Armenian
  [0xff00, 0xffef], // Fullwidth / halfwidth
];

const ANSI_ESCAPE = /\x1b\[[0-9;?]*[A-Za-z]/g;
// eslint-disable-next-line no-misleading-character-class
const ZERO_WIDTH = /[​‌‍⁠﻿]/;
const BIDI_OVERRIDE = /[‪-‮⁦-⁩]/;

const PIPE_TO_INTERPRETER =
  /\b(curl|wget|invoke-webrequest)\b[^|]*\|\s*(sh|bash|zsh|ksh|fish|python[23]?|node|perl|ruby|powershell|pwsh)\b/i;

export class TirithScanner {
  scan(text: string): TirithFinding[] {
    const findings: TirithFinding[] = [];
    findings.push(...this.scanCommand(text));
    findings.push(...scanForAnsi(text));
    findings.push(...scanForUnicodeAnomalies(text));
    // URL extraction — anything that looks like a URL goes through scanUrl.
    const urlMatches = text.match(/https?:\/\/[^\s"'`<>]+/gi) ?? [];
    for (const u of urlMatches) findings.push(...this.scanUrl(u));
    return dedupe(findings);
  }

  scanUrl(url: string): TirithFinding[] {
    const findings: TirithFinding[] = [];
    // Pull the host from the RAW URL string before WHATWG-URL parsing,
    // because `new URL()` silently normalizes Cyrillic et al. to
    // punycode (xn--...). We need the pre-normalized form to see the
    // original homograph characters.
    const rawHostMatch = url.match(/^[a-z]+:\/\/([^/?#]+)/i);
    if (!rawHostMatch) return findings;
    const rawHost = rawHostMatch[1].split('@').pop()!.split(':')[0];

    for (const ch of rawHost) {
      const cp = ch.codePointAt(0)!;
      if (cp >= 0x80 && inAnyRange(cp, HOMOGRAPH_RANGES)) {
        findings.push({
          type: 'homograph_url',
          severity: 'dangerous',
          description: `Homograph hostname contains non-ASCII character look-alike: ${ch} (U+${cp.toString(16).toUpperCase().padStart(4, '0')})`,
          matchedText: rawHost,
        });
        break;
      }
    }

    if (/(^|\.)xn--/i.test(rawHost)) {
      findings.push({
        type: 'punycode_url',
        severity: 'caution',
        description: `Punycode hostname (IDN-encoded): inspect carefully`,
        matchedText: rawHost,
      });
    }
    return findings;
  }

  scanCommand(command: string): TirithFinding[] {
    const findings: TirithFinding[] = [];
    const m = command.match(PIPE_TO_INTERPRETER);
    if (m) {
      findings.push({
        type: 'pipe_to_interpreter',
        severity: 'dangerous',
        description: `Remote content piped into an interpreter`,
        matchedText: m[0],
      });
    }
    return findings;
  }
}

function scanForAnsi(text: string): TirithFinding[] {
  const out: TirithFinding[] = [];
  const matches = text.match(ANSI_ESCAPE);
  if (matches && matches.length > 0) {
    out.push({
      type: 'terminal_injection',
      severity: 'caution',
      description: `ANSI escape sequence(s) embedded — possible terminal injection if cat-ed`,
      matchedText: matches[0],
    });
  }
  return out;
}

function scanForUnicodeAnomalies(text: string): TirithFinding[] {
  const out: TirithFinding[] = [];
  const zw = text.match(ZERO_WIDTH);
  if (zw) {
    out.push({
      type: 'unicode_anomaly',
      severity: 'caution',
      description: `Zero-width character detected (U+${zw[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')})`,
      matchedText: zw[0],
    });
  }
  const bd = text.match(BIDI_OVERRIDE);
  if (bd) {
    out.push({
      type: 'unicode_anomaly',
      severity: 'dangerous',
      description: `Bidi override character — text-direction trick (U+${bd[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')})`,
      matchedText: bd[0],
    });
  }
  return out;
}

function inAnyRange(cp: number, ranges: Array<[number, number]>): boolean {
  for (const [lo, hi] of ranges) if (cp >= lo && cp <= hi) return true;
  return false;
}

function dedupe(arr: TirithFinding[]): TirithFinding[] {
  const seen = new Set<string>();
  const out: TirithFinding[] = [];
  for (const f of arr) {
    const key = `${f.type}::${f.matchedText}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}
