'use strict';

module.exports = {
  tools: {
    async write_marker(input, context) {
      context.progress('Waiting for Aiden write authority');
      if (Number.isInteger(input.delayMs) && input.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, input.delayMs));
      }
      const result = await context.broker({
        requestId: 'request_write_marker',
        operation: 'filesystem.write',
        resource: String(input.path),
        arguments: { content: String(input.content) },
      });
      if (input.crashAfterBroker === true) process.exit(91);
      return { written: true, result };
    },
  },
};
