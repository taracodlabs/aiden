/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/browser/browserBlocker.ts — v4.3 Phase 3: Manual-blocker
 * detection.
 *
 * Five-tier substring + URL pattern pipeline that surfaces "the
 * agent needs your help" situations: CAPTCHA challenges, sign-in
 * walls, 2FA prompts, identity verification, cookie/GDPR consent.
 *
 * Distinct from Phase 1's BrowserState observer (which records
 * state-delta evidence) and Phase 2's stale-ref retry (which auto-
 * corrects transient races). Phase 3 detects situations that
 * **cannot be solved by retry** — the page is asking for a human
 * action — and surfaces them as structured cards so the model
 * doesn't grind through retry attempts.
 *
 * Non-negotiable: NEVER auto-solve a CAPTCHA. The pause-and-surface
 * contract from Q-CDP5(c) is enforced structurally — this module
 * only detects + surfaces. No vision-attempt fallback, no clicking
 * "I'm not a robot" tickboxes, no submitting forms blindly. The
 * model reads `result.browserState.blocker` in its tool message and
 * tells the user.
 *
 * The CAPTCHA tier reuses Aiden's existing `captchaCheck.ts` 24-
 * marker scan — Phase 3 doesn't refactor it, only wraps it as one
 * of five detectors. The other four tiers (2FA, login, verification,
 * consent) are new in Phase 3.
 *
 * Priority order: captcha > 2fa > login > verification > consent.
 * Only ONE blocker reported per detection (highest priority wins).
 * Pages that match multiple tiers (a 2FA challenge inside an
 * obscured cookie banner) report the most-blocking kind — the
 * lower-priority match can wait until the higher-priority is
 * cleared.
 *
 * Pure module — types + 5 detectors + 1 orchestrator. No I/O, no
 * async, no Playwright dependency. Easy to unit-test against
 * canonical page-text fixtures. The observer HOC consumes the
 * `pwSnapshot()` text via the existing playwrightBridge helper.
 */

import { detectCaptchaMarkers } from './captchaCheck';

// ── Public types ────────────────────────────────────────────────────────────

/** Coarse blocker categories — 5 values for routing decisions. */
export type BlockerKind =
  | 'captcha'
  | 'login'
  | '2fa'
  | 'verification'
  | 'consent';

/** Structured manual-blocker surface for the agent + chat layer. */
export interface BlockerSurface {
  /** Coarse category — what's blocking. */
  kind:       BlockerKind;
  /**
   * Optional subtype — `recaptcha` / `hcaptcha` / `cloudflare` /
   * `turnstile` / `totp` / `sms` / `password` / `oauth` /
   * `phone` / `email` / `identity` / `cookies` / `unknown`.
   * Diagnostic only; routing logic keys on `kind`.
   */
  subtype?:   string;
  /** Page URL where the blocker was detected. */
  url:        string;
  /**
   * 0.0–1.0 confidence based on count + strength of matched signals.
   * Single-text-marker → 0.6, marker + URL pattern → 0.8, marker
   * + URL + DOM-style signal → 0.9. Floor at 0.4.
   */
  confidence: number;
  /**
   * Which detection signals fired, prefixed with their source:
   *   - `text:enter the code`
   *   - `url:/2fa`
   *   - `dom:input[autocomplete=one-time-code]`
   *   - `captcha-marker:cloudflare`
   * Public for tests + Phase 5 classifier consumption.
   */
  evidence:   string[];
  /** Short human-readable explanation rendered to the user. */
  message:    string;
}

/** Input to the orchestrator. */
export interface BlockerDetectionInput {
  /** Page innerText, ideally truncated to ~3000-5000 chars. */
  text: string;
  /** Current page URL. */
  url:  string;
}

// ── Pattern tables ──────────────────────────────────────────────────────────

// CAPTCHA tier reuses captchaCheck.ts markers + adds subtype detection.

const CAPTCHA_SUBTYPE_MARKERS: ReadonlyArray<[string, string]> = [
  ['recaptcha',     'recaptcha'],
  ['g-recaptcha',   'recaptcha'],
  ['hcaptcha.com',  'hcaptcha'],
  ['cf-turnstile',  'turnstile'],
  ['cloudflare',    'cloudflare'],
  ['just a moment', 'cloudflare'],
  ['checking your browser', 'cloudflare'],
];

// 2FA / MFA tier — input attributes, text, and URL.

const TWOFA_TEXT_PATTERNS: ReadonlyArray<string> = [
  'enter the code',
  'enter your code',
  'verification code',
  'authentication code',
  '6-digit code',
  'two-factor',
  'two factor',
  '2-step verification',
  'two-step verification',
  'authenticator app',
  'sms code',
  'sent a code',
  'we sent you a code',
  'text message',
  'security code',
  'one-time code',
  'one-time password',
];

const TWOFA_URL_PATTERNS: ReadonlyArray<string> = [
  '/2fa',
  '/mfa',
  '/verify-code',
  '/verify_code',
  '/auth/challenge',
  '/two-factor',
  '/two_factor',
];

const TWOFA_DOM_HINTS: ReadonlyArray<string> = [
  'autocomplete="one-time-code"',
  "autocomplete='one-time-code'",
  'inputmode="numeric"',
];

const TWOFA_SUBTYPE_HINTS: ReadonlyArray<[string, string]> = [
  ['authenticator app', 'totp'],
  ['totp',              'totp'],
  ['sms',               'sms'],
  ['text message',      'sms'],
  ['phone',             'sms'],
];

// Login tier — sign-in forms, OAuth, SSO.

const LOGIN_TEXT_PATTERNS: ReadonlyArray<string> = [
  'sign in',
  'sign-in',
  'log in',
  'log-in',
  'login',
  'enter your password',
  'enter password',
  'continue with google',
  'continue with apple',
  'continue with github',
  'continue with microsoft',
  'sign in with',
  'single sign-on',
  'single sign on',
];

const LOGIN_URL_PATTERNS: ReadonlyArray<string> = [
  '/login',
  '/signin',
  '/sign-in',
  '/auth',
  '/oauth',
  '/sso',
  '/account/login',
];

const LOGIN_DOM_HINTS: ReadonlyArray<string> = [
  'type="password"',
  "type='password'",
  'input password',   // generic fallback
];

const LOGIN_SUBTYPE_HINTS: ReadonlyArray<[string, string]> = [
  ['oauth',                'oauth'],
  ['sso',                  'oauth'],
  ['continue with google', 'oauth'],
  ['continue with apple',  'oauth'],
  ['continue with github', 'oauth'],
];

// Verification tier — identity / phone / email confirmation.

const VERIFY_TEXT_PATTERNS: ReadonlyArray<string> = [
  'verify your phone',
  'phone verification',
  'verify your email',
  'email verification',
  'confirm your email',
  'verify your identity',
  'identity verification',
  'identity check',
  'prove your identity',
];

const VERIFY_URL_PATTERNS: ReadonlyArray<string> = [
  '/verify',
  '/verification',
  '/confirm',
  '/confirm-email',
  '/confirm_email',
];

const VERIFY_SUBTYPE_HINTS: ReadonlyArray<[string, string]> = [
  ['phone',    'phone'],
  ['email',    'email'],
  ['identity', 'identity'],
];

// Consent tier — cookie banners, GDPR.

const CONSENT_TEXT_PATTERNS: ReadonlyArray<string> = [
  'accept all cookies',
  'reject all cookies',
  'manage cookies',
  'manage your preferences',
  'we use cookies',
  'this site uses cookies',
  'gdpr',
  'cookie preferences',
  'cookie consent',
  'privacy preferences',
];

const CONSENT_URL_PATTERNS: ReadonlyArray<string> = [
  '/cookie',
  '/consent',
];

// ── Helpers ─────────────────────────────────────────────────────────────────

function lowercase(s: string): string {
  return (s ?? '').toLowerCase();
}

function matchesAny(haystack: string, patterns: ReadonlyArray<string>): string | null {
  for (const p of patterns) {
    if (haystack.includes(p)) return p;
  }
  return null;
}

function pickSubtype(
  haystack: string,
  hints:    ReadonlyArray<[string, string]>,
  fallback: string,
): string {
  for (const [marker, subtype] of hints) {
    if (haystack.includes(marker)) return subtype;
  }
  return fallback;
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

// ── Per-tier detectors ─────────────────────────────────────────────────────

/**
 * Markers from captchaCheck.ts that aren't CAPTCHA-specific —
 * they overlap semantically with the Verification tier (phone /
 * email / identity confirmation). When captchaCheck's only hit
 * is one of these, defer to the Verification tier; CAPTCHA needs
 * a more specific signal.
 */
const AMBIGUOUS_CAPTCHA_MARKERS: ReadonlySet<string> = new Set([
  'verify your identity',
]);

function detectCaptcha(text: string, url: string): BlockerSurface | null {
  const result = detectCaptchaMarkers(text);
  if (!result.detected) return null;

  // Demote: when the only matched marker is an ambiguous one (e.g.
  // "verify your identity" — used by both CAPTCHAs and identity-
  // verification flows), let the Verification tier handle it.
  // CAPTCHA needs at least one specific signal.
  if (
    result.markers.length === 1 &&
    AMBIGUOUS_CAPTCHA_MARKERS.has(result.markers[0])
  ) {
    return null;
  }

  const lowerText = lowercase(text);
  const subtype = pickSubtype(
    lowerText,
    CAPTCHA_SUBTYPE_MARKERS,
    'unknown',
  );

  const evidence: string[] = result.markers.map((m) => `captcha-marker:${m}`);
  // Multi-marker boosts confidence.
  const confidence =
    result.markers.length >= 3 ? 0.95 :
    result.markers.length === 2 ? 0.85 : 0.7;

  return {
    kind:       'captcha',
    subtype,
    url,
    confidence,
    evidence,
    message:    `${subtype === 'unknown' ? 'CAPTCHA' : subtype} challenge at ${hostnameOf(url)}. Solve it in the browser tab, then tell me when ready.`,
  };
}

function detect2FA(text: string, url: string): BlockerSurface | null {
  const lowerText = lowercase(text);
  const lowerUrl  = lowercase(url);

  const textHit = matchesAny(lowerText, TWOFA_TEXT_PATTERNS);
  const urlHit  = matchesAny(lowerUrl,  TWOFA_URL_PATTERNS);
  const domHit  = matchesAny(lowerText, TWOFA_DOM_HINTS);

  // Need at least ONE strong signal — text or URL match. DOM hint
  // alone isn't enough (the text may be misleading on a docs page).
  if (!textHit && !urlHit) return null;

  const evidence: string[] = [];
  if (textHit) evidence.push(`text:${textHit}`);
  if (urlHit)  evidence.push(`url:${urlHit}`);
  if (domHit)  evidence.push(`dom:${domHit}`);

  const subtype = pickSubtype(lowerText, TWOFA_SUBTYPE_HINTS, 'unknown');

  // Confidence: text+url+dom = 0.9, text+url = 0.8, text+dom = 0.75,
  // text-only or url-only = 0.6.
  let confidence = 0.6;
  const signals = (textHit ? 1 : 0) + (urlHit ? 1 : 0) + (domHit ? 1 : 0);
  if (signals === 2) confidence = textHit && urlHit ? 0.8 : 0.75;
  if (signals === 3) confidence = 0.9;

  return {
    kind:       '2fa',
    subtype,
    url,
    confidence,
    evidence,
    message:    `Two-factor code required at ${hostnameOf(url)}. Enter your ${subtype === 'totp' ? 'authenticator app code' : subtype === 'sms' ? 'SMS code' : 'verification code'} in the browser tab and tell me when complete.`,
  };
}

function detectLogin(text: string, url: string): BlockerSurface | null {
  const lowerText = lowercase(text);
  const lowerUrl  = lowercase(url);

  const textHit = matchesAny(lowerText, LOGIN_TEXT_PATTERNS);
  const urlHit  = matchesAny(lowerUrl,  LOGIN_URL_PATTERNS);
  const domHit  = matchesAny(lowerText, LOGIN_DOM_HINTS);
  const strongTextHit = matchesAny(lowerText, LOGIN_TEXT_PATTERNS.slice(5));

  if (!textHit && !urlHit) return null;
  const weakTextOnly = textHit !== null
    && ['sign in', 'sign-in', 'log in', 'log-in', 'login'].includes(textHit)
    && !urlHit
    && !domHit;
  if (weakTextOnly && !strongTextHit) {
    const compactWall = /^(?:please\s+)?(?:sign[ -]?in|log[ -]?in|login)(?:\s+to\s+continue)?[.!]?$/.test(lowerText.trim());
    const explicitRequirement = /(?:sign[ -]?in|log[ -]?in|login)[\s\S]{0,120}(?:to continue|with (?:your )?password|password|required)/.test(lowerText);
    if (!compactWall && !explicitRequirement) return null;
  }

  const evidence: string[] = [];
  if (textHit) evidence.push(`text:${textHit}`);
  if (urlHit)  evidence.push(`url:${urlHit}`);
  if (domHit)  evidence.push(`dom:${domHit}`);

  // Subtype: prefer text-marker match, then check URL for oauth/sso
  // indicators (a `/oauth` or `/sso` URL is a strong OAuth signal
  // even when the visible text is generic like "Authorize access").
  let subtype = pickSubtype(lowerText, LOGIN_SUBTYPE_HINTS, '');
  if (!subtype) {
    if (lowerUrl.includes('oauth') || lowerUrl.includes('sso')) {
      subtype = 'oauth';
    } else {
      subtype = 'password';
    }
  }

  let confidence = 0.6;
  const signals = (textHit ? 1 : 0) + (urlHit ? 1 : 0) + (domHit ? 1 : 0);
  if (signals === 2) confidence = 0.8;
  if (signals === 3) confidence = 0.9;

  return {
    kind:       'login',
    subtype,
    url,
    confidence,
    evidence,
    message:    `Sign-in required at ${hostnameOf(url)}. Authenticate in the browser tab and let me know when done.`,
  };
}

function detectVerify(text: string, url: string): BlockerSurface | null {
  const lowerText = lowercase(text);
  const lowerUrl  = lowercase(url);

  const textHit = matchesAny(lowerText, VERIFY_TEXT_PATTERNS);
  const urlHit  = matchesAny(lowerUrl,  VERIFY_URL_PATTERNS);

  if (!textHit && !urlHit) return null;

  const evidence: string[] = [];
  if (textHit) evidence.push(`text:${textHit}`);
  if (urlHit)  evidence.push(`url:${urlHit}`);

  const subtype = pickSubtype(lowerText, VERIFY_SUBTYPE_HINTS, 'unknown');

  // Url-only is the weaker case here (lots of /verify URLs do other
  // things), so URL-only matches need text-marker reinforcement to
  // reach 0.6+ confidence.
  let confidence = 0.5;
  if (textHit && urlHit) confidence = 0.85;
  else if (textHit)      confidence = 0.7;

  return {
    kind:       'verification',
    subtype,
    url,
    confidence,
    evidence,
    message:    `Identity verification required at ${hostnameOf(url)}. Complete the verification in the browser tab and tell me when done.`,
  };
}

function detectConsent(text: string, url: string): BlockerSurface | null {
  const lowerText = lowercase(text);
  const lowerUrl  = lowercase(url);

  const textHit = matchesAny(lowerText, CONSENT_TEXT_PATTERNS);
  const urlHit  = matchesAny(lowerUrl,  CONSENT_URL_PATTERNS);

  if (!textHit && !urlHit) return null;

  const evidence: string[] = [];
  if (textHit) evidence.push(`text:${textHit}`);
  if (urlHit)  evidence.push(`url:${urlHit}`);

  let confidence = 0.5;
  if (textHit && urlHit) confidence = 0.8;
  else if (textHit)      confidence = 0.65;

  return {
    kind:       'consent',
    subtype:    'cookies',
    url,
    confidence,
    evidence,
    message:    `Consent banner at ${hostnameOf(url)}. Dismiss the cookie/privacy banner in the browser tab — I can retry afterward.`,
  };
}

// ── Orchestrator ───────────────────────────────────────────────────────────

/**
 * Detect the highest-priority manual blocker on a page. Priority
 * order: captcha > 2fa > login > verification > consent. Returns
 * null when no tier matches.
 *
 * Pure function — same inputs always produce the same output.
 * Public for unit tests + the HOC's per-action detection call.
 */
export function detectBlocker(
  input: BlockerDetectionInput,
): BlockerSurface | null {
  const text = input.text ?? '';
  const url  = input.url  ?? '';

  // Priority pipeline — first non-null wins.
  return (
    detectCaptcha(text, url) ??
    detect2FA(text, url) ??
    detectLogin(text, url) ??
    detectVerify(text, url) ??
    detectConsent(text, url)
  );
}
