/**
 * tests/v4/tools/captchaCheck.test.ts — Phase 16f Task 3
 *
 * Pure-function tests for CAPTCHA detection. Locks the heuristic so
 * future regressions ("Aiden claimed search completed but the page
 * was a Cloudflare wall") don't recur.
 */
import { describe, it, expect } from 'vitest';
import {
  detectCaptchaMarkers,
  CAPTCHA_MARKERS,
} from '../../../tools/v4/browser/captchaCheck';

describe('detectCaptchaMarkers — positive cases', () => {
  it('detects a Cloudflare "Just a moment" challenge', () => {
    const text =
      'Just a moment...  Checking your browser before accessing example.com.';
    const r = detectCaptchaMarkers(text);
    expect(r.detected).toBe(true);
    expect(r.markers).toContain('just a moment');
    expect(r.markers).toContain('checking your browser');
  });

  it('detects a generic CAPTCHA prompt', () => {
    const text = 'Please verify you are human by completing the captcha below.';
    const r = detectCaptchaMarkers(text);
    expect(r.detected).toBe(true);
    expect(r.markers).toContain('captcha');
    expect(r.markers).toContain('verify you are human');
  });

  it('detects an Akamai "access denied" wall', () => {
    const text =
      'Access Denied. Reference number: 18.abc123. This website is using a security service.';
    const r = detectCaptchaMarkers(text);
    expect(r.detected).toBe(true);
    expect(r.markers).toContain('access denied');
    expect(r.markers).toContain('this website is using a security service');
  });

  it('detects hCaptcha / reCAPTCHA widgets', () => {
    expect(detectCaptchaMarkers('<div class="g-recaptcha">').detected).toBe(true);
    expect(detectCaptchaMarkers('Powered by hcaptcha.com').detected).toBe(true);
  });

  it('detects PerimeterX "press and hold"', () => {
    const text = 'Press and Hold the button to confirm you are human';
    expect(detectCaptchaMarkers(text).detected).toBe(true);
  });

  it('is case-insensitive', () => {
    const text = 'JUST A MOMENT... CHECKING YOUR BROWSER';
    expect(detectCaptchaMarkers(text).detected).toBe(true);
  });
});

describe('detectCaptchaMarkers — negative cases', () => {
  it('does not block an ordinary page that only mentions Cloudflare', () => {
    expect(detectCaptchaMarkers(
      'This repository includes a Cloudflare deployment adapter and documentation.',
    )).toEqual({ detected: false, markers: [] });
  });

  it('does NOT flag normal product copy', () => {
    const text =
      'Welcome to Example.com! Browse our catalog of widgets and gadgets. ' +
      'Free shipping on orders over $50.';
    expect(detectCaptchaMarkers(text).detected).toBe(false);
  });

  it('does NOT flag an empty body', () => {
    expect(detectCaptchaMarkers('').detected).toBe(false);
  });

  it('handles null/undefined gracefully', () => {
    expect(detectCaptchaMarkers(undefined as any).detected).toBe(false);
    expect(detectCaptchaMarkers(null as any).detected).toBe(false);
  });
});

describe('CAPTCHA_MARKERS — invariants', () => {
  it('has at least 20 markers covering major providers', () => {
    expect(CAPTCHA_MARKERS.length).toBeGreaterThanOrEqual(20);
  });

  it('all markers are lowercase (matches the lowercased-input scan)', () => {
    for (const m of CAPTCHA_MARKERS) {
      expect(m).toBe(m.toLowerCase());
    }
  });
});
