// ============================================================
// DevOS — Autonomous AI Execution System
// Copyright (c) 2026 Shiva Deore. All rights reserved.
// ============================================================

// providers/requesty.ts — Requesty provider (OpenAI-compatible LLM gateway)
// Mirrors the OpenRouter provider: same OpenAI-compatible chat/completions
// path, pointed at https://router.requesty.ai/v1 with provider/model naming
// (e.g. openai/gpt-4o-mini).

import { Provider } from './types'

export function createRequestyProvider(apiKey: string): Provider {
  return {
    name: 'requesty',

    async generate(messages, model) {
      const res = await fetch('https://router.requesty.ai/v1/chat/completions', {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer':  'http://localhost:3000',
          'X-Title':       'DevOS',
        },
        body: JSON.stringify({ model, messages }),
      })
      const data = await res.json() as any
      return data?.choices?.[0]?.message?.content || ''
    },

    async generateStream(messages, model, onToken) {
      try {
        const res = await fetch('https://router.requesty.ai/v1/chat/completions', {
          method:  'POST',
          headers: {
            'Content-Type':  'application/json',
            'Authorization': `Bearer ${apiKey}`,
            'HTTP-Referer':  'http://localhost:3000',
            'X-Title':       'DevOS',
          },
          body: JSON.stringify({ model, messages, stream: true }),
        })
        if (!res.ok) {
          const err = await res.text()
          throw new Error(`${res.status}: ${err}`)
        }
        if (!res.body) return
        const reader  = (res.body as any).getReader()
        const decoder = new TextDecoder()
        let buf = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          const lines = buf.split('\n')
          buf = lines.pop() ?? ''
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue
            const raw = line.replace('data: ', '').trim()
            if (raw === '[DONE]') return
            try {
              const parsed = JSON.parse(raw) as any
              const token  = parsed?.choices?.[0]?.delta?.content
              if (token) onToken(token)
            } catch {}
          }
        }
      } catch (err) {
        throw err
      }
    },
  }
}
