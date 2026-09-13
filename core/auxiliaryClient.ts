// ============================================================
// DevOS — Autonomous AI Execution System
// Copyright (c) 2026 Shiva Deore. All rights reserved.
// ============================================================

// core/auxiliaryClient.ts — Cheap LLM client for side tasks.
// Side tasks (memory extraction, dream consolidation, session
// reflection, compression summaries) don't need the main model.
// Routes to the executor tier (Cerebras → Groq → Nvidia → Ollama)
// with lower max_tokens and shorter timeout than the main loop.
// Matches the agentLoop.ts direct-fetch pattern exactly.
// Falls back to callBgLLM if the executor route fails.

import { getModelForTask } from '../providers/router'
import { callBgLLM }       from './bgLLM'
import { costTracker }     from './costTracker'

// ── OpenAI-compat endpoints (mirrors agentLoop.ts) ────────────

const AUX_ENDPOINTS: Record<string, string> = {
  groq:       'https://api.groq.com/openai/v1/chat/completions',
  cerebras:   'https://api.cerebras.ai/v1/chat/completions',
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
  requesty:   'https://router.requesty.ai/v1/chat/completions',
  nvidia:     'https://integrate.api.nvidia.com/v1/chat/completions',
  github:     'https://models.inference.ai.azure.com/chat/completions',
  boa:        'https://api.boa.ai/v1/chat/completions',
  mistral:    'https://api.mistral.ai/v1/chat/completions',
}

// ── Types ─────────────────────────────────────────────────────

interface AuxiliaryConfig {
  preferLocal:    boolean   // try Ollama first for aux tasks
  maxTokens:      number    // cap output for aux tasks (default 500)
  timeout:        number    // shorter timeout (10s)
  fallbackToMain: boolean   // if aux fails, use bgLLM fallback
}

const DEFAULT_AUX_CONFIG: AuxiliaryConfig = {
  preferLocal:    true,
  maxTokens:      500,
  timeout:        10000,
  fallbackToMain: true,
}

// ── AuxiliaryClient ───────────────────────────────────────────

class AuxiliaryClient {
  private config: AuxiliaryConfig

  constructor(config?: Partial<AuxiliaryConfig>) {
    this.config = { ...DEFAULT_AUX_CONFIG, ...config }
  }

  // ── Public: single-turn completion for a side task ─────────

  async complete(
    prompt:   string,
    options?: { task?: string; maxTokens?: number },
  ): Promise<string> {
    const task      = options?.task      || 'general'
    const maxTokens = options?.maxTokens || this.config.maxTokens

    // Executor tier: Cerebras → Groq → Nvidia → Ollama (cheapest available)
    const { apiKey, model, providerName, apiName } = getModelForTask('executor')

    console.log(`[Aux] ${task} — routing to ${apiName} (${providerName}/${model})`)

    try {
      const result = await this.callProviderDirect(
        providerName, apiKey, model, prompt, maxTokens,
      )
      if (result) {
        console.log(
          `[Aux] Side task "${task}" routed to ${apiName} ` +
          `instead of main model — estimated savings: ~$0.001`,
        )
        return result
      }
    } catch (e: any) {
      console.log(`[Aux] ${apiName} failed (${e.message}) — falling back`)
    }

    // Fallback: bgLLM (Cerebras → Ollama — safe, no global state)
    if (this.config.fallbackToMain) {
      console.log(`[Aux] Falling back to bgLLM for ${task}`)
      return callBgLLM(prompt, `aux_${task}`)
    }

    return ''
  }

  // ── Direct fetch — matches agentLoop.ts pattern ────────────
  // Lower max_tokens + shorter timeout vs. main loop.
  // Does NOT touch currentAbortController (safe for side tasks).

  private async callProviderDirect(
    providerName: string,
    apiKey:       string,
    model:        string,
    prompt:       string,
    maxTokens:    number,
  ): Promise<string> {
    const messages = [
      { role: 'system', content: 'You are a concise assistant. Respond briefly and accurately.' },
      { role: 'user',   content: prompt },
    ]

    // ── Ollama ───────────────────────────────────────────────
    if (providerName === 'ollama') {
      const r = await fetch('http://localhost:11434/api/chat', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ model, stream: false, messages }),
        signal:  AbortSignal.timeout(this.config.timeout),
      })
      if (!r.ok) throw new Error(`ollama ${r.status}`)
      const d = await r.json() as any
      try {
        costTracker.trackUsage(
          'ollama', model,
          d?.prompt_eval_count ?? 0,
          d?.eval_count        ?? 0,
          undefined, true,
        )
      } catch {}
      return d?.message?.content || ''
    }

    // ── OpenAI-compatible (Cerebras, Groq, Nvidia, OpenRouter) ─
    const url = AUX_ENDPOINTS[providerName]
    if (!url || !apiKey) return ''

    const r = await fetch(url, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body:   JSON.stringify({ model, messages, stream: false, max_tokens: maxTokens }),
      signal: AbortSignal.timeout(this.config.timeout),
    })
    if (r.status === 429) throw new Error(`rate limited (429)`)
    if (!r.ok) throw new Error(`${providerName} ${r.status}`)
    const d = await r.json() as any
    try {
      costTracker.trackUsage(
        providerName, model,
        d?.usage?.prompt_tokens    ?? 0,
        d?.usage?.completion_tokens ?? 0,
        undefined, true,
      )
    } catch {}
    return d?.choices?.[0]?.message?.content || ''
  }
}

// ── Singleton ──────────────────────────────────────────────────

export const auxiliaryClient = new AuxiliaryClient()
