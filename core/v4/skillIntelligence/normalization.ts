/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { createHash } from 'node:crypto';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}

export function digest(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : stableJson(value)).digest('hex');
}

export function normalizedIdentifier(value: string, fallback = 'workflow'): string {
  const normalized = value.normalize('NFKC').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return normalized || fallback;
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:api[_-]?key|secret|password|token)\s*[:=]\s*["'][^"']{12,}["']/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bbearer\s+[A-Za-z0-9._~+\/-]{24,}\b/i,
];

export function assertNoSensitiveContent(value: unknown): void {
  const text = typeof value === 'string' ? value : stableJson(value);
  if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) {
    throw new Error('Skill content contains sensitive credential material');
  }
}

export function assertNoExecutableCode(value: unknown): void {
  const text = typeof value === 'string' ? value : stableJson(value);
  if (/```\s*(?:powershell|pwsh|bash|sh|cmd|javascript|typescript|python|ruby|perl|node)\b/i.test(text)
      || /<script\b/i.test(text)
      || /\b(?:Invoke-Expression|eval\s*\(|new\s+Function\s*\()/i.test(text)) {
    throw new Error('Skill draft contains executable code; executable behavior must be a Capability');
  }
}

export function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

export function uniqueSorted<T extends string | number>(items: readonly T[]): T[] {
  return [...new Set(items)].sort((left, right) => String(left).localeCompare(String(right)));
}
