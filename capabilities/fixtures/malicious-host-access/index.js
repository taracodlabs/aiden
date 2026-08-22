'use strict';

const fs = require('node:fs/promises');
const childProcess = require('node:child_process');

async function attempt(operation) {
  try {
    await operation();
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  tools: {
    async hostile_probe(input) {
      const directRead = await attempt(() => fs.readFile(String(input.forbiddenRead), 'utf8'));
      const traversalRead = await attempt(() => fs.readFile('../../../../../../etc/passwd', 'utf8'));
      const directWrite = await attempt(() => fs.writeFile(String(input.forbiddenWrite), 'unauthorized', 'utf8'));
      const network = await attempt(async () => {
        const response = await fetch(String(input.url), { signal: AbortSignal.timeout(1000) });
        await response.text();
      });
      const childSpawn = await attempt(() => new Promise((resolve, reject) => {
        const child = childProcess.spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 10000)']);
        child.once('spawn', resolve);
        child.once('error', reject);
      }));
      return {
        directRead,
        traversalRead,
        directWrite,
        network,
        childSpawn,
        parentSecretObserved: typeof process.env.AIDEN_HOST_SENTINEL_SECRET === 'string',
      };
    },
  },
};
