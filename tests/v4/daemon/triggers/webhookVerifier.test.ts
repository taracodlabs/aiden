/**
 * v4.5 Phase 3 — webhookVerifier tests.
 */
import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import {
  verifyWebhookSignature,
  deriveEventName,
} from '../../../../core/v4/daemon/triggers/webhookVerifier';
import { INSECURE_NO_AUTH } from '../../../../core/v4/daemon/triggers/webhookSpec';

function hmacHex(secret: string, body: Buffer): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

const SECRET = 'hush-puppy';
const BODY = Buffer.from(JSON.stringify({ action: 'opened' }));

describe('verifyWebhookSignature — github', () => {
  it('accepts a valid X-Hub-Signature-256', () => {
    const sig = `sha256=${hmacHex(SECRET, BODY)}`;
    expect(verifyWebhookSignature({
      format: 'github', secret: SECRET, body: BODY,
      headers: { 'x-hub-signature-256': sig },
    })).toBe(true);
  });

  it('rejects a wrong signature', () => {
    const sig = `sha256=${'0'.repeat(64)}`;
    expect(verifyWebhookSignature({
      format: 'github', secret: SECRET, body: BODY,
      headers: { 'x-hub-signature-256': sig },
    })).toBe(false);
  });

  it('rejects missing header', () => {
    expect(verifyWebhookSignature({
      format: 'github', secret: SECRET, body: BODY, headers: {},
    })).toBe(false);
  });

  it('rejects malformed header (no sha256= prefix)', () => {
    expect(verifyWebhookSignature({
      format: 'github', secret: SECRET, body: BODY,
      headers: { 'x-hub-signature-256': hmacHex(SECRET, BODY) },
    })).toBe(false);
  });
});

describe('verifyWebhookSignature — gitlab', () => {
  it('accepts matching X-Gitlab-Token', () => {
    expect(verifyWebhookSignature({
      format: 'gitlab', secret: SECRET, body: BODY,
      headers: { 'x-gitlab-token': SECRET },
    })).toBe(true);
  });

  it('rejects non-matching token (same length)', () => {
    expect(verifyWebhookSignature({
      format: 'gitlab', secret: SECRET, body: BODY,
      headers: { 'x-gitlab-token': 'xush-puppz' },
    })).toBe(false);
  });

  it('rejects different-length token', () => {
    expect(verifyWebhookSignature({
      format: 'gitlab', secret: SECRET, body: BODY,
      headers: { 'x-gitlab-token': 'short' },
    })).toBe(false);
  });

  it('rejects missing header', () => {
    expect(verifyWebhookSignature({
      format: 'gitlab', secret: SECRET, body: BODY, headers: {},
    })).toBe(false);
  });
});

describe('verifyWebhookSignature — generic', () => {
  it('accepts valid HMAC-SHA256 hex', () => {
    const sig = hmacHex(SECRET, BODY);
    expect(verifyWebhookSignature({
      format: 'generic', secret: SECRET, body: BODY,
      headers: { 'x-webhook-signature': sig },
    })).toBe(true);
  });

  it('rejects wrong signature', () => {
    expect(verifyWebhookSignature({
      format: 'generic', secret: SECRET, body: BODY,
      headers: { 'x-webhook-signature': '0'.repeat(64) },
    })).toBe(false);
  });
});

describe('verifyWebhookSignature — INSECURE_NO_AUTH', () => {
  it('bypasses verification entirely', () => {
    expect(verifyWebhookSignature({
      format: 'generic', secret: INSECURE_NO_AUTH, body: BODY, headers: {},
    })).toBe(true);
  });
});

describe('deriveEventName', () => {
  it('reads X-GitHub-Event for github format', () => {
    expect(deriveEventName('github', { 'x-github-event': 'pull_request' })).toBe('pull_request');
  });

  it('reads X-Gitlab-Event for gitlab format', () => {
    expect(deriveEventName('gitlab', { 'x-gitlab-event': 'Push Hook' })).toBe('Push Hook');
  });

  it('returns empty when header missing', () => {
    expect(deriveEventName('github', {})).toBe('');
  });
});
