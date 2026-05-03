/**
 * tools/v4/skills/lookupToolSchema.ts — `lookup_tool_schema` wrapper.
 *
 * Lets the agent introspect its own tool registry — given a tool
 * name, returns the JSON schema and description it would use to
 * call that tool. Used by the model when it isn't sure of an
 * unfamiliar tool's argument shape.
 *
 * V4-native: reads from the runtime `ToolRegistry` (not the v3
 * dispatch table). This means MCP tools and Phase-9 skill tools
 * become discoverable for free as soon as they're registered.
 *
 * The registry isn't passed via `ToolContext` — wrapping the
 * registry into the context would create a cycle (registry needs
 * to know its own handlers). Instead the helper is constructed
 * with a registry reference and registered as a closure.
 *
 * Status: PHASE 7. Read-only.
 */

import type { ToolHandler, ToolRegistry } from '../../../core/v4/toolRegistry';

export function makeLookupToolSchema(registry: ToolRegistry): ToolHandler {
  return {
    schema: {
      name: 'lookup_tool_schema',
      description:
        'Look up the schema and description of a registered tool by name. Use when you want to call a tool you have not used before and need to know what arguments it takes.',
      inputSchema: {
        type: 'object',
        properties: {
          toolName: {
            type: 'string',
            description: 'The name of the tool to look up.',
          },
        },
        required: ['toolName'],
      },
    },
    category: 'read',
    mutates: false,
    toolset: 'skills',
    async execute(args) {
      const name = String(args.toolName ?? args.name ?? '').trim();
      if (!name) return { success: false, error: 'No toolName provided' };
      const handler = registry.get(name);
      if (!handler) {
        return {
          success: false,
          error: `Tool "${name}" is not registered`,
          availableTools: registry.list(),
        };
      }
      return {
        success: true,
        schema: handler.schema,
        category: handler.category,
        mutates: handler.mutates,
        toolset: handler.toolset,
      };
    },
  };
}
