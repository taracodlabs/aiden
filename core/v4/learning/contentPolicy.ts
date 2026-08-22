/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { containsSecret } from '../../secretScanner';

const MAX_LEARNING_CHARS = 8_000;
const AUTHORITY_OVERRIDE_PATTERNS = [
  /ignore\s+(?:all\s+)?previous\s+instructions/i,
  /ignore\s+(?:all\s+)?(?:approvals?|permissions?|polic(?:y|ies)|security)\b/i,
  /approve\s+(?:every|all)\b/i,
  /grant\s+(?:unrestricted|unlimited|all)\s+(?:filesystem|network|shell|command|tool|capabilit(?:y|ies)|permissions?|access)\b/i,
  /without\s+(?:asking|approval|permission)/i,
  /bypass\s+(?:approval|permission|policy|security)/i,
  /disable\s+(?:approval|permission|policy|security)/i,
  /exfiltrat(?:e|ion)\b/i,
  /reveal\s+(?:credentials|secrets|tokens|passwords)/i,
];
const SENSITIVE_LEARNING_PATTERNS = [
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/i,
  /\b(?:access[_-]?token|refresh[_-]?token|oauth[_-]?token)["'\s:=]+["']?[A-Za-z0-9._~+\/-]{12,}/i,
];

export function normalizeLearningContent(value: string): string {
  const normalized = value.replace(/\r\n?/g, '\n').trim();
  if (!normalized) throw new Error('Learning content cannot be empty');
  if (normalized.length > MAX_LEARNING_CHARS) {
    throw new Error(`Learning content exceeds ${MAX_LEARNING_CHARS} characters`);
  }
  if (containsSecret(normalized) || SENSITIVE_LEARNING_PATTERNS.some((pattern) => pattern.test(normalized))) {
    throw new Error('Sensitive content cannot be stored in Learning');
  }
  if (AUTHORITY_OVERRIDE_PATTERNS.some((pattern) => pattern.test(normalized))) {
    throw new Error('Unsafe learning content cannot change approval, permission, policy, or security authority');
  }
  return normalized;
}

export function isRetrievalSafeContent(value: string): boolean {
  try {
    normalizeLearningContent(value);
    return true;
  } catch {
    return false;
  }
}
