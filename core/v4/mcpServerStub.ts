/**
 * core/v4/mcpServerStub.ts — Aiden v4.0.0 (Phase 11)
 *
 * Aiden as an MCP server. PHASE 11 STUB — full implementation lands in
 * v4.1 once the gateway exists, because the interesting tools
 * (`messages_send`, `events_poll`, `permissions_*`) require a running
 * session for external agents to attach to.
 *
 * Design note (frozen, do not implement here): the server eventually
 * exposes 10 tools matching Hermes's bridge surface so any MCP-aware
 * client (Cursor, Claude Code, Zed, JetBrains) can drive an Aiden
 * session over MCP:
 *
 *   read-only:
 *     conversations_list      — list recent conversations
 *     conversation_get        — fetch a conversation by id
 *     messages_read           — page through messages in a conversation
 *     attachments_fetch       — pull attachments for a message
 *
 *   subscribe / wait:
 *     events_poll             — non-blocking poll for events
 *     events_wait             — long-poll until an event arrives
 *
 *   write (gateway-dependent — the reason full impl is deferred):
 *     messages_send           — append a message to the active session
 *     channels_list           — list open channels (Slack-equivalent)
 *
 *   permission gates (gateway-dependent):
 *     permissions_list_open   — pending approval requests
 *     permissions_respond     — approve / deny a pending request
 *
 * Status: PHASE 11 STUB.
 */

export type AidenMcpServerTool =
  | 'conversations_list'
  | 'conversation_get'
  | 'messages_read'
  | 'attachments_fetch'
  | 'events_poll'
  | 'events_wait'
  | 'messages_send'
  | 'channels_list'
  | 'permissions_list_open'
  | 'permissions_respond';

/**
 * Static surface described above — used by docs / tests / future
 * scaffolding so the API is discoverable without depending on this
 * stub being live.
 */
export const AIDEN_MCP_SERVER_TOOLS: ReadonlyArray<AidenMcpServerTool> = Object.freeze([
  'conversations_list',
  'conversation_get',
  'messages_read',
  'attachments_fetch',
  'events_poll',
  'events_wait',
  'messages_send',
  'channels_list',
  'permissions_list_open',
  'permissions_respond',
]);

export interface AidenMcpServerOptions {
  /** Run as `aiden mcp serve --stdio` (subprocess host). */
  stdio?: boolean;
  /** Run as `aiden mcp serve --port N` (HTTP host). */
  port?: number;
}

const PHASE_11_STUB_MESSAGE =
  'AidenMcpServer is a Phase 11 stub. The full server (10 tools, gateway-backed) lands in v4.1.';

export class AidenMcpServer {
  readonly tools = AIDEN_MCP_SERVER_TOOLS;

  constructor(private readonly opts: AidenMcpServerOptions = {}) {
    void opts;
  }

  /** Start the server. Phase 11: throws — feature lands v4.1. */
  // eslint-disable-next-line @typescript-eslint/require-await
  async start(): Promise<void> {
    throw new Error(PHASE_11_STUB_MESSAGE);
  }

  /** Stop the server. Phase 11: no-op (start always throws). */
  async stop(): Promise<void> {
    /* noop */
  }
}
