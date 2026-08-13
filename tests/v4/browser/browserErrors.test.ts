import { describe, expect, it } from 'vitest';

import { classifyBrowserError, classifyBrowserResult } from '../../../core/v4/browser/browserErrors';
import { BrowserAuthorityError } from '../../../core/v4/browser/browserSessionAuthority';

describe('typed browser errors', () => {
  it.each([
    ['Target page, context or browser has been closed', 'PAGE_CLOSED'],
    ['Element not found', 'ELEMENT_NOT_FOUND'],
    ['Element is not visible', 'ELEMENT_NOT_VISIBLE'],
    ['Timeout 5000ms exceeded', 'NAVIGATION_TIMEOUT'],
    ['Sign in is required', 'BLOCKED_BY_LOGIN'],
    ['Interactive approval is required', 'APPROVAL_REQUIRED'],
    ['Upload file is unavailable', 'UPLOAD_FAILED'],
    ['Download did not complete', 'DOWNLOAD_FAILED'],
  ])('maps %s to %s', (message, code) => {
    expect(classifyBrowserError(new Error(message))).toMatchObject({ code, message });
  });

  it('preserves durable authority error identity', () => {
    expect(classifyBrowserError(new BrowserAuthorityError('TAB_NOT_OWNED', 'wrong Job')))
      .toMatchObject({ code: 'TAB_NOT_OWNED', message: 'wrong Job' });
  });

  it('separates protocol success from failed verification', () => {
    expect(classifyBrowserResult({ success: true, verified: false }))
      .toMatchObject({ code: 'VERIFICATION_FAILED' });
    expect(classifyBrowserResult({ success: false, error: 'CAPTCHA challenge', captcha_detected: true }))
      .toMatchObject({ code: 'BLOCKED_BY_CAPTCHA' });
  });
});
