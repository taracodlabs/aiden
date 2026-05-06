/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/web/webFetch.ts — `fetch_url` wrapper.
 *
 * Fetches a URL and returns the response body with HTML structural
 * tags (script/style/nav/header/footer) stripped. Behaviour ported
 * inline from `core/toolRegistry.ts:1366` — small enough that the
 * import surface isn't worth the coupling.
 *
 * Status: PHASE 7. Read-only.
 */

import type { ToolHandler } from '../../../core/v4/toolRegistry';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0';
const TIMEOUT_MS = 15_000;
const MAX_BODY_CHARS = 3000;

function stripHtml(text: string): string {
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s{3,}/g, ' ')
    .trim();
}

export const webFetchTool: ToolHandler = {
  schema: {
    name: 'fetch_url',
    description:
      'Fetch the contents of a URL and return the response body as text. HTML structural tags (script/style/nav/header/footer) are stripped before the first 3000 characters are returned.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The absolute URL to fetch.',
        },
      },
      required: ['url'],
    },
  },
  category: 'network',
  mutates: false,
  toolset: 'web',
  async execute(args) {
    const url = String(args.url ?? '').trim();
    if (!url) return { success: false, error: 'No URL provided' };
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const text = await res.text();
      const clean = stripHtml(text);
      return {
        success: true,
        status: res.status,
        statusText: res.statusText || '',
        body: clean.slice(0, MAX_BODY_CHARS),
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { success: false, error: message };
    }
  },
};
