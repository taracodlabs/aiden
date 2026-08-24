// ============================================================
// Aiden — autonomous execution system
// Copyright (c) 2026 Shiva Deore.
// ============================================================

// dashboard-next/lib/theme.ts — Phase 1 of Prompt 9.
//
// Dashboard-safe re-export of shared ▲IDEN tokens.
// No ANSI escape codes — use these for Tailwind arbitrary values
// or React inline styles.

export const MARKS = {
  TRI:        '▲',
  TRI_O:      '△',
  ARROW:      '▸',
  DOT:        '●',
  DOT_O:      '○',
  DIAMOND:    '◆',
  DASH:       '─',
  CAT_FILE:   '≡',
  CAT_WEB:    '⊕',
  CAT_CODE:   '⚙',
  CAT_MEMORY: '◎',
  CAT_SYSTEM: '⬡',
  CAT_MEDIA:  '◈',
  CAT_DATA:   '◉',
  CAT_AI:     '◍',
} as const

export const COLORS = {
  orange:  '#FF6B35',
  bgBase:  '#0D0D0D',
  dim:     '#666666',
  success: '#4CAF50',
  error:   '#F44336',
  warning: '#FFC107',
  white:   '#FFFFFF',
  blue:    '#5B9CF6',
  cyan:    '#4DD0E1',
  gold:    '#FFB800',
  red:     '#FF4D4D',
} as const
