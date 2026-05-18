// tools/eonetTool.ts —  NASA EONET natural disaster events (v3 API)
// Free, no auth required. Fetches open events filtered to high-impact categories.

import { fetch } from 'undici'

const EONET_BASE = 'https://eonet.gsfc.nasa.gov/api/v3'

const HIGH_IMPACT_CATEGORIES = [
  'wildfires',
  'severeStorms',
  'volcanoes',
  'floods',
  'earthquakes',
]

// ── Types ──────────────────────────────────────────────────────

export interface EonetEvent {
  id:         string
  title:      string
  categories: { id: string; title: string }[]
  geometry:   { date: string; type: string; coordinates: number[] | number[][][] }[]
  closed:     string | null
}

// ── Fetch active events ────────────────────────────────────────

export async function getActiveNaturalEvents(
  days  = 1,
  limit = 10,
): Promise<EonetEvent[]> {
  try {
    const url = `${EONET_BASE}/events?status=open&days=${days}&limit=${limit}`
    const res  = await fetch(url, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) return []

    const data = await res.json() as { events: EonetEvent[] }
    if (!Array.isArray(data?.events)) return []

    // filter to high-impact categories only
    return data.events.filter(ev =>
      ev.categories?.some(c => HIGH_IMPACT_CATEGORIES.includes(c.id)),
    )
  } catch {
    return []
  }
}

// ── Format events as a briefing section string ─────────────────

export function formatEonetEvents(events: EonetEvent[]): string {
  if (events.length === 0) return ''

  const lines = events.slice(0, 8).map(ev => {
    const cat   = ev.categories[0]
    const emoji = getCategoryEmoji(cat?.id ?? '')
    const geo   = ev.geometry?.[ev.geometry.length - 1]
    const date  = geo?.date ? new Date(geo.date).toLocaleDateString('en-IN', { month: 'short', day: 'numeric' }) : ''
    return `  ${emoji} ${ev.title}${date ? ` (${date})` : ''}`
  })

  return `**🌍 NASA Live Events (${events.length} active):**\n${lines.join('\n')}`
}

// ── One-liner summary for desktop notification ─────────────────

export function getEonetSummary(events: EonetEvent[]): string {
  if (events.length === 0) return ''

  const counts: Record<string, number> = {}
  for (const ev of events) {
    const id = ev.categories[0]?.id ?? 'other'
    counts[id] = (counts[id] ?? 0) + 1
  }

  const parts = Object.entries(counts).map(([id, n]) => {
    const emoji = getCategoryEmoji(id)
    return `${n} ${emoji}${id}`
  })

  return `NASA: ${parts.join(', ')}`
}

// ── Emoji map ──────────────────────────────────────────────────

function getCategoryEmoji(categoryId: string): string {
  switch (categoryId) {
    case 'wildfires':     return '🔥'
    case 'severeStorms':  return '🌪️'
    case 'volcanoes':     return '🌋'
    case 'floods':        return '🌊'
    case 'earthquakes':   return '🫨'
    default:              return '⚠️'
  }
}
