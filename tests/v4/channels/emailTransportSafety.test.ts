/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */
import { describe, expect, it, vi } from 'vitest';
import { EmailAdapter } from '../../../core/channels/email';

const expectedKeys = ['from', 'headers', 'subject', 'text', 'to'];

function adapterWithTransport() {
  const sendMail = vi.fn(async () => ({ messageId: 'test-message' }));
  const adapter = new EmailAdapter() as any;
  adapter.smtpUser = 'sender@example.test';
  adapter.transporter = { sendMail };
  return { adapter, sendMail };
}

describe('email transport safety', () => {
  it('sends direct replies as structured text-only messages', async () => {
    const { adapter, sendMail } = adapterWithTransport();

    await adapter.send('recipient@example.test', 'plain text body');

    expect(sendMail).toHaveBeenCalledTimes(1);
    const message = sendMail.mock.calls[0][0];
    expect(message).toEqual({
      from: 'sender@example.test',
      to: 'recipient@example.test',
      subject: 'Message from Aiden',
      text: 'plain text body',
      headers: { 'X-Aiden-Reply': '1' },
    });
    expect(Object.keys(message).sort()).toEqual(expectedKeys);
  });

  it('sends threaded replies without raw, attachment, path, or URL inputs', async () => {
    const { adapter, sendMail } = adapterWithTransport();

    await adapter.replyEmail('recipient@example.test', 'Original subject', 'thread body');

    expect(sendMail).toHaveBeenCalledTimes(1);
    const message = sendMail.mock.calls[0][0];
    expect(message).toEqual({
      from: 'sender@example.test',
      to: 'recipient@example.test',
      subject: 'Re: Original subject',
      text: 'thread body',
      headers: { 'X-Aiden-Reply': '1' },
    });
    expect(Object.keys(message).sort()).toEqual(expectedKeys);
    expect(message).not.toHaveProperty('raw');
    expect(message).not.toHaveProperty('attachments');
    expect(message).not.toHaveProperty('path');
    expect(message).not.toHaveProperty('href');
  });
});
