// ============================================================
// DevOS — Autonomous AI Execution System
// Copyright (c) 2026 Shiva Deore. All rights reserved.
// ============================================================

// core/tools/gmailTool.ts — Gmail integration foundation.
//
// App Password + IMAP stub. The IMAP call is deliberately
//     guarded behind a try/catch so missing packages don't crash
//     the server. Full IMAP read is stubbed — it engages only if the
//     imap-simple package is present in dependencies.
//
// NOTE: imap-simple brings transitive vulns
// (semver/tough-cookie/qs/form-data). Acceptable
// because this tool is optional and only runs when
// a skill explicitly invokes Gmail operations.

// ── Types ──────────────────────────────────────────────────────

export interface GmailMessage {
  from:    string
  subject: string
  date:    string
  snippet: string
}

export interface GmailConfig {
  email:       string
  appPassword: string
}

// ── Gmail reader (IMAP App Password) ─────────────────────────
// Returns messages if imap-simple is installed, otherwise returns
// an empty array and logs a hint.

export async function readGmail(
  config: GmailConfig,
  count:  number = 10,
  folder: string = 'INBOX',
): Promise<GmailMessage[]> {
  try {
    // Lazy-load imap-simple so its absence doesn't crash startup
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const imapSimple = require('imap-simple') as typeof import('imap-simple')

    const connection = await imapSimple.connect({
      imap: {
        user:        config.email,
        password:    config.appPassword,
        host:        'imap.gmail.com',
        port:        993,
        tls:         true,
        authTimeout: 10000,
      },
    })

    await connection.openBox(folder)

    const searchCriteria = ['UNSEEN']
    const fetchOptions   = {
      bodies:   ['HEADER.FIELDS (FROM SUBJECT DATE)'],
      markSeen: false,
    }

    const messages = await connection.search(searchCriteria, fetchOptions)
    connection.end()

    const results: GmailMessage[] = messages.slice(0, count).map((msg: any) => {
      const header = msg.parts.find((p: any) => p.which.startsWith('HEADER'))
      const h      = header?.body || {}
      return {
        from:    Array.isArray(h.from)    ? h.from[0]    : (h.from    || ''),
        subject: Array.isArray(h.subject) ? h.subject[0] : (h.subject || '(no subject)'),
        date:    Array.isArray(h.date)    ? h.date[0]    : (h.date    || ''),
        snippet: '',
      }
    })

    console.log(`[Gmail] Fetched ${results.length} messages from ${folder}`)
    return results
  } catch (err: any) {
    if (err?.code === 'MODULE_NOT_FOUND') {
      console.log('[Gmail] imap-simple not installed — run: npm install imap-simple')
    } else {
      console.error('[Gmail] IMAP connection failed:', String(err).slice(0, 120))
    }
    return []
  }
}

// ── Gmail sender (nodemailer + App Password) ──────────────────

export async function sendGmail(
  config:  GmailConfig,
  to:      string,
  subject: string,
  body:    string,
): Promise<{ success: boolean; error?: string }> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodemailer = require('nodemailer') as typeof import('nodemailer')

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: config.email,
        pass: config.appPassword,
      },
    })

    await transporter.sendMail({
      from:    config.email,
      to,
      subject,
      text:    body,
    })

    console.log(`[Gmail] Sent email to ${to}: ${subject}`)
    return { success: true }
  } catch (err: any) {
    if (err?.code === 'MODULE_NOT_FOUND') {
      console.log('[Gmail] nodemailer not installed — run: npm install nodemailer')
      return { success: false, error: 'nodemailer not installed' }
    }
    console.error('[Gmail] Send failed:', String(err).slice(0, 120))
    return { success: false, error: String(err).slice(0, 200) }
  }
}
