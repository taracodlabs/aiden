/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/mcp/filters.ts — Aiden v4.0.0 (Phase 11)
 *
 * Tool include/exclude filtering for MCP servers. Glob is intentionally
 * minimal: `*` matches any character sequence, `?` matches one. No nested
 * brace expansion — Phase 11 servers can be filtered on simple names.
 *
 * Status: PHASE 11.
 */

export interface ToolFilterConfig {
  include?: string[];
  exclude?: string[];
}

export interface FilterableTool {
  rawName: string;
}

/**
 * Apply include/exclude rules to a tool list.
 *
 * Semantics:
 *   - No `include`: all tools pass the include check.
 *   - `include` present: tool name must match at least one entry.
 *   - `exclude` present: tool name must not match any entry. Exclude wins.
 */
export class McpToolFilter {
  filter<T extends FilterableTool>(tools: T[], filter?: ToolFilterConfig): T[] {
    if (!filter || (!filter.include?.length && !filter.exclude?.length)) {
      return [...tools];
    }
    return tools.filter((t) => this.allows(t.rawName, filter));
  }

  allows(toolName: string, filter: ToolFilterConfig): boolean {
    if (filter.exclude?.some((p) => this.matches(toolName, p))) return false;
    if (filter.include && filter.include.length > 0) {
      return filter.include.some((p) => this.matches(toolName, p));
    }
    return true;
  }

  matches(toolName: string, pattern: string): boolean {
    if (pattern === '*' || pattern === toolName) return true;
    if (!/[*?]/.test(pattern)) return pattern === toolName;
    // Build a literal regex: escape regex meta, then turn * → .* and ? → .
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp('^' + escaped.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
    return regex.test(toolName);
  }
}
