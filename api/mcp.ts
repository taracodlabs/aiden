// ============================================================
// DevOS — MCP Server Mode
// Exposes Aiden's 80+ tools via the Model Context Protocol.
// Transport: stdio (for Claude Desktop, Cursor, VS Code, etc.)
//
// Usage:  node dist-bundle/cli.js mcp
// ============================================================

import { Server }               from '@modelcontextprotocol/sdk/server'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'

import { TOOLS, TOOL_DESCRIPTIONS, executeTool, getExternalToolsMeta,
         registryMcpSafeList, registryMcpDestructiveList } from '../core/toolRegistry'
import { pluginHooks } from '../core/pluginLoader'
import { loadConfig } from '../providers/index'

// ── VERSION ──────────────────────────────────────────────────
const VERSION = '3.16.0'

// ── v3.19 Phase 1 Commit 6: derived from TOOL_REGISTRY[mcp='safe'] — literal deleted ──
// take_screenshot was previously in this list but has no handler in TOOLS; it is
// automatically excluded because it has no TOOL_REGISTRY entry.
export const SAFE_TOOLS: string[] = registryMcpSafeList()

// ── v3.19 Phase 1 Commit 6: derived from TOOL_REGISTRY[mcp='destructive'] — literal deleted ──
export const DESTRUCTIVE_TOOLS: string[] = registryMcpDestructiveList()

export function getExposedTools(): string[] {
  const allowDestructive = process.env.MCP_ALLOW_DESTRUCTIVE === 'true'
  return allowDestructive
    ? [...SAFE_TOOLS, ...DESTRUCTIVE_TOOLS]
    : SAFE_TOOLS
}

// ── Per-tool input schemas (best-effort; generic fallback for the rest) ──
const TOOL_SCHEMAS: Record<string, object> = {
  web_search:    { type: 'object', properties: { query: { type: 'string', description: 'Search query' } }, required: ['query'] },
  fetch_url:     { type: 'object', properties: { url: { type: 'string', description: 'URL to fetch' } }, required: ['url'] },
  fetch_page:    { type: 'object', properties: { url: { type: 'string', description: 'URL to fetch' } }, required: ['url'] },
  deep_research: { type: 'object', properties: { topic: { type: 'string', description: 'Research topic' } }, required: ['topic'] },
  file_read:     { type: 'object', properties: { path: { type: 'string', description: 'File path to read' } }, required: ['path'] },
  file_write:    { type: 'object', properties: { path: { type: 'string', description: 'File path' }, content: { type: 'string', description: 'Content to write' } }, required: ['path', 'content'] },
  file_list:     { type: 'object', properties: { path: { type: 'string', description: 'Directory path (default: .)' } } },
  shell_exec:    { type: 'object', properties: { command: { type: 'string', description: 'Shell command to execute' } }, required: ['command'] },
  run_powershell:{ type: 'object', properties: { command: { type: 'string', description: 'PowerShell command' } }, required: ['command'] },
  cmd:           { type: 'object', properties: { command: { type: 'string', description: 'cmd.exe command' } }, required: ['command'] },
  ps:            { type: 'object', properties: { command: { type: 'string', description: 'PowerShell command (direct)' } }, required: ['command'] },
  wsl:           { type: 'object', properties: { command: { type: 'string', description: 'bash command for WSL' } }, required: ['command'] },
  run_python:    { type: 'object', properties: { code: { type: 'string', description: 'Python code to execute' } }, required: ['code'] },
  run_node:      { type: 'object', properties: { code: { type: 'string', description: 'Node.js code to execute' } }, required: ['code'] },
  get_stocks:    { type: 'object', properties: { type: { type: 'string', description: 'gainers | losers | active', enum: ['gainers', 'losers', 'active'] } } },
  get_market_data:  { type: 'object', properties: { symbol: { type: 'string', description: 'Stock symbol e.g. AAPL' } }, required: ['symbol'] },
  get_company_info: { type: 'object', properties: { symbol: { type: 'string', description: 'Stock/company symbol' } }, required: ['symbol'] },
  social_research:  { type: 'object', properties: { query: { type: 'string', description: 'Person or company to research' } }, required: ['query'] },
  screenshot:    { type: 'object', properties: { outputPath: { type: 'string', description: 'Absolute path to save screenshot (e.g. C:\\Users\\<you>\\Desktop\\shot.png). If omitted, saves to workspace/screenshots/.' } } },
  screen_read:   { type: 'object', properties: {} },
  system_info:   { type: 'object', properties: {} },
  clipboard_read: { type: 'object', properties: {} },
  clipboard_write: { type: 'object', properties: { text: { type: 'string', description: 'Text to write to clipboard' } }, required: ['text'] },
  window_list:   { type: 'object', properties: {} },
  notify:        { type: 'object', properties: { message: { type: 'string', description: 'Notification message' }, title: { type: 'string', description: 'Notification title' } }, required: ['message'] },
  open_browser:  { type: 'object', properties: { url: { type: 'string', description: 'URL to open' } }, required: ['url'] },
  browser_extract:    { type: 'object', properties: { selector: { type: 'string', description: 'Optional CSS selector' } } },
  browser_screenshot: { type: 'object', properties: {} },
  browser_get_url:    { type: 'object', properties: {} },
  browser_click:      { type: 'object', properties: { selector: { type: 'string', description: 'CSS selector to click' } }, required: ['selector'] },
  browser_type:       { type: 'object', properties: { selector: { type: 'string' }, text: { type: 'string' } }, required: ['selector', 'text'] },
  browser_scroll:     { type: 'object', properties: { direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'] }, amount: { type: 'number' } } },
  git_status:    { type: 'object', properties: { path: { type: 'string', description: 'Repo path (default: cwd)' } } },
  git_commit:    { type: 'object', properties: { message: { type: 'string', description: 'Commit message' }, path: { type: 'string' } }, required: ['message'] },
  git_push:      { type: 'object', properties: { path: { type: 'string' }, remote: { type: 'string' }, branch: { type: 'string' } } },
  read_email:    { type: 'object', properties: { count: { type: 'number', description: 'Number of emails (default 10)' }, folder: { type: 'string', description: 'Folder (default INBOX)' } } },
  send_email:    { type: 'object', properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } }, required: ['to', 'subject', 'body'] },
  lookup_skill:  { type: 'object', properties: { query: { type: 'string', description: 'Task or skill to look up' } }, required: ['query'] },
  respond:       { type: 'object', properties: { message: { type: 'string', description: 'Response text' } }, required: ['message'] },
  wait:          { type: 'object', properties: { ms: { type: 'number', description: 'Milliseconds to wait' } }, required: ['ms'] },
  voice_speak:   { type: 'object', properties: { text: { type: 'string', description: 'Text to speak aloud' } }, required: ['text'] },
  voice_transcribe: { type: 'object', properties: { path: { type: 'string', description: 'Audio file path' } }, required: ['path'] },
  spawn:         { type: 'object', properties: { goal: { type: 'string', description: 'Sub-task goal for the subagent' }, context: { type: 'string' } }, required: ['goal'] },
  spawn_subagent: { type: 'object', properties: { task: { type: 'string', description: 'Task for the subagent' } }, required: ['task'] },
}

// Generic fallback schema
const GENERIC_SCHEMA: object = {
  type: 'object' as const,
  properties: {},
  additionalProperties: true,
}

function buildInputSchema(name: string): object {
  return TOOL_SCHEMAS[name] ?? GENERIC_SCHEMA
}

function aidenToolToMCP(name: string): Tool {
  return {
    name,
    description: TOOL_DESCRIPTIONS[name] || name,
    inputSchema: buildInputSchema(name) as Tool['inputSchema'],
  }
}

// ── Start MCP server (stdio) ──────────────────────────────────
export async function startMCPServer(): Promise<void> {
  // CRITICAL: In stdio MCP mode, stdout carries the MCP protocol frames.
  // Redirect all console.* output to stderr so it doesn't corrupt the protocol.
  // We do NOT touch process.stdout.write itself — the StdioServerTransport needs it.
  const _err = (...a: any[]) => process.stderr.write(a.map(String).join(' ') + '\n')
  console.log   = _err
  console.info  = _err
  console.warn  = _err
  console.debug = _err
  // console.error already goes to stderr — leave it alone

  // Load provider config (needed for tools that call LLMs)
  try { await loadConfig() } catch { /* ignore */ }

  const server = new Server(
    { name: 'aiden', version: VERSION },
    { capabilities: { tools: {} } },
  )

  // ── List tools ──────────────────────────────────────────────
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const exposed = getExposedTools()
    const tools: Tool[] = []

    // Core tools
    for (const name of exposed) {
      if (TOOLS[name]) {
        tools.push(aidenToolToMCP(name))
      }
    }

    // Plugin-registered tools (always exposed)
    const externalMeta = getExternalToolsMeta()
    for (const [name, meta] of Object.entries(externalMeta)) {
      if (!exposed.includes(name)) {
        tools.push({
          name,
          description: `[Plugin: ${meta.source}] ${TOOL_DESCRIPTIONS[name] || name}`,
          inputSchema: (GENERIC_SCHEMA as Tool['inputSchema']),
        })
      }
    }

    return { tools }
  })

  // ── Call tool ───────────────────────────────────────────────
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params

    // Security: only exposed tools + plugin tools
    const exposed = getExposedTools()
    const externalMeta = getExternalToolsMeta()
    const isPlugin = !!externalMeta[name]

    if (!exposed.includes(name) && !isPlugin) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            error:    `Tool "${name}" is not exposed via MCP.`,
            hint:     'Set MCP_ALLOW_DESTRUCTIVE=true to expose shell/write tools.',
            exposed:  exposed.length,
          }),
        }],
        isError: true,
      }
    }

    const toolInput: Record<string, any> = (args as Record<string, any>) || {}

    // ── preTool plugin hooks ────────────────────────────────
    let skip        = false
    let skipResult: any = null
    for (const hook of pluginHooks.preTool) {
      try {
        const r = await hook(name, toolInput)
        if (r?.skip) { skip = true; skipResult = r.result ?? null; break }
        if (r?.input) Object.assign(toolInput, r.input)
      } catch { /* ignore hook errors */ }
    }

    try {
      let execResult: any

      if (skip) {
        execResult = { success: true, output: skipResult ?? '[skipped by plugin]', duration: 0, retries: 0 }
      } else {
        // Use executeTool — same path as the full agent loop (cache, timeout, retry)
        execResult = await executeTool(name, toolInput)
      }

      // ── postTool plugin hooks ─────────────────────────────
      for (const hook of pluginHooks.postTool) {
        try {
          const r = await hook(name, toolInput, execResult)
          if (r?.result) execResult = r.result
        } catch { /* ignore */ }
      }

      const text = execResult.success
        ? (typeof execResult.output === 'string' ? execResult.output : JSON.stringify(execResult.output, null, 2))
        : JSON.stringify({ error: execResult.error || 'Tool returned failure', output: execResult.output }, null, 2)

      return {
        content: [{ type: 'text' as const, text }],
        isError: !execResult.success,
      }
    } catch (err: any) {
      return {
        content: [{ type: 'text' as const, text: `Tool error: ${err.message}` }],
        isError: true,
      }
    }
  })

  // ── Connect stdio transport ─────────────────────────────────
  const transport = new StdioServerTransport()
  await server.connect(transport)
  process.stderr.write(`[mcp] Aiden MCP server v${VERSION} running on stdio\n`)
  process.stderr.write(`[mcp] Safe tools: ${SAFE_TOOLS.length}  |  Destructive (opt-in): ${DESTRUCTIVE_TOOLS.length}\n`)
  process.stderr.write(`[mcp] MCP_ALLOW_DESTRUCTIVE=${process.env.MCP_ALLOW_DESTRUCTIVE ?? 'false'}\n`)
}
