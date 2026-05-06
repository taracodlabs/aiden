/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/system/naturalEvents.ts — `get_natural_events` wrapper.
 *
 * Fetches the NASA EONET feed of currently-active natural events
 * (earthquakes, wildfires, storms, floods, etc.). Public API, no key
 * required. Limit and status are exposed as args; defaults match v3.
 *
 * Status: PHASE 7. Read-only.
 */

import type { ToolHandler } from '../../../core/v4/toolRegistry';

const DEFAULT_LIMIT = 10;
const TIMEOUT_MS = 8_000;

export const naturalEventsTool: ToolHandler = {
  schema: {
    name: 'get_natural_events',
    description:
      'Fetch active natural events from the NASA EONET API. Returns current earthquakes, wildfires, storms, floods, and other events worldwide.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: `How many events to return. Default ${DEFAULT_LIMIT}.`,
        },
        status: {
          type: 'string',
          enum: ['open', 'closed', 'all'],
          description: "Event status filter. Default 'open'.",
        },
      },
    },
  },
  category: 'network',
  mutates: false,
  toolset: 'system',
  async execute(args) {
    const limit =
      typeof args.limit === 'number' && args.limit > 0
        ? Math.floor(args.limit)
        : DEFAULT_LIMIT;
    const status =
      args.status === 'closed' || args.status === 'all' ? args.status : 'open';
    try {
      const url = `https://eonet.gsfc.nasa.gov/api/v3/events?limit=${limit}&status=${status}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`EONET API returned ${res.status}`);
      const data = (await res.json()) as { events?: unknown[] };
      const events = (data.events ?? []).map((e: any) => ({
        id: e.id,
        title: e.title,
        category: e.categories?.[0]?.title ?? 'Unknown',
        date: e.geometry?.[0]?.date ?? null,
        link: e.sources?.[0]?.url ?? null,
      }));
      return { success: true, count: events.length, events };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { success: false, error: `EONET fetch failed: ${message}` };
    }
  },
};
