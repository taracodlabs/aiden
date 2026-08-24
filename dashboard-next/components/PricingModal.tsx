'use client'

// ============================================================
// Aiden — autonomous execution system
// Copyright (c) 2026 Shiva Deore.
// ============================================================

// dashboard-next/components/PricingModal.tsx
//
// Pro upgrade modal with:
//   - 12-currency pricing (auto-detected from navigator.language)
//   - Monthly / Annual billing toggle (annual = 20% savings)
//   - INR → Razorpay payment link, all others → Stripe
//   - Free vs. Pro feature comparison
//   - License key activation UI (inline)

import React, { useState, useEffect } from 'react'

// ── Pricing data ──────────────────────────────────────────────

interface CurrencyConfig {
  symbol:      string
  monthly:     number
  annual:      number   // per-month price billed annually
  code:        string
  isRazorpay:  boolean
  stripeMonthlyLink?: string
  stripeAnnualLink?:  string
  razorpayMonthlyLink?: string
  razorpayAnnualLink?:  string
}

const PRICING: Record<string, CurrencyConfig> = {
  INR: {
    symbol: '₹', monthly: 999,  annual: 799,  code: 'INR', isRazorpay: true,
    razorpayMonthlyLink: 'https://razorpay.com/payment-link/YOUR_MONTHLY_INR_LINK',
    razorpayAnnualLink:  'https://razorpay.com/payment-link/YOUR_ANNUAL_INR_LINK',
  },
  USD: {
    symbol: '$',   monthly: 12,   annual: 10,   code: 'USD', isRazorpay: false,
    stripeMonthlyLink: 'https://buy.stripe.com/YOUR_MONTHLY_USD_LINK',
    stripeAnnualLink:  'https://buy.stripe.com/YOUR_ANNUAL_USD_LINK',
  },
  EUR: {
    symbol: '€',   monthly: 11,   annual: 9,    code: 'EUR', isRazorpay: false,
    stripeMonthlyLink: 'https://buy.stripe.com/YOUR_MONTHLY_EUR_LINK',
    stripeAnnualLink:  'https://buy.stripe.com/YOUR_ANNUAL_EUR_LINK',
  },
  GBP: {
    symbol: '£',   monthly: 10,   annual: 8,    code: 'GBP', isRazorpay: false,
    stripeMonthlyLink: 'https://buy.stripe.com/YOUR_MONTHLY_GBP_LINK',
    stripeAnnualLink:  'https://buy.stripe.com/YOUR_ANNUAL_GBP_LINK',
  },
  AUD: {
    symbol: 'A$',  monthly: 18,   annual: 14,   code: 'AUD', isRazorpay: false,
    stripeMonthlyLink: 'https://buy.stripe.com/YOUR_MONTHLY_AUD_LINK',
    stripeAnnualLink:  'https://buy.stripe.com/YOUR_ANNUAL_AUD_LINK',
  },
  CAD: {
    symbol: 'C$',  monthly: 16,   annual: 13,   code: 'CAD', isRazorpay: false,
    stripeMonthlyLink: 'https://buy.stripe.com/YOUR_MONTHLY_CAD_LINK',
    stripeAnnualLink:  'https://buy.stripe.com/YOUR_ANNUAL_CAD_LINK',
  },
  SGD: {
    symbol: 'S$',  monthly: 16,   annual: 13,   code: 'SGD', isRazorpay: false,
    stripeMonthlyLink: 'https://buy.stripe.com/YOUR_MONTHLY_SGD_LINK',
    stripeAnnualLink:  'https://buy.stripe.com/YOUR_ANNUAL_SGD_LINK',
  },
  AED: {
    symbol: 'د.إ', monthly: 44,   annual: 35,   code: 'AED', isRazorpay: false,
    stripeMonthlyLink: 'https://buy.stripe.com/YOUR_MONTHLY_AED_LINK',
    stripeAnnualLink:  'https://buy.stripe.com/YOUR_ANNUAL_AED_LINK',
  },
  JPY: {
    symbol: '¥',   monthly: 1800, annual: 1440, code: 'JPY', isRazorpay: false,
    stripeMonthlyLink: 'https://buy.stripe.com/YOUR_MONTHLY_JPY_LINK',
    stripeAnnualLink:  'https://buy.stripe.com/YOUR_ANNUAL_JPY_LINK',
  },
  BRL: {
    symbol: 'R$',  monthly: 59,   annual: 47,   code: 'BRL', isRazorpay: false,
    stripeMonthlyLink: 'https://buy.stripe.com/YOUR_MONTHLY_BRL_LINK',
    stripeAnnualLink:  'https://buy.stripe.com/YOUR_ANNUAL_BRL_LINK',
  },
  MXN: {
    symbol: 'MX$', monthly: 199,  annual: 159,  code: 'MXN', isRazorpay: false,
    stripeMonthlyLink: 'https://buy.stripe.com/YOUR_MONTHLY_MXN_LINK',
    stripeAnnualLink:  'https://buy.stripe.com/YOUR_ANNUAL_MXN_LINK',
  },
  IDR: {
    symbol: 'Rp',  monthly: 189000, annual: 151200, code: 'IDR', isRazorpay: false,
    stripeMonthlyLink: 'https://buy.stripe.com/YOUR_MONTHLY_IDR_LINK',
    stripeAnnualLink:  'https://buy.stripe.com/YOUR_ANNUAL_IDR_LINK',
  },
}

// Map browser locale → currency code
const LOCALE_TO_CURRENCY: Record<string, string> = {
  'en-IN': 'INR', 'hi': 'INR', 'hi-IN': 'INR',
  'en-US': 'USD', 'en':    'USD',
  'en-GB': 'GBP',
  'en-AU': 'AUD',
  'en-CA': 'CAD',
  'en-SG': 'SGD',
  'de': 'EUR', 'fr': 'EUR', 'it': 'EUR', 'es': 'EUR', 'nl': 'EUR', 'pt-PT': 'EUR',
  'ar-AE': 'AED', 'ar': 'AED',
  'ja': 'JPY', 'ja-JP': 'JPY',
  'pt-BR': 'BRL',
  'es-MX': 'MXN',
  'id': 'IDR', 'id-ID': 'IDR',
}

function detectCurrency(): string {
  if (typeof navigator === 'undefined') return 'USD'
  const locale = navigator.language || 'en'
  return LOCALE_TO_CURRENCY[locale]
    || LOCALE_TO_CURRENCY[locale.split('-')[0]]
    || 'USD'
}

// ── Feature comparison ────────────────────────────────────────

const FEATURES: Array<{ label: string; free: boolean | string; pro: boolean | string }> = [
  { label: 'Web search + deep research',    free: true,        pro: true  },
  { label: 'File create / read / edit',     free: true,        pro: true  },
  { label: 'Run Python, Node.js, PowerShell', free: true,      pro: true  },
  { label: 'TXT / Markdown knowledge base', free: true,        pro: true  },
  { label: 'Knowledge base files',          free: '3 files',   pro: 'Unlimited' },
  { label: 'Scheduled tasks',               free: '1 task',    pro: 'Unlimited' },
  { label: '6 communication channels',      free: true,        pro: true  },
  { label: 'Computer control + vision',     free: true,        pro: true  },
  { label: '10 LLM providers',              free: true,        pro: true  },
  { label: 'PDF ingestion',                 free: false,       pro: true  },
  { label: 'EPUB / book ingestion',         free: false,       pro: true  },
  { label: 'Voice input (Whisper STT)',      free: false,       pro: true  },
  { label: 'Text-to-speech output',         free: false,       pro: true  },
  { label: 'Priority support',              free: false,       pro: true  },
]

// ── Props ─────────────────────────────────────────────────────

interface PricingModalProps {
  onClose:       () => void
  onActivate:    (key: string) => Promise<{ success: boolean; error?: string }>
  currentStatus: { active: boolean; tier: string; email: string; expiry: number }
}

// ── Component ─────────────────────────────────────────────────

export default function PricingModal({ onClose, onActivate, currentStatus }: PricingModalProps) {
  const [annual,      setAnnual]      = useState(false)
  const [currency,    setCurrency]    = useState<string>('USD')
  const [tab,         setTab]         = useState<'pricing' | 'activate'>('pricing')
  const [keyInput,    setKeyInput]    = useState('')
  const [activating,  setActivating]  = useState(false)
  const [activateMsg, setActivateMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  useEffect(() => {
    setCurrency(detectCurrency())
  }, [])

  const cfg     = PRICING[currency] || PRICING['USD']
  const price   = annual ? cfg.annual : cfg.monthly
  const saving  = Math.round((1 - cfg.annual / cfg.monthly) * 100)
  const payLink = annual
    ? (cfg.isRazorpay ? cfg.razorpayAnnualLink  : cfg.stripeAnnualLink)
    : (cfg.isRazorpay ? cfg.razorpayMonthlyLink : cfg.stripeMonthlyLink)

  const handleActivate = async () => {
    if (!keyInput.trim()) return
    setActivating(true)
    setActivateMsg(null)
    const result = await onActivate(keyInput.trim())
    setActivating(false)
    if (result.success) {
      setActivateMsg({ type: 'success', text: 'Pro activated! Enjoy your upgrade.' })
      setTimeout(onClose, 2000)
    } else {
      setActivateMsg({ type: 'error', text: result.error || 'Activation failed. Check your key and try again.' })
    }
  }

  const formatPrice = (p: number, code: string) => {
    // IDR and JPY are whole numbers
    if (code === 'IDR') return p.toLocaleString('id-ID')
    if (code === 'JPY') return p.toLocaleString('ja-JP')
    return p.toLocaleString()
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '16px',
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{
        background: '#0f172a', border: '1px solid #1e293b',
        borderRadius: '16px', maxWidth: '560px', width: '100%',
        maxHeight: '90vh', overflowY: 'auto',
        boxShadow: '0 25px 80px rgba(0,0,0,0.6)',
      }}>

        {/* ── Header ── */}
        <div style={{ padding: '24px 24px 0', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '2px', color: '#a78bfa', textTransform: 'uppercase', marginBottom: '4px' }}>
              Aiden Pro
            </div>
            <h2 style={{ margin: 0, fontSize: '22px', fontWeight: 700, color: '#f1f5f9' }}>
              Unlock the full AI OS
            </h2>
            <p style={{ margin: '4px 0 0', fontSize: '14px', color: '#64748b' }}>
              PDF + EPUB ingestion, voice I/O, and priority support
            </p>
          </div>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', color: '#475569', cursor: 'pointer', fontSize: '20px', padding: '4px', lineHeight: 1 }}
          >✕</button>
        </div>

        {/* ── Tabs ── */}
        <div style={{ padding: '20px 24px 0', display: 'flex', gap: '4px' }}>
          {(['pricing', 'activate'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)} style={{
              padding: '7px 16px', borderRadius: '8px', border: 'none', cursor: 'pointer', fontSize: '13px', fontWeight: 600,
              background: tab === t ? '#1e293b' : 'transparent',
              color: tab === t ? '#f1f5f9' : '#64748b',
            }}>
              {t === 'pricing' ? 'Pricing' : 'Activate Key'}
            </button>
          ))}
        </div>

        <div style={{ padding: '20px 24px 24px' }}>

          {tab === 'pricing' && (
            <>
              {/* ── Billing toggle ── */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px' }}>
                <button
                  onClick={() => setAnnual(false)}
                  style={{
                    padding: '6px 14px', borderRadius: '8px', border: 'none', cursor: 'pointer', fontSize: '13px',
                    background: !annual ? '#6d28d9' : '#1e293b', color: !annual ? '#fff' : '#94a3b8', fontWeight: 600,
                  }}
                >Monthly</button>
                <button
                  onClick={() => setAnnual(true)}
                  style={{
                    padding: '6px 14px', borderRadius: '8px', border: 'none', cursor: 'pointer', fontSize: '13px',
                    background: annual ? '#6d28d9' : '#1e293b', color: annual ? '#fff' : '#94a3b8', fontWeight: 600,
                    display: 'flex', alignItems: 'center', gap: '6px',
                  }}
                >
                  Annual
                  <span style={{ background: '#22c55e', color: '#fff', fontSize: '10px', fontWeight: 700, padding: '2px 6px', borderRadius: '99px' }}>
                    {saving}% off
                  </span>
                </button>

                {/* Currency selector */}
                <select
                  value={currency}
                  onChange={e => setCurrency(e.target.value)}
                  style={{
                    marginLeft: 'auto', background: '#1e293b', border: '1px solid #334155', color: '#94a3b8',
                    borderRadius: '8px', padding: '6px 10px', fontSize: '12px', cursor: 'pointer',
                  }}
                >
                  {Object.keys(PRICING).map(c => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>

              {/* ── Price card ── */}
              <div style={{
                background: 'linear-gradient(135deg, #1e1040 0%, #0f172a 100%)',
                border: '1px solid #4c1d95', borderRadius: '12px',
                padding: '20px', marginBottom: '20px', textAlign: 'center',
              }}>
                <div style={{ fontSize: '44px', fontWeight: 800, color: '#f1f5f9', lineHeight: 1 }}>
                  <span style={{ fontSize: '22px', color: '#a78bfa', verticalAlign: 'super', fontWeight: 700 }}>
                    {cfg.symbol}
                  </span>
                  {formatPrice(price, cfg.code)}
                </div>
                <div style={{ color: '#64748b', fontSize: '13px', marginTop: '4px' }}>
                  per month{annual ? ', billed annually' : ''}
                </div>
                {annual && (
                  <div style={{ color: '#94a3b8', fontSize: '12px', marginTop: '6px' }}>
                    {cfg.symbol}{formatPrice(cfg.annual * 12, cfg.code)} / year
                  </div>
                )}

                <a
                  href={payLink || '#'}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    display: 'block', marginTop: '16px',
                    background: 'linear-gradient(135deg, #7c3aed, #a855f7)',
                    color: '#fff', textDecoration: 'none', padding: '12px 24px',
                    borderRadius: '10px', fontWeight: 700, fontSize: '15px',
                    boxShadow: '0 4px 20px rgba(139,92,246,0.4)',
                    transition: 'opacity 0.2s',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.opacity = '0.88')}
                  onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
                >
                  {cfg.isRazorpay ? 'Pay with Razorpay →' : 'Pay with Stripe →'}
                </a>

                <p style={{ color: '#475569', fontSize: '11px', marginTop: '10px', marginBottom: 0 }}>
                  Your license key will be emailed within seconds of payment.
                </p>
              </div>

              {/* ── Feature comparison ── */}
              <div style={{ border: '1px solid #1e293b', borderRadius: '10px', overflow: 'hidden' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px 80px', background: '#1e293b' }}>
                  <div style={{ padding: '10px 14px', fontSize: '12px', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '1px' }}>Feature</div>
                  <div style={{ padding: '10px 0', fontSize: '12px', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', textAlign: 'center' }}>Free</div>
                  <div style={{ padding: '10px 0', fontSize: '12px', fontWeight: 700, color: '#a78bfa', textTransform: 'uppercase', textAlign: 'center' }}>Pro</div>
                </div>
                {FEATURES.map((f, i) => (
                  <div
                    key={i}
                    style={{
                      display: 'grid', gridTemplateColumns: '1fr 80px 80px',
                      borderTop: '1px solid #1e293b',
                      background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)',
                    }}
                  >
                    <div style={{ padding: '9px 14px', fontSize: '13px', color: '#94a3b8' }}>{f.label}</div>
                    <div style={{ padding: '9px 0', textAlign: 'center', fontSize: typeof f.free === 'string' ? '12px' : '15px', color: typeof f.free === 'string' ? '#94a3b8' : 'inherit' }}>
                      {typeof f.free === 'string' ? f.free : f.free ? '✓' : '–'}
                    </div>
                    <div style={{ padding: '9px 0', textAlign: 'center', fontSize: typeof f.pro === 'string' ? '12px' : '15px', color: typeof f.pro === 'string' ? '#a78bfa' : '#a78bfa' }}>
                      {typeof f.pro === 'string' ? f.pro : f.pro ? '✓' : '–'}
                    </div>
                  </div>
                ))}
              </div>

              <p style={{ textAlign: 'center', marginTop: '16px', marginBottom: 0 }}>
                <button
                  onClick={() => setTab('activate')}
                  style={{ background: 'none', border: 'none', color: '#a78bfa', cursor: 'pointer', fontSize: '13px', textDecoration: 'underline' }}
                >
                  Already have a key? Activate →
                </button>
              </p>
            </>
          )}

          {tab === 'activate' && (
            <div>
              <p style={{ color: '#94a3b8', fontSize: '14px', marginTop: 0 }}>
                Paste your license key below. You'll receive it by email after payment.
              </p>

              {currentStatus.active && (
                <div style={{ background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.3)', borderRadius: '8px', padding: '12px', marginBottom: '16px', fontSize: '13px', color: '#86efac' }}>
                  ✓ Pro is already active — licensed to {currentStatus.email}
                  {currentStatus.expiry > 0 && ` · Expires ${new Date(currentStatus.expiry).toLocaleDateString()}`}
                </div>
              )}

              <div style={{ display: 'flex', gap: '8px' }}>
                <input
                  value={keyInput}
                  onChange={e => setKeyInput(e.target.value.toUpperCase())}
                  placeholder="XXXXX-XXXXX-XXXXX-XXXXX"
                  style={{
                    flex: 1, background: '#1e293b', border: '1px solid #334155',
                    borderRadius: '8px', padding: '10px 14px',
                    color: '#f1f5f9', fontSize: '14px', fontFamily: 'monospace', letterSpacing: '2px',
                    outline: 'none',
                  }}
                  onKeyDown={e => { if (e.key === 'Enter') handleActivate() }}
                />
                <button
                  onClick={handleActivate}
                  disabled={activating || !keyInput.trim()}
                  style={{
                    background: activating ? '#334155' : '#7c3aed', border: 'none',
                    borderRadius: '8px', padding: '10px 20px',
                    color: '#fff', fontWeight: 700, fontSize: '14px', cursor: activating ? 'wait' : 'pointer',
                    opacity: (!keyInput.trim() && !activating) ? 0.5 : 1,
                  }}
                >
                  {activating ? '…' : 'Activate'}
                </button>
              </div>

              {activateMsg && (
                <div style={{
                  marginTop: '12px', padding: '10px 14px', borderRadius: '8px', fontSize: '13px',
                  background: activateMsg.type === 'success' ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
                  border: `1px solid ${activateMsg.type === 'success' ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}`,
                  color: activateMsg.type === 'success' ? '#86efac' : '#fca5a5',
                }}>
                  {activateMsg.text}
                </div>
              )}

              <p style={{ color: '#475569', fontSize: '12px', marginTop: '16px', marginBottom: 0 }}>
                Don't have a key?{' '}
                <button
                  onClick={() => setTab('pricing')}
                  style={{ background: 'none', border: 'none', color: '#a78bfa', cursor: 'pointer', fontSize: '12px', textDecoration: 'underline', padding: 0 }}
                >
                  View pricing →
                </button>
              </p>
            </div>
          )}

        </div>
      </div>
    </div>
  )
}
