/**
 * v4.5 Phase 4a — bodyExtractor tests.
 */
import { describe, it, expect } from 'vitest';
import { extractEmailBody } from '../../../../../core/v4/daemon/triggers/email/bodyExtractor';

function rfc822(opts: { from?: string; subject?: string; body?: string; contentType?: string }): Buffer {
  const ct = opts.contentType ?? 'text/plain; charset=utf-8';
  return Buffer.from(
    [
      `From: ${opts.from ?? 'alice@example.com'}`,
      `To: bob@example.com`,
      `Subject: ${opts.subject ?? 'hi'}`,
      `MIME-Version: 1.0`,
      `Content-Type: ${ct}`,
      '',
      opts.body ?? 'Hello world.',
    ].join('\r\n'),
    'utf-8',
  );
}

describe('extractEmailBody — text priority', () => {
  it('prefers plain text', async () => {
    const r = await extractEmailBody({
      raw: rfc822({ body: 'plain body' }),
      maxBodyBytes: 1024,
      attachmentPolicy: 'skip',
    });
    expect(r.textKind).toBe('plain');
    expect(r.text).toContain('plain body');
  });

  it('html-only message: clean text extracted, no tags or script leak', async () => {
    // mailparser auto-converts text/html → plain text AND populates
    // parsed.text. The extractor preferring `parsed.text` over
    // `parsed.html` is correct behavior. What matters at the spec
    // level is that the FINAL text contains the user-visible content
    // without HTML tags or script bodies.
    const r = await extractEmailBody({
      raw: rfc822({
        contentType: 'text/html; charset=utf-8',
        body: '<p>Hello <b>world</b></p><script>alert("bad")</script>',
      }),
      maxBodyBytes: 1024,
      attachmentPolicy: 'skip',
    });
    expect(['plain', 'html-stripped', 'text-as-html']).toContain(r.textKind);
    expect(r.text).not.toContain('<p>');
    expect(r.text).not.toContain('<script>');
    expect(r.text).not.toContain('alert(');
    expect(r.text).toContain('Hello');
    expect(r.text).toContain('world');
  });
});

describe('extractEmailBody — quoted-reply stripping', () => {
  it('strips Gmail-style "On X wrote:" block', async () => {
    const body = [
      'My reply here.',
      '',
      'On Tue, Jan 1 2024, Alice <alice@example.com> wrote:',
      '> previous message line 1',
      '> previous message line 2',
    ].join('\n');
    const r = await extractEmailBody({
      raw: rfc822({ body }), maxBodyBytes: 1024, attachmentPolicy: 'skip',
    });
    expect(r.quotedReplyStripped).toBe(true);
    expect(r.text).toContain('My reply here');
    expect(r.text).not.toContain('previous message');
  });

  it('leaves text without quoted-reply alone', async () => {
    const r = await extractEmailBody({
      raw: rfc822({ body: 'Just a message, no quoted reply.' }),
      maxBodyBytes: 1024, attachmentPolicy: 'skip',
    });
    expect(r.quotedReplyStripped).toBe(false);
  });
});

describe('extractEmailBody — truncation', () => {
  it('truncates to maxBodyBytes', async () => {
    const big = 'x'.repeat(5000);
    const r = await extractEmailBody({
      raw: rfc822({ body: big }), maxBodyBytes: 1000, attachmentPolicy: 'skip',
    });
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.text, 'utf-8')).toBeLessThanOrEqual(1000);
  });

  it('does NOT truncate small bodies', async () => {
    const r = await extractEmailBody({
      raw: rfc822({ body: 'small' }), maxBodyBytes: 1000, attachmentPolicy: 'skip',
    });
    expect(r.truncated).toBe(false);
  });
});

describe('extractEmailBody — attachment policy', () => {
  it('skip policy records metadata only', async () => {
    // mailparser handles MIME multipart natively. Construct a minimal
    // multipart message inline.
    const boundary = 'aiden-test-bound';
    const raw = Buffer.from([
      'From: alice@example.com',
      'To: bob@example.com',
      'Subject: with attachment',
      'MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      'main body',
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      'Content-Disposition: attachment; filename="notes.txt"',
      '',
      'attachment content',
      `--${boundary}--`,
      '',
    ].join('\r\n'), 'utf-8');
    const r = await extractEmailBody({
      raw, maxBodyBytes: 4096, attachmentPolicy: 'skip',
    });
    expect(r.text).toContain('main body');
    expect(r.attachments.length).toBeGreaterThanOrEqual(1);
    expect(r.attachments[0].filename).toBe('notes.txt');
    // 'skip' policy → attachment content NOT inlined.
    expect(r.text).not.toContain('attachment content');
  });
});
