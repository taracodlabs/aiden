'use strict';

module.exports = {
  tools: {
    async workspace_summary(input, context) {
      const paths = Array.isArray(input.paths) ? input.paths : ['package.json'];
      context.progress('Reading granted workspace files');
      const files = [];
      for (let index = 0; index < paths.length; index += 1) {
        const target = String(paths[index]);
        const value = await context.broker({
          requestId: `request_read_${index}`,
          operation: 'filesystem.read',
          resource: target,
          arguments: { limit: 5000 },
        });
        const record = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
        files.push({
          path: target,
          bytes: typeof record.size === 'number' ? record.size : typeof record.content === 'string' ? record.content.length : 0,
          content: typeof record.content === 'string' ? record.content : '',
        });
      }
      return { files, count: files.length };
    },
  },
};
