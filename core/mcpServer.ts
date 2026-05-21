// ============================================================
// DevOS — Autonomous AI Execution System
// Copyright (c) 2026 Shiva Deore. All rights reserved.
// ============================================================

// core/mcpServer.ts — Sprint 29: Expose Aiden as an MCP server.
// Any MCP-compatible client (Claude Desktop, Cursor, Cline, etc.)
// can connect to http://localhost:3001 and use all of Aiden's tools,
// plus unified memory recall.

import express, { Request, Response } from 'express'
import { executeTool, TOOL_DESCRIPTIONS } from './toolRegistry'
import { unifiedMemoryRecall }           from './memoryRecall'

// ── MCP Server ────────────────────────────────────────────────

export function startMCPServer(port = 3001): void {
  const app = express()
  app.use(express.json())

  // ── CORS — allow any MCP client origin ───────────────────
  app.use((_req: Request, res: Response, next) => {
    res.setHeader('Access-Control-Allow-Origin',  '*')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    next()
  })
  app.options('*', (_req: Request, res: Response) => res.sendStatus(200))

  // ── MCP protocol: tools/list ──────────────────────────────
  // Returns all Aiden tools in the MCP tools/list format.
  app.post('/tools/list', (_req: Request, res: Response) => {
    const tools = Object.entries(TOOL_DESCRIPTIONS).map(([name, desc]) => ({
      name,
      description: desc,
      inputSchema: {
        type:       'object',
        properties: { input: { type: 'object', description: 'Tool-specific input parameters' } },
      },
    }))
    res.json({ jsonrpc: '2.0', id: 1, result: { tools } })
  })

  // ── MCP protocol: tools/call ──────────────────────────────
  // Executes a named tool with the provided arguments.
  app.post('/tools/call', async (req: Request, res: Response) => {
    const { name, arguments: args } = (req.body?.params || req.body) as any || {}

    if (!name) {
      res.json({
        jsonrpc: '2.0',
        id:      1,
        error:   { code: -32600, message: 'Tool name required' },
      })
      return
    }

    try {
      const result = await executeTool(name, args || {})
      res.json({
        jsonrpc: '2.0',
        id:      1,
        result:  {
          content: [{ type: 'text', text: result.output || '' }],
          isError: !result.success,
        },
      })
    } catch (e: any) {
      res.json({
        jsonrpc: '2.0',
        id:      1,
        result:  { content: [{ type: 'text', text: e.message }], isError: true },
      })
    }
  })

  // ── Memory recall — bonus endpoint for external agents ────
  // External MCP clients can query Aiden's unified memory
  // (episodic, semantic, conversation) with a natural-language query.
  app.post('/memory/recall', async (req: Request, res: Response) => {
    const { query, topK } = (req.body || {}) as any

    if (!query) {
      res.json({ error: 'query required' })
      return
    }

    try {
      const recalled = await unifiedMemoryRecall(query, topK || 5)
      res.json({ success: true, ...recalled })
    } catch (e: any) {
      res.json({ success: false, error: e.message })
    }
  })

  // ── Health / discovery ────────────────────────────────────
  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status:  'ok',
      name:    'aiden-mcp',
      version: '2.0',
      tools:   Object.keys(TOOL_DESCRIPTIONS).length,
    })
  })

  // ── Start listening ───────────────────────────────────────
  app.listen(port, '127.0.0.1', () => {
    console.log(`[MCP Server] Aiden MCP server running at http://localhost:${port}`)
    console.log(`[MCP Server] Connect from Claude Desktop or any MCP client`)
    console.log(`[MCP Server] ${Object.keys(TOOL_DESCRIPTIONS).length} tools available`)
  })
}
