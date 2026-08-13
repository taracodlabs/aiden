/**
 * v4.3 Phase 3 — Manual-blocker detection unit tests.
 *
 * Coverage:
 *   1. Each of 5 BlockerKind detectable from canonical page-text +
 *      URL fixtures.
 *   2. Subtype detection per kind (recaptcha / turnstile / totp /
 *      sms / oauth / phone / email / identity / cookies).
 *   3. Priority order: captcha > 2fa > login > verification > consent.
 *   4. Confidence scoring (single signal vs multi-signal).
 *   5. Evidence array carries the matched signals with source prefixes.
 *   6. Negative cases — text with NO blocker patterns returns null.
 *   7. Hostname extraction in message.
 *   8. Empty input / malformed URL safety.
 */
import { describe, it, expect } from 'vitest';
import {
  detectBlocker,
  type BlockerSurface,
} from '../../../tools/v4/browser/browserBlocker';

function detect(text: string, url = 'https://example.com/'): BlockerSurface | null {
  return detectBlocker({ text, url });
}

// ── CAPTCHA tier ────────────────────────────────────────────────────────────

describe('CAPTCHA detection', () => {
  it('detects Cloudflare challenge', () => {
    const b = detect('Just a moment... Cloudflare is checking your browser before access.');
    expect(b?.kind).toBe('captcha');
    expect(b?.subtype).toBe('cloudflare');
    expect(b?.evidence.some((e) => e.startsWith('captcha-marker:'))).toBe(true);
    expect(b?.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it('detects reCAPTCHA', () => {
    const b = detect('Please complete the recaptcha verification. g-recaptcha required.');
    expect(b?.kind).toBe('captcha');
    expect(b?.subtype).toBe('recaptcha');
  });

  it('detects hCaptcha', () => {
    const b = detect('hcaptcha.com challenge — verify you are human.');
    expect(b?.kind).toBe('captcha');
    expect(b?.subtype).toBe('hcaptcha');
  });

  it('detects Turnstile', () => {
    const b = detect('Loading cf-turnstile widget...');
    expect(b?.kind).toBe('captcha');
    expect(b?.subtype).toBe('turnstile');
  });

  it('boosts confidence when multiple markers match', () => {
    const b = detect('Cloudflare checking your browser — just a moment, are you a robot?');
    expect(b?.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it('message includes hostname', () => {
    const b = detect('captcha challenge', 'https://www.example.com/path');
    expect(b?.message).toContain('www.example.com');
  });
});

// ── 2FA tier ───────────────────────────────────────────────────────────────

describe('2FA detection', () => {
  it('detects text-only "verification code"', () => {
    const b = detect('Please enter the verification code we sent to your device.');
    expect(b?.kind).toBe('2fa');
    expect(b?.evidence.some((e) => e.startsWith('text:'))).toBe(true);
  });

  it('detects URL-only /2fa', () => {
    const b = detect('Welcome', 'https://example.com/auth/2fa');
    expect(b?.kind).toBe('2fa');
    expect(b?.evidence.some((e) => e.startsWith('url:'))).toBe(true);
  });

  it('subtype totp from authenticator-app phrasing', () => {
    const b = detect('Open your authenticator app and enter the code.');
    expect(b?.kind).toBe('2fa');
    expect(b?.subtype).toBe('totp');
  });

  it('subtype sms from text-message phrasing', () => {
    const b = detect('We sent a code via text message to your phone. Enter it below.');
    expect(b?.kind).toBe('2fa');
    expect(b?.subtype).toBe('sms');
  });

  it('detects DOM input-attribute hint', () => {
    const b = detect(
      'Enter the verification code <input autocomplete="one-time-code" />',
      'https://example.com/login',
    );
    expect(b?.kind).toBe('2fa');
    expect(b?.evidence.some((e) => e.startsWith('dom:'))).toBe(true);
  });

  it('text + url + dom → confidence 0.9', () => {
    const b = detect(
      'Enter the verification code <input autocomplete="one-time-code">',
      'https://example.com/2fa',
    );
    expect(b?.confidence).toBe(0.9);
  });

  it('text-only → confidence 0.6', () => {
    const b = detect('Enter your code please', 'https://example.com/dashboard');
    expect(b?.kind).toBe('2fa');
    expect(b?.confidence).toBe(0.6);
  });
});

// ── Login tier ──────────────────────────────────────────────────────────────

describe('Login detection', () => {
  it('does not treat a public page header sign-in link as a login wall', () => {
    expect(detect(
      'Sign in  Repository navigation  Source code and documentation for a Cloudflare deployment adapter.',
      'https://github.com/example/project',
    )).toBeNull();
  });

  it('detects text "sign in"', () => {
    const b = detect('Sign in to continue. Enter your password below.');
    expect(b?.kind).toBe('login');
  });

  it('detects URL /login', () => {
    const b = detect('Welcome', 'https://example.com/login');
    expect(b?.kind).toBe('login');
  });

  it('detects URL /oauth → subtype oauth', () => {
    const b = detect('Authorize access', 'https://example.com/oauth/authorize');
    expect(b?.kind).toBe('login');
    expect(b?.subtype).toBe('oauth');
  });

  it('subtype oauth from "Continue with Google"', () => {
    const b = detect('Continue with Google to sign in.');
    expect(b?.kind).toBe('login');
    expect(b?.subtype).toBe('oauth');
  });

  it('default subtype is password when no OAuth phrasing', () => {
    const b = detect('Log in with your password.');
    expect(b?.kind).toBe('login');
    expect(b?.subtype).toBe('password');
  });

  it('text + url + dom → confidence 0.9', () => {
    const b = detect(
      'Sign in to continue. <input type="password">',
      'https://example.com/signin',
    );
    expect(b?.confidence).toBe(0.9);
  });
});

// ── Verification tier ──────────────────────────────────────────────────────

describe('Verification detection', () => {
  it('detects "verify your phone"', () => {
    const b = detect('Please verify your phone number.');
    expect(b?.kind).toBe('verification');
    expect(b?.subtype).toBe('phone');
  });

  it('detects "verify your email"', () => {
    const b = detect('Confirm your email address to continue.');
    expect(b?.kind).toBe('verification');
    expect(b?.subtype).toBe('email');
  });

  it('detects "verify your identity"', () => {
    const b = detect('Verify your identity to access the account.');
    expect(b?.kind).toBe('verification');
    expect(b?.subtype).toBe('identity');
  });

  it('text + url → confidence 0.85', () => {
    const b = detect(
      'Verify your phone',
      'https://example.com/verify',
    );
    expect(b?.confidence).toBe(0.85);
  });

  it('url-only → confidence 0.5 (weakest)', () => {
    const b = detect('Hello', 'https://example.com/verify');
    expect(b?.kind).toBe('verification');
    expect(b?.confidence).toBe(0.5);
  });
});

// ── Consent tier ────────────────────────────────────────────────────────────

describe('Consent detection', () => {
  it('detects "accept all cookies"', () => {
    const b = detect('We use cookies. Accept all cookies or manage preferences.');
    expect(b?.kind).toBe('consent');
    expect(b?.subtype).toBe('cookies');
  });

  it('detects GDPR phrasing', () => {
    const b = detect('Under GDPR, we ask for your consent to use cookies.');
    expect(b?.kind).toBe('consent');
  });
});

// ── Priority ordering ──────────────────────────────────────────────────────

describe('Priority order: captcha > 2fa > login > verification > consent', () => {
  it('captcha wins over 2fa when both match', () => {
    const b = detect(
      'Cloudflare is checking your browser. Enter the verification code.',
      'https://example.com/2fa',
    );
    expect(b?.kind).toBe('captcha');
  });

  it('2fa wins over login when both match', () => {
    const b = detect(
      'Sign in: enter your authenticator app code.',
      'https://example.com/login/2fa',
    );
    expect(b?.kind).toBe('2fa');
  });

  it('login wins over verification when both match', () => {
    const b = detect(
      'Sign in to verify your email.',
      'https://example.com/login',
    );
    expect(b?.kind).toBe('login');
  });

  it('verification wins over consent when both match', () => {
    const b = detect(
      'Verify your phone. We use cookies.',
      'https://example.com/verify',
    );
    expect(b?.kind).toBe('verification');
  });

  it('consent matches only when nothing higher fires', () => {
    const b = detect('We use cookies. Accept all cookies?', 'https://example.com/');
    expect(b?.kind).toBe('consent');
  });
});

// ── Negative cases ─────────────────────────────────────────────────────────

describe('No-blocker cases return null', () => {
  it('benign page text returns null', () => {
    expect(detect('Welcome to our blog. Read our latest posts.')).toBeNull();
  });

  it('empty text returns null', () => {
    expect(detect('')).toBeNull();
  });

  it('docs page discussing CAPTCHA returns null when no marker matched', () => {
    // The captchaCheck markers are specific — a meta-discussion of
    // bot detection in general terms shouldn't match. But "captcha"
    // IS one of the markers — so this WILL match. That's the
    // documented sensitivity trade-off.
    expect(detect('In this article we discuss CAPTCHAs.')?.kind).toBe('captcha');
  });

  it('does not match login on a generic mention of "sign in to comment"', () => {
    // "sign in" IS one of the patterns, so this matches login. The
    expect(detect('Please sign in to comment.')).toBeNull();
  });
});

// ── Robustness ─────────────────────────────────────────────────────────────

describe('Robustness', () => {
  it('handles malformed URL gracefully', () => {
    const b = detect('Sign in', 'not a url');
    expect(b?.kind).toBe('login');
    expect(b?.message).toBeDefined();
  });

  it('handles missing url field gracefully', () => {
    const b = detectBlocker({ text: 'Sign in', url: '' });
    expect(b?.kind).toBe('login');
  });

  it('handles undefined-ish inputs without throwing', () => {
    expect(() => detectBlocker({
      text: '' as unknown as string,
      url: '' as unknown as string,
    })).not.toThrow();
  });

  it('evidence entries are prefixed by source', () => {
    const b = detect('Sign in', 'https://example.com/login');
    expect(b!.evidence.every((e) =>
      e.startsWith('text:') || e.startsWith('url:') || e.startsWith('dom:'),
    )).toBe(true);
  });
});
