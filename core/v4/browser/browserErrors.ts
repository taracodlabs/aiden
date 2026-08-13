/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { BrowserAuthorityError } from './browserSessionAuthority';

export type BrowserErrorCode =
  | 'SESSION_LOST' | 'SESSION_NOT_AUTHORIZED' | 'SESSION_NOT_ACTIONABLE'
  | 'TAB_NOT_OWNED' | 'TAB_NOT_CLOSEABLE' | 'PAGE_CLOSED'
  | 'STALE_ELEMENT' | 'AMBIGUOUS_ELEMENT' | 'ELEMENT_NOT_FOUND'
  | 'ELEMENT_NOT_VISIBLE' | 'ELEMENT_DISABLED' | 'NAVIGATION_TIMEOUT'
  | 'NO_PROGRESS' | 'BUDGET_EXHAUSTED' | 'BLOCKED_BY_LOGIN'
  | 'BLOCKED_BY_CAPTCHA' | 'DIALOG_PENDING' | 'APPROVAL_REQUIRED'
  | 'APPROVAL_STALE' | 'ACTION_CANCELLED' | 'ACTION_UNKNOWN'
  | 'ACTION_NOT_FOUND'
  | 'FRESH_OBSERVATION_REQUIRED'
  | 'UPLOAD_FAILED' | 'DOWNLOAD_FAILED' | 'VERIFICATION_FAILED'
  | 'UNEXPECTED_PAGE_STATE';

export interface BrowserTypedError {
  code: BrowserErrorCode;
  message: string;
  retryable: boolean;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error ?? 'Unknown browser failure');
}

export function classifyBrowserError(error: unknown, operation = ''): BrowserTypedError {
  const message = messageOf(error);
  if (error instanceof BrowserAuthorityError) {
    return { code: error.code as BrowserErrorCode, message, retryable: error.code === 'NO_PROGRESS' };
  }
  const text = `${operation} ${message}`.toLowerCase();
  const match = (pattern: RegExp, code: BrowserErrorCode, retryable = false): BrowserTypedError | null =>
    pattern.test(text) ? { code, message, retryable } : null;
  return match(/abort|cancel/, 'ACTION_CANCELLED')
    ?? match(/target closed|page.*closed|context.*closed/, 'PAGE_CLOSED', true)
    ?? match(/stale|detached from the dom|not attached/, 'STALE_ELEMENT', true)
    ?? match(/ambiguous|more than one|multiple matches/, 'AMBIGUOUS_ELEMENT')
    ?? match(/not found|no such element|does not exist/, 'ELEMENT_NOT_FOUND', true)
    ?? match(/not visible|hidden/, 'ELEMENT_NOT_VISIBLE', true)
    ?? match(/disabled/, 'ELEMENT_DISABLED')
    ?? match(/timeout|timed out/, 'NAVIGATION_TIMEOUT', true)
    ?? match(/captcha|bot challenge/, 'BLOCKED_BY_CAPTCHA')
    ?? match(/sign in|log in|login|required authentication/, 'BLOCKED_BY_LOGIN')
    ?? match(/dialog.*pending|pending dialog/, 'DIALOG_PENDING')
    ?? match(/approval.*stale|binding mismatch/, 'APPROVAL_STALE')
    ?? match(/approval.*required|interactive approval/, 'APPROVAL_REQUIRED')
    ?? match(/upload/, 'UPLOAD_FAILED')
    ?? match(/download/, 'DOWNLOAD_FAILED')
    ?? match(/verif|did not match|no progress|unchanged/, 'VERIFICATION_FAILED')
    ?? { code: 'UNEXPECTED_PAGE_STATE', message, retryable: false };
}

export function classifyBrowserResult(result: unknown, operation = ''): BrowserTypedError | null {
  if (!result || typeof result !== 'object') return null;
  const value = result as { success?: unknown; error?: unknown; verified?: unknown; captcha_detected?: unknown };
  if (value.captcha_detected === true) {
    return { code: 'BLOCKED_BY_CAPTCHA', message: messageOf(value.error), retryable: false };
  }
  if (value.success === false) return classifyBrowserError(value.error, operation);
  if (value.success === true && value.verified === false) {
    return { code: 'VERIFICATION_FAILED', message: messageOf(value.error ?? 'Browser result was not verified'), retryable: false };
  }
  return null;
}
