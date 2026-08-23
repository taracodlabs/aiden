'use client'

import type { ButtonHTMLAttributes, ReactNode } from 'react'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'icon'

export function ProductButton({
  variant = 'secondary',
  loading = false,
  className = '',
  children,
  disabled,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant
  loading?: boolean
}) {
  return (
    <button
      {...props}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`aiden-button aiden-button-${variant} ${className}`.trim()}
    >
      {loading ? <span className="aiden-button-spinner" aria-hidden="true" /> : null}
      <span>{children}</span>
    </button>
  )
}

export type StatusTone = 'ready' | 'attention' | 'blocked' | 'running' | 'completed' | 'verified' | 'failed' | 'unknown' | 'degraded' | 'disabled'

export function StatusBadge({ tone, children }: { tone: StatusTone; children: ReactNode }) {
  return <span className={`aiden-status aiden-status-${tone}`} role="status"><span aria-hidden="true" />{children}</span>
}

export function ProductEmptyState({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) {
  return <div className="aiden-empty-state"><strong>{title}</strong><p>{detail}</p>{action}</div>
}
