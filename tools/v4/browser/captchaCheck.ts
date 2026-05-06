/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/browser/captchaCheck.ts — Phase 16f Task 3
 *
 * Conservative CAPTCHA / bot-challenge detection for browser_navigate
 * post-load checks. Pure function — no Playwright dependency, easy to
 * unit test against fixture text.
 *
 * Per docs/sprint/hermes-tool-honesty-audit.md, Aiden's CAPTCHA-claimed-
 * success bug was browser_navigate returning {success: true} even when
 * the resulting page was a Cloudflare wall. This module gives the tool
 * wrapper the heuristic to detect that case and return success=false
 * with a clear next-step error.
 *
 * Heuristic philosophy: false positives (incorrectly flagging a page
 * as CAPTCHA) are recoverable — the model retries via open_url. False
 * negatives (missing a CAPTCHA wall) cause the original bug. Bias
 * toward sensitivity. Patterns are case-insensitive substring matches
 * against a normalised lowercased view of the first ~3000 characters.
 */

/**
 * Common bot-challenge / CAPTCHA markers across major providers
 * (Cloudflare, Akamai, PerimeterX, hCaptcha, reCAPTCHA, AWS WAF).
 * Pulled from real challenge pages encountered in the 16d/16e/16f
 * smoke runs and the Hermes honesty audit's reference list.
 */
export const CAPTCHA_MARKERS: ReadonlyArray<string> = [
  // Generic
  'captcha',
  'verify you are human',
  "i'm not a robot",
  "i am not a robot",
  'are you a human',
  'are you a robot',
  'robot check',
  'bot challenge',
  'bot detection',
  'verify your identity',

  // Cloudflare
  'cloudflare',
  'just a moment',
  'checking your browser',
  'checking if the site connection is secure',
  'please wait while we verify',
  'enable javascript and cookies to continue',

  // Akamai / generic WAF
  'access denied',
  'request unsuccessful',
  'reference number',
  'this website is using a security service',

  // hCaptcha / reCAPTCHA explicit
  'hcaptcha.com',
  'recaptcha',
  'g-recaptcha',

  // PerimeterX
  'press and hold',
  'human verification',
];

/**
 * Result of a CAPTCHA / bot-challenge check on page text.
 *
 * `detected: true` ⇒ caller should treat the navigation as failed
 * (success=false in the tool wrapper). `markers` lists which
 * substrings matched, useful for logs / error messages.
 */
export interface CaptchaCheckResult {
  detected: boolean;
  markers: string[];
}

/**
 * Scan a page-text snippet for CAPTCHA markers. Lowercased substring
 * match against `CAPTCHA_MARKERS`. The threshold is intentionally low —
 * a single hit is enough — because false negatives caused the original
 * bug. Pages that legitimately discuss CAPTCHAs (docs, blog posts) may
 * trip this; that's the cost.
 */
export function detectCaptchaMarkers(text: string): CaptchaCheckResult {
  const lower = (text ?? '').toLowerCase();
  const hits: string[] = [];
  for (const marker of CAPTCHA_MARKERS) {
    if (lower.includes(marker)) hits.push(marker);
  }
  return {
    detected: hits.length > 0,
    markers: hits,
  };
}
