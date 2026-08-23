'use client'
// dashboard-next/components/ChatHeader.tsx
// Sprint 30: Cost badge — shows today's user spend.
// Click to expand per-provider breakdown.
// Subscribes to SSE 'cost_update' events from api/server.ts.

import { useEffect, useState } from 'react'

interface DailyCostSummary {
  date:       string
  totalUSD:   number
  systemUSD:  number
  userUSD:    number
  byProvider: Record<string, number>
}

export default function ChatHeader() {
  const [cost,     setCost]     = useState<DailyCostSummary | null>(null)
  const [expanded, setExpanded] = useState(false)

  // ── Poll /api/cost on mount, then subscribe to SSE cost_update ──
  useEffect(() => {
    // Initial fetch
    fetch('http://localhost:4200/api/cost')
      .then(r => r.ok ? r.json() : null)
      .then((data: DailyCostSummary | null) => { if (data) setCost(data) })
      .catch(() => {})

    // SSE subscription
    const es = new EventSource('http://localhost:4200/api/stream')
    es.addEventListener('cost_update', (e: MessageEvent) => {
      try { setCost(JSON.parse(e.data) as DailyCostSummary) } catch {}
    })
    es.onerror = () => { es.close() }

    return () => { es.close() }
  }, [])

  const fmt = (n: number) => `$${n.toFixed(2)}`

  if (!cost) return null

  return (
    <div className="topbar-cost" style={{ position: 'relative', display: 'inline-block' }}>
      {/* Cost badge */}
      <button
        onClick={() => setExpanded(v => !v)}
        title="Click to see provider breakdown"
        style={{
          background:   'transparent',
          border:       '1px solid #333',
          borderRadius: '6px',
          color:        cost.userUSD >= 4 ? '#f87171' : cost.userUSD >= 2 ? '#fb923c' : '#6b7280',
          cursor:       'pointer',
          fontSize:     '12px',
          fontFamily:   'monospace',
          padding:      '2px 8px',
          whiteSpace:   'nowrap',
        }}
      >
        {fmt(cost.userUSD)} today
      </button>

      {/* Expanded breakdown */}
      {expanded && (
        <div
          style={{
            position:    'absolute',
            top:         '110%',
            right:       0,
            background:  '#1a1a1a',
            border:      '1px solid #333',
            borderRadius:'8px',
            padding:     '10px 14px',
            minWidth:    '200px',
            zIndex:      100,
            fontSize:    '12px',
            fontFamily:  'monospace',
            color:       '#e8e8e8',
          }}
        >
          <div style={{ marginBottom: '8px', color: '#9ca3af', fontSize: '11px' }}>
            {cost.date} · user spend
          </div>

          {Object.entries(cost.byProvider).length === 0 ? (
            <div style={{ color: '#4b5563' }}>No usage yet</div>
          ) : (
            Object.entries(cost.byProvider)
              .sort((a, b) => b[1] - a[1])
              .map(([provider, usd]) => (
                <div key={provider} style={{ display: 'flex', justifyContent: 'space-between', gap: '16px', marginBottom: '4px' }}>
                  <span style={{ color: '#9ca3af' }}>{provider}</span>
                  <span>{fmt(usd)}</span>
                </div>
              ))
          )}

          <div style={{ borderTop: '1px solid #333', marginTop: '8px', paddingTop: '8px', display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: '#6b7280' }}>system</span>
            <span style={{ color: '#4b5563' }}>{fmt(cost.systemUSD)}</span>
          </div>
        </div>
      )}
    </div>
  )
}
