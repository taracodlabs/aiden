'use client'
/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

import type { WorkbenchExecutionSurface } from '../lib/aidenClient'

export default function LiveExecutionTerminal({ surface }: { surface: WorkbenchExecutionSurface }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const surfaceRef = useRef<string | null>(null)
  const cursorRef = useRef(0)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const terminal = new Terminal({
      disableStdin: true,
      convertEol: true,
      scrollback: 2_000,
      fontFamily: 'var(--mono)',
      fontSize: 12,
      lineHeight: 1.4,
      theme: {
        background: '#101112', foreground: '#d8d8d8', cursor: '#f97316',
        black: '#101112', brightBlack: '#737373', red: '#f87171', green: '#4ade80',
        yellow: '#fbbf24', blue: '#60a5fa', magenta: '#c084fc', cyan: '#22d3ee', white: '#e5e7eb',
      },
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(container)
    terminalRef.current = terminal
    fitRef.current = fit
    fit.fit()
    const observer = new ResizeObserver(() => fit.fit())
    observer.observe(container)
    return () => {
      observer.disconnect()
      terminal.dispose()
      terminalRef.current = null
      fitRef.current = null
      surfaceRef.current = null
      cursorRef.current = 0
    }
  }, [])

  useEffect(() => {
    const terminal = terminalRef.current
    const state = surface.terminal
    if (!terminal || !state) return
    if (surfaceRef.current !== surface.surfaceId || state.latestStreamSeq < cursorRef.current) {
      terminal.reset()
      surfaceRef.current = surface.surfaceId
      cursorRef.current = 0
    }
    for (const chunk of state.chunks) {
      if (chunk.streamSeq <= cursorRef.current) continue
      terminal.write(chunk.data)
      cursorRef.current = chunk.streamSeq
    }
    fitRef.current?.fit()
  }, [surface])

  return <div ref={containerRef} className="live-execution-terminal" aria-label="Read-only live terminal" />
}
