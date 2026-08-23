'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import * as aiden from '../lib/aidenClient'
import { ProductButton, StatusBadge } from './ProductUI'

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

const STEP_STORAGE_KEY = 'aiden:first-run:step:v1'

export function OnboardingModal({
  onComplete,
  onOpenSettings,
  onOpenApps,
}: {
  onComplete: (choice: string) => void
  onOpenSettings: (tab: 'runtime' | 'model') => void
  onOpenApps: () => void
}) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const [index, setIndex] = useState(() => {
    if (typeof window === 'undefined') return 0
    const stored = Number.parseInt(window.localStorage.getItem(STEP_STORAGE_KEY) ?? '0', 10)
    return Number.isFinite(stored) ? Math.min(Math.max(stored, 0), STEP_ORDER.length - 1) : 0
  })
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
  useEffect(() => { window.localStorage.setItem(STEP_STORAGE_KEY, String(index)) }, [index])

  const current = STEP_ORDER[index]
  const readinessItem = useMemo(
    () => current.readinessId ? readiness?.items.find((item) => item.id === current.readinessId) : undefined,
    [current.readinessId, readiness],
  )
  const complete = readinessItem?.ready ?? readinessItem?.healthy === true
  const optionalNotConfigured = current.optional === true && !complete
    && ['setup_available', 'needs_setup', 'unavailable'].includes(readinessItem?.state ?? '')
  const next = () => setIndex((value) => Math.min(STEP_ORDER.length - 1, value + 1))
  const back = () => setIndex((value) => Math.max(0, value - 1))

  useEffect(() => {
    const dialog = dialogRef.current
    const firstControl = dialog?.querySelector<HTMLElement>('button:not([disabled]), a[href], input:not([disabled])')
    firstControl?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && index > 0) {
        event.preventDefault()
        back()
      }
    }
    dialog?.addEventListener('keydown', onKeyDown)
    return () => dialog?.removeEventListener('keydown', onKeyDown)
  }, [index])

  const action = () => {
    if (!readinessItem) return null
    if (readinessItem.availableActions.includes('manage_provider')) {
      return <ProductButton variant="primary" onClick={() => onOpenSettings('model')}>Open AI &amp; Models</ProductButton>
    }
    if (readinessItem.availableActions.includes('manage_apps')) {
      return <ProductButton variant="primary" onClick={onOpenApps}>Open Apps</ProductButton>
    }
    return <ProductButton variant="primary" onClick={() => onOpenSettings('runtime')}>Open Readiness</ProductButton>
  }

  return (
    <>
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(6px)', zIndex: 1000 }} />
      <div ref={dialogRef} className="onboarding-dialog" role="dialog" aria-modal="true" aria-labelledby="onboarding-title" aria-describedby="onboarding-detail" style={{
        position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
        zIndex: 1001,
      }}>
        <div style={{ display: 'flex', gap: 5, marginBottom: 28 }}>
          {STEP_ORDER.map((step, stepIndex) => <div key={step.id} style={{ height: 3, flex: 1, borderRadius: 2, background: stepIndex <= index ? '#f97316' : '#2a2a2a' }} />)}
        </div>

        {current.id === 'welcome' ? (
          <div>
            <span className="onboarding-icon" aria-hidden="true">A</span>
            <h2 id="onboarding-title">Welcome to Aiden</h2>
            <p id="onboarding-detail">
              Aiden will check this computer, show what is ready, and explain the next action. Browser, coding, and Apps setup can be skipped.
            </p>
            <ProductButton variant="primary" onClick={next}>Check this computer →</ProductButton>
          </div>
        ) : current.id === 'ready' ? (
          <div>
            <span className="onboarding-icon" aria-hidden="true">✓</span>
            <h2 id="onboarding-title">{readiness?.overall === 'ready' ? 'Aiden is ready' : 'Setup can continue later'}</h2>
            <p id="onboarding-detail">
              {readiness?.overall === 'ready' ? 'Choose what you want to accomplish first.' : 'Required issues remain visible in Settings → Readiness. Optional capabilities do not block Chat.'}
            </p>
            <div style={{ display: 'grid', gap: 8, marginTop: 20 }}>
              {FIRST_SUCCESS.map((choice, choiceIndex) => <ProductButton key={choice} variant={choiceIndex === 0 ? 'primary' : 'secondary'} onClick={() => onComplete(choice)}>{choice}</ProductButton>)}
            </div>
          </div>
        ) : (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline' }}>
              <div><span className="onboarding-icon" aria-hidden="true">{current.id === 'computer' ? '⌁' : current.id === 'ai' ? '◆' : current.id === 'browser' ? '◎' : current.id === 'coding' ? '</>' : '+'}</span><h2 id="onboarding-title">{current.title}</h2></div>
              {current.optional ? <span className="onboarding-optional">Optional</span> : null}
            </div>
            {checking ? <p id="onboarding-detail">Checking…</p> : error ? (
              <div>
                <p id="onboarding-detail" role="alert" className="onboarding-error">What failed: readiness could not be loaded.</p>
                <p>What Aiden knows: {error}</p>
                <ProductButton variant="secondary" onClick={() => { void refresh() }}>Recheck</ProductButton>
              </div>
            ) : readinessItem ? (
              <div>
                <StatusBadge tone={complete ? 'ready' : optionalNotConfigured ? 'disabled' : 'attention'}>{complete ? 'Ready' : optionalNotConfigured ? 'Not configured' : 'Needs attention'}</StatusBadge>
                <p id="onboarding-detail">{readinessItem.detail}</p>
                {!complete ? action() : null}
              </div>
            ) : <p id="onboarding-detail" className="onboarding-warning">Readiness information is unavailable. Open Settings → Readiness and recheck.</p>}
            <div className="onboarding-actions">
              <ProductButton variant="ghost" onClick={back}>← Back</ProductButton>
              <ProductButton variant="secondary" onClick={next}>{complete ? 'Continue →' : current.optional ? 'Skip for now →' : 'Continue and recheck later →'}</ProductButton>
            </div>
          </div>
        )}
      </div>
    </>
  )
}
