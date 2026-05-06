/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/toolRegistry.ts — Aiden v4.0.0
 *
 * Central tool registry. The agent loop sees tools through two surfaces:
 *
 *   1. `getSchemas()` — array of `ToolSchema` advertised to the LLM.
 *   2. `buildExecutor()` — the `(call) => Promise<ToolCallResult>` function
 *      `AidenAgent` invokes when the model emits tool calls.
 *
 * Wrappers in `tools/v4/<toolset>/` register themselves here at boot via
 * `tools/v4/index.ts::registerReadOnlyTools()` (Phase 7) and
 * `registerWriteTools()` (Phase 8).
 *
 * The registry is intentionally dumb: no validation logic, no policy
 * enforcement, no scheduling. Those concerns live in `AidenAgent`,
 * Phase 9's approval engine, and individual tool wrappers.
 *
 * Hermes reference: hermes-agent/model_tools.py — flat dict lookup with
 * per-call dispatch. Aiden adds a typed `ToolHandler` shape and per-tool
 * risk metadata (`category`, `mutates`) so Phase 9 can gate tool calls
 * without scanning the wrapper bodies.
 *
 * Status: PHASE 8.
 */

import type {
  ToolSchema,
  ToolCallRequest,
  ToolCallResult,
} from '../../providers/v4/types';
import type { AidenPaths } from './paths';
import type { SessionManager } from './sessionManager';
import type { MemoryManager } from './memoryManager';
import type { ProcessRegistry } from './processRegistry';
import type { ApprovalEngine } from '../../moat/approvalEngine';
import type { SSRFProtection } from '../../moat/ssrfProtection';
import type { TirithScanner } from '../../moat/tirithScanner';
import type { MemoryGuard } from '../../moat/memoryGuard';
import { classifyCommand } from '../../moat/dangerousPatterns';
import type { SkillLoader } from './skillLoader';
import type { BundledManifest } from './skillBundledManifest';

/**
 * Risk profile for a tool. Used by the Phase 9 approval engine to decide
 * whether a call needs user confirmation. Read-only tools (`read`,
 * `network`, `browser` queries) just run; `write` and `execute` will be
 * gated in Phase 9.
 */
export type ToolCategory = 'read' | 'write' | 'execute' | 'network' | 'browser';

export interface ToolContext {
  /** Current working directory (for relative paths in file tools). */
  cwd: string;
  /** Aiden user-data paths. Sessions, memory, skills, logs all live here. */
  paths: AidenPaths;
  /** Session manager for the `session_search` / `session_list` tools. */
  sessions?: SessionManager;
  /** Memory manager — currently unused (memory loads via prompt snapshot)
   *  but plumbed through so Phase 9 memory-write tools can hook in. */
  memory?: MemoryManager;
  /** Process registry shared across `process_*` tools (Phase 8). */
  processes?: ProcessRegistry;
  /** Which terminal backend `shell_exec` should route to. Phase 9
   *  populates this from session/policy; defaults to `'local'`. */
  terminalBackend?: 'local' | 'docker';
  /** Override the default Docker image for the docker backend.
   *  Phase 8 default is `node:22-alpine`. */
  dockerImage?: string;
  /** Phase 9: approval engine. When present, every `mutates: true`
   *  handler is gated through it before `execute` runs. */
  approvalEngine?: ApprovalEngine;
  /** Phase 9: SSRF check for any tool whose category is `network`. */
  ssrfProtection?: SSRFProtection;
  /** Phase 9: content scanner. `shell_exec` runs commands through it
   *  before dispatching. */
  tirithScanner?: TirithScanner;
  /** Phase 9: memory write verification. Memory tool wrappers call
   *  through this. */
  memoryGuard?: MemoryGuard;
  /** Phase 10: skill loader for `skills_list` / `skill_view`. */
  skillLoader?: SkillLoader;
  /** Phase 10: bundled manifest for `skills_list` userModified flag
   *  and for `skill_manage` writes to track user-modification state. */
  skillManifest?: BundledManifest;
  /** Optional structured logger. Wrappers call this for diagnostic output. */
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

/**
 * One tool. `schema` is what the LLM sees; `execute` is what runs.
 *
 * `execute` MAY throw — the registry's executor wraps thrown errors into
 * a `ToolCallResult.error` so the loop never crashes from a bad tool. But
 * wrappers SHOULD prefer returning a structured `{ error: ... }` object
 * (or rethrowing with a clear message) over silently absorbing failures.
 */
export interface ToolHandler {
  schema: ToolSchema;
  execute(args: Record<string, unknown>, context: ToolContext): Promise<unknown>;
  category: ToolCategory;
  /** True for any tool that mutates state (disk, processes, network writes). */
  mutates: boolean;
  /** Group label — `web`, `files`, `browser`, `sessions`, `skills`, etc. */
  toolset?: string;
}

export class ToolRegistry {
  private readonly handlers = new Map<string, ToolHandler>();

  register(handler: ToolHandler): void {
    this.handlers.set(handler.schema.name, handler);
  }

  unregister(name: string): void {
    this.handlers.delete(name);
  }

  get(name: string): ToolHandler | undefined {
    return this.handlers.get(name);
  }

  /** All registered tool names, in insertion order. */
  list(): string[] {
    return [...this.handlers.keys()];
  }

  /**
   * Schemas to advertise to the LLM. When `filterToolsets` is provided,
   * only handlers whose `toolset` matches one of the entries are returned.
   */
  getSchemas(filterToolsets?: string[]): ToolSchema[] {
    const out: ToolSchema[] = [];
    for (const handler of this.handlers.values()) {
      if (filterToolsets && filterToolsets.length > 0) {
        if (!handler.toolset || !filterToolsets.includes(handler.toolset)) {
          continue;
        }
      }
      out.push(handler.schema);
    }
    return out;
  }

  /** Filter handlers by risk category. */
  byCategory(cat: ToolCategory): ToolHandler[] {
    return [...this.handlers.values()].filter((h) => h.category === cat);
  }

  /**
   * Build the executor function `AidenAgent` consumes. Closes over
   * `context` so individual tool calls don't have to thread it manually.
   *
   * Errors are NEVER thrown out of the executor — they become
   * `{ error: '...' }` results so the model can read the failure and
   * recover. Two error shapes:
   *
   *   - Unknown tool          → `Tool "X" is not registered`.
   *   - Handler threw         → that error's message verbatim.
   */
  buildExecutor(
    context: ToolContext,
  ): (call: ToolCallRequest) => Promise<ToolCallResult> {
    return async (call: ToolCallRequest): Promise<ToolCallResult> => {
      const handler = this.handlers.get(call.name);
      if (!handler) {
        return {
          id: call.id,
          name: call.name,
          result: null,
          error: `Tool "${call.name}" is not registered`,
        };
      }

      const args = call.arguments ?? {};

      // ── Phase 9 layer A: SSRF check for network tools ─────────
      if (handler.category === 'network' && context.ssrfProtection) {
        const url =
          typeof args.url === 'string'
            ? args.url
            : typeof args.query === 'string'
            ? args.query
            : '';
        if (url && /^https?:/i.test(url)) {
          const ssrf = await context.ssrfProtection.check(url);
          if (ssrf.blocked) {
            return {
              id: call.id,
              name: call.name,
              result: null,
              error: `URL blocked: ${ssrf.reason}`,
            };
          }
        }
      }

      // ── Phase 9 layer B: tirith scan for shell_exec ───────────
      if (call.name === 'shell_exec' && context.tirithScanner) {
        const command =
          typeof args.command === 'string' ? args.command : '';
        if (command) {
          const findings = context.tirithScanner.scanCommand(command);
          const dangerous = findings.find((f) => f.severity === 'dangerous');
          if (dangerous) {
            return {
              id: call.id,
              name: call.name,
              result: null,
              error: `Tirith blocked: ${dangerous.description}`,
            };
          }
        }
      }

      // ── Phase 9 layer C: approval engine for mutating tools ───
      if (handler.mutates && context.approvalEngine) {
        // Pre-classify shell_exec commands so smart-mode has a tier.
        let riskTier: 'safe' | 'caution' | 'dangerous' | undefined;
        let reason: string | undefined;
        if (call.name === 'shell_exec' && typeof args.command === 'string') {
          const c = classifyCommand(args.command);
          riskTier = c.tier;
          reason = c.reason;
        }
        const allowed = await context.approvalEngine.checkApproval({
          toolName: call.name,
          category: handler.category,
          args,
          riskTier,
          reason,
        });
        if (!allowed) {
          return {
            id: call.id,
            name: call.name,
            result: null,
            error: 'Tool execution denied by approval engine',
          };
        }
      }

      try {
        const result = await handler.execute(args, context);
        return { id: call.id, name: call.name, result };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { id: call.id, name: call.name, result: null, error: message };
      }
    };
  }
}
