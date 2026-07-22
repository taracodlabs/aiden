'use strict';

const fs = require('node:fs');
const http = require('node:http');

const readyPath = process.env.AIDEN_TEST_PROVIDER_READY;
const countPath = process.env.AIDEN_TEST_PROVIDER_COUNT;
const fixturePath = process.env.AIDEN_TEST_TOOL_FIXTURE;
if (!readyPath || !countPath || !fixturePath) throw new Error('Controlled provider paths are required.');

let calls = 0;

function messageText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      if (typeof part.text === 'string') return part.text;
      if (typeof part.content === 'string') return part.content;
      return '';
    })
    .join('');
}

function collectSmokeMarkers(value, found = []) {
  if (typeof value === 'string') {
    for (const marker of ['RESTART', 'package history turn', 'use a tool for package history']) {
      if (value.includes(marker)) found.push(marker);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) collectSmokeMarkers(item, found);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectSmokeMarkers(item, found);
  }
  return [...new Set(found)];
}

const server = http.createServer((request, response) => {
  let body = '';
  request.setEncoding('utf8');
  request.on('data', (chunk) => { body += chunk; });
  request.on('end', () => {
    calls += 1;
    fs.writeFileSync(countPath, String(calls), 'utf8');
    let payload = {};
    try { payload = JSON.parse(body); } catch { /* validation is exercised by the client */ }
    const smokeMarkers = collectSmokeMarkers(payload);
    fs.appendFileSync(`${countPath}.requests.jsonl`, `${JSON.stringify({
      call: calls,
      keys: Object.keys(payload),
      markers: smokeMarkers,
    })}\n`, 'utf8');
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    let latestUserIndex = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index] && messages[index].role === 'user') {
        latestUserIndex = index;
        break;
      }
    }
    const latestUser = latestUserIndex >= 0 ? messages[latestUserIndex] : undefined;
    const hasToolResult = latestUserIndex >= 0 && messages
      .slice(latestUserIndex + 1)
      .some((message) => message && message.role === 'tool');
    const userText = messageText(latestUser?.content);
    const message = hasToolResult
      ? { role: 'assistant', content: 'PACKAGED TOOL PASS' }
      : /^use a tool\b/i.test(userText)
        ? {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'packaged-file-read',
              type: 'function',
              function: {
                name: 'file_read',
                arguments: JSON.stringify({ path: fixturePath, offset: 0, limit: 50 }),
              },
            }],
          }
        : { role: 'assistant', content: smokeMarkers.includes('RESTART') ? 'PACKAGED RESTART PASS' : 'PACKAGED SIMPLE PASS' };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 10 },
    }));
  });
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Provider server did not bind TCP.');
  fs.writeFileSync(readyPath, `http://127.0.0.1:${address.port}/v1`, 'utf8');
});

const stop = () => server.close(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
