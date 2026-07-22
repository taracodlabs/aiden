import type { ToolHandler } from '../../../core/v4/toolRegistry';
import { currentToolResultArtifactStore } from '../../../core/v4/toolResultBoundary';

export const toolResultArtifactReadTool: ToolHandler = {
  schema: {
    name: 'tool_result_artifact_read',
    description: 'Read a bounded page from a locally externalized tool result using its opaque handle.',
    inputSchema: {
      type: 'object',
      properties: {
        handle: { type: 'string', description: 'Opaque tool-result:// handle.' },
        offset: { type: 'number', description: 'Byte offset, default 0.' },
        limit: { type: 'number', description: 'Maximum bytes to return, capped at 100000.' },
      },
      required: ['handle'],
    },
  },
  category: 'read',
  mutates: false,
  toolset: 'files',
  riskTier: 'safe',
  async execute(args) {
    const store = currentToolResultArtifactStore();
    if (!store) return { success: false, error: 'Tool-result artifact storage is unavailable.' };
    try {
      const page = await store.read(
        String(args.handle ?? ''),
        typeof args.offset === 'number' ? args.offset : 0,
        typeof args.limit === 'number' ? args.limit : 12_000,
      );
      return { success: true, handle: String(args.handle), ...page };
    } catch {
      return { success: false, error: 'Tool-result artifact could not be read.' };
    }
  },
};
