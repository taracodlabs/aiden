'use client'

import { useEffect, useMemo, useState } from 'react'
import * as aiden from '../lib/aidenClient'

type StepId = 'welcome' | 'computer' | 'ai' | 'browser' | 'coding' | 'apps' | 'ready'

const STEP_ORDER: Array<{ id: StepId; title: string; readinessId?: string; optional?: boolean }> = [
  { id: 'welcome', title: 'Welcome' },
  { id: 'computer', title: 'Check this computer', readinessId: 'workspace' },
  { id: 'ai', title: 'Connect AI', readinessId: 'chat-provider' },
  { id: 'browser', title: 'Browser access', readinessId: 'browser', optional: true },
  { id: 'coding', title: 'Coding setup', readinessId: 'coding-provider', optional: true },
  { id: 'apps', title: 'Apps', readinessId: 'apps', optional: true },
  { id: 'ready', title: 'Ready' },
]

const FIRST_SUCCESS = [
  'Work on a codebase',
  'Research using browser',
  'Work with Apps',
  'Create something',
] as const

export function OnboardingModal({
  onComplete,
  onOpenSettings,
  onOpenApps,
}: {
  onComplete: (choice: string) => void
  onOpenSettings: (tab: 'runtime' | 'model') => void
  onOpenApps: () => void
}) {
  const [index, setIndex] = useState(0)
  const [readiness, setReadiness] = useState<aiden.SystemReadinessProjection | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)

  const refresh = async () => {
    setChecking(true)
    setError(null)
    try { setReadiness(await aiden.loadSystemReadiness()) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'System readiness is unavailable.') }
    finally { setChecking(false) }
  }

  useEffect(() => { void refresh() }, [])

  const current = STEP_ORDER[index]
  const readinessItem = useMemo(
    () => current.readinessId ? readiness?.items.find((item) => item.id === current.readinessId) : undefined,
    [current.readinessId, readiness],
  )
  const complete = readinessItem?.healthy === true
  const next = () => setIndex((value) => Math.min(STEP_ORDER.length - 1, value + 1))
  const back = () => setIndex((value) => Math.max(0, value - 1))
  const mono: React.CSSProperties = { fontFamily: 'JetBrains Mono, monospace' }

  const action = () => {
    if (!readinessItem) return null
    if (readinessItem.availableActions.includes('manage_provider')) {
      return <button type="button" className="nav-btn" onClick={() => onOpenSettings('model')}>Open AI &amp; Models</button>
    }
    if (readinessItem.availableActions.includes('manage_apps')) {
      return <button type="button" className="nav-btn" onClick={onOpenApps}>Open Apps</button>
    }
    return <button type="button" className="nav-btn" onClick={() => onOpenSettings('runtime')}>Open Readiness</button>
  }

  return (
    <>
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(6px)', zIndex: 1000 }} />
      <div role="dialog" aria-modal="true" aria-label="Aiden first run" style={{
        position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
        width: 'min(90vw, 520px)', background: '#141414', border: '1px solid #2a2a2a',
        borderRadius: 16, padding: 36, zIndex: 1001,
      }}>
        <div style={{ display: 'flex', gap: 5, marginBottom: 28 }}>
          {STEP_ORDER.map((step, stepIndex) => <div key={step.id} style={{ height: 3, flex: 1, borderRadius: 2, background: stepIndex <= index ? '#f97316' : '#2a2a2a' }} />)}
        </div>

        {current.id === 'welcome' ? (
          <div>
            <h2 style={{ color: '#e8e8e8', margin: '0 0 8px' }}>Welcome to Aiden</h2>
            <p style={{ ...mono, color: '#999', fontSize: 12, lineHeight: 1.7, marginBottom: 24 }}>
              Aiden will check this computer, show what is ready, and explain the next action. Browser, coding, and Apps setup can be skipped.
            </p>
            <button type="button" className="nav-btn" onClick={next}>Check this computer →</button>
          </div>
        ) : current.id === 'ready' ? (
          <div>
            <h2 style={{ color: '#e8e8e8', margin: '0 0 8px' }}>{readiness?.overall === 'ready' ? 'Aiden is ready' : 'Setup can continue later'}</h2>
            <p style={{ ...mono, color: '#999', fontSize: 12, lineHeight: 1.7 }}>
              {readiness?.overall === 'ready' ? 'Choose what you want to accomplish first.' : 'Required issues remain visible in Settings → Readiness. Optional capabilities do not block Chat.'}
            </p>
            <div style={{ display: 'grid', gap: 8, marginTop: 20 }}>
              {FIRST_SUCCESS.map((choice) => <button key={choice} type="button" className="nav-btn" onClick={() => onComplete(choice)}>{choice}</button>)}
            </div>
          </div>
        ) : (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline' }}>
              <h2 style={{ color: '#e8e8e8', margin: '0 0 8px' }}>{current.title}</h2>
              {current.optional ? <span style={{ ...mono, color: '#777', fontSize: 10 }}>OPTIONAL</span> : null}
            </div>
            {checking ? <p style={{ ...mono, color: '#999', fontSize: 12 }}>Checking…</p> : error ? (
              <div>
                <p style={{ ...mono, color: '#ef4444', fontSize: 12 }}>What failed: readiness could not be loaded.</p>
                <p style={{ ...mono, color: '#999', fontSize: 12 }}>What Aiden knows: {error}</p>
                <button type="button" className="nav-btn" onClick={() => { void refresh() }}>Recheck</button>
              </div>
            ) : readinessItem ? (
              <div>
                <p style={{ ...mono, color: complete ? '#22c55e' : '#f59e0b', fontSize: 12 }}>{complete ? '✓ Ready' : '○ Needs attention'}</p>
                <p style={{ ...mono, color: '#aaa', fontSize: 12, lineHeight: 1.7 }}>{readinessItem.detail}</p>
                {!complete ? action() : null}
              </div>
            ) : <p style={{ ...mono, color: '#f59e0b', fontSize: 12 }}>Readiness information is unavailable. Open Settings → Readiness and recheck.</p>}
            <div style={{ display: 'flex', gap: 8, marginTop: 24 }}>
              <button type="button" className="nav-btn" onClick={back}>← Back</button>
              <button type="button" className="nav-btn" onClick={next}>{complete ? 'Continue →' : current.optional ? 'Skip for now →' : 'Continue and recheck later →'}</button>
            </div>
          </div>
        )}
      </div>
    </>
  )
}
