import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { secureFetch as rawSecureFetch, secureWebFetch as rawSecureWebFetch, readTextBounded } from '../../../moat/secureFetch';
import { SSRFProtection } from '../../../moat/ssrfProtection';
import { webFetchTool } from '../../../tools/v4/web/webFetch';
import { HttpTransport } from '../../../core/v4/mcp/transport';

import { withLocalAccess } from '../helpers/localAccess';
const grantFetch = (fetcher: typeof rawSecureFetch): typeof rawSecureFetch => (input, init, options) => options?.allowLoopbackOrigin
  ? withLocalAccess(options.allowLoopbackOrigin, ['http:GET', 'http:POST'], () => fetcher(input, init, options))
  : fetcher(input, init, options);
const secureFetch = grantFetch(rawSecureFetch);
const secureWebFetch = grantFetch(rawSecureWebFetch);
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function ownedServer(handler: Parameters<typeof createServer>[0]) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

describe('connection-bound HTTP egress', () => {
  it('blocks mapped loopback before any request reaches an owned listener', async () => {
    let hits = 0;
    const origin = await ownedServer((_req, res) => { hits++; res.end('marker'); });
    const port = new URL(origin).port;
    await expect(secureFetch(`http://[::ffff:127.0.0.1]:${port}/`)).rejects.toThrow(/blocked|scope/i);
    expect(hits).toBe(0);
  });

  it('the actual fetch_url handler sends zero requests to the forbidden target', async () => {
    let hits = 0;
    const origin = await ownedServer((_req, res) => { hits++; res.end('marker'); });
    const result = await webFetchTool.execute({ url: `http://[::ffff:127.0.0.1]:${new URL(origin).port}/` }, {} as never);
    expect((result as { success: boolean }).success).toBe(false);
    expect(hits).toBe(0);
  });

  it('allows only the exact explicitly configured loopback origin', async () => {
    let hits = 0;
    const origin = await ownedServer((_req, res) => { hits++; res.end('marker'); });
    const response = await secureFetch(`${origin}/ok`, {}, { allowLoopbackOrigin: origin });
    expect(await readTextBounded(response, 32)).toBe('marker');
    expect(hits).toBe(1);
    await expect(secureFetch(`${origin}/other`)).rejects.toThrow(/blocked|scope/i);
    await expect(secureFetch('http://127.0.0.1:1/', {}, { allowLoopbackOrigin: origin })).rejects.toThrow(/blocked|scope/i);
    expect(hits).toBe(1);
  });

  it('rechecks redirect targets and never sends a request to the forbidden hop', async () => {
    let redirectedTargetHits = 0;
    let origin = '';
    origin = await ownedServer((req, res) => {
      if (req.url === '/start') {
        res.statusCode = 302;
        res.setHeader('Location', `http://[::ffff:127.0.0.1]:${new URL(origin).port}/forbidden`);
        res.end();
      } else { redirectedTargetHits++; res.end('forbidden'); }
    });
    await expect(secureWebFetch(`${origin}/start`, {}, { allowLoopbackOrigin: origin })).rejects.toThrow(/blocked|scope/i);
    expect(redirectedTargetHits).toBe(0);
  });

  it('uses the one validated DNS answer for an owned connection', async () => {
    const origin = await ownedServer((_req, res) => res.end('pinned'));
    let lookups = 0;
    const policy = new SSRFProtection(async () => {
      lookups++;
      return [{ address: lookups === 1 ? '127.0.0.1' : '127.0.0.2', family: 4 }];
    });
    const local = origin.replace('127.0.0.1', 'localhost');
    const response = await secureFetch(local, {}, { policy, allowLoopbackOrigin: new URL(local).origin });
    expect(await response.text()).toBe('pinned');
    expect(lookups).toBe(1);
  });

  it('falls back only within the validated IPv6 and IPv4 set', async () => {
    const origin = await ownedServer((_req, res) => res.end('dual-stack'));
    const local = origin.replace('127.0.0.1', 'localhost');
    const policy = new SSRFProtection(async () => [
      { address: '::1', family: 6 }, { address: '127.0.0.1', family: 4 },
    ]);
    const response = await secureFetch(local, {}, { policy, allowLoopbackOrigin: new URL(local).origin });
    expect(await response.text()).toBe('dual-stack');
  });

  it('preserves legacy MCP JSON-RPC POST over an approved local origin', async () => {
    let requests = 0;
    const origin = await ownedServer(async (req, res) => {
      requests++;
      let body = '';
      for await (const chunk of req) body += chunk.toString();
      const message = JSON.parse(body) as { id: number; method: string };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: message.method === 'ping' ? 'pong' : null }));
    });
    const transport = new HttpTransport({
      baseUrl: origin,
      disableSse: true,
      fetchFn: (input, init) => secureFetch(input, init, { allowLoopbackOrigin: origin }),
    });
    try { expect(await transport.request('ping')).toBe('pong'); }
    finally { await transport.close(); }
    expect(requests).toBe(1);
  });

  it('cancels an oversized streaming response and closes the owned socket', async () => {
    let notifyClosed!: () => void;
    const closed = new Promise<void>((resolve) => { notifyClosed = resolve; });
    const origin = await ownedServer((_req, res) => {
      res.on('close', notifyClosed);
      res.write('more than sixteen bytes of synthetic text');
    });
    const response = await secureFetch(origin, {}, { allowLoopbackOrigin: origin });
    await expect(readTextBounded(response, 16)).rejects.toThrow(/byte limit/i);
    await expect(Promise.race([
      closed.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000)),
    ])).resolves.toBe(true);
  });

  it('honors cancellation carried by a Request before connecting', async () => {
    let hits = 0;
    const origin = await ownedServer((_req, res) => { hits++; res.end('unexpected'); });
    const controller = new AbortController();
    const request = new Request(origin, { signal: controller.signal });
    controller.abort();
    await expect(secureFetch(request, {}, { allowLoopbackOrigin: origin })).rejects.toThrow(/cancel/i);
    expect(hits).toBe(0);
  });

  it('preserves Request POST data and aborts a streaming response', async () => {
    let received = '';
    const origin = await ownedServer(async (req, res) => {
      for await (const chunk of req) received += chunk.toString();
      res.write('first');
    });
    const controller = new AbortController();
    const request = new Request(origin, { method: 'POST', body: 'synthetic', signal: controller.signal });
    const response = await secureFetch(request, {}, { allowLoopbackOrigin: origin });
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    controller.abort();
    await expect(reader.read()).rejects.toThrow();
    expect(received).toBe('synthetic');
  });

  it('rejects an entire mixed DNS set without a connection', async () => {
    let connections = 0;
    const origin = await ownedServer((_req, res) => res.end('unexpected'));
    servers[servers.length - 1].on('connection', () => connections++);
    const policy = new SSRFProtection(async () => [
      { address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 },
    ]);
    await expect(secureFetch(`http://mixed.example:${new URL(origin).port}/`, {}, { policy })).rejects.toThrow(/blocked|scope/i);
    expect(connections).toBe(0);
  });

  it('handles relative redirects and bounds loops and hop counts', async () => {
    const origin = await ownedServer((req, res) => {
      if (req.url === '/done') return void res.end('done');
      res.statusCode = 302;
      const path = req.url === '/start' ? '/done' : req.url === '/loop' ? '/loop' : `/${Number(req.url!.slice(1)) + 1}`;
      res.setHeader('location', path);
      res.end();
    });
    expect(await (await secureWebFetch(`${origin}/start`, {}, { allowLoopbackOrigin: origin })).text()).toBe('done');
    await expect(secureWebFetch(`${origin}/loop`, {}, { allowLoopbackOrigin: origin })).rejects.toThrow(/loop/i);
    await expect(secureWebFetch(`${origin}/0`, {}, { allowLoopbackOrigin: origin })).rejects.toThrow(/limit/i);
  });
});
