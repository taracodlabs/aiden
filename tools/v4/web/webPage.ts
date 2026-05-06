/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/web/webPage.ts — `fetch_page` wrapper.
 *
 * Like `fetch_url` but more aggressive: strips ALL HTML tags
 * (not just structural ones) and collapses whitespace. Returns
 * a clean readable-text view of the page. Ported from
 * `core/toolRegistry.ts:1390`.
 *
 * Status: PHASE 7. Read-only.
 */

import type { ToolHandler } from '../../../core/v4/toolRegistry';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const TIMEOUT_MS = 10_000;
const MAX_BODY_CHARS = 3000;

export const webPageTool: ToolHandler = {
  schema: {
    name: 'fetch_page',
    description:
      'Fetch a web page and return its readable text content. Strips all HTML tags and collapses whitespace; ideal for extracting article bodies. Returns the first 3000 characters.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The absolute URL of the page to read.',
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
      const clean = text
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      return { success: true, content: clean.slice(0, MAX_BODY_CHARS) };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { success: false, error: message };
    }
  },
};
