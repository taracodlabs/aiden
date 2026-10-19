/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { Agent, fetch as undiciFetch } from 'undici';
import { SSRFProtection } from './ssrfProtection';
import { networkRequestCapability, networkPrincipalDigest } from '../core/v4/localNetworkContext';
import { assertLocalNetworkAccess } from '../core/v4/actionAuthority';

export interface SecureFetchOptions {
  policy?: SSRFProtection;
  /** Destination hint only; a matching durable ActionAuthority approval is required. */
  allowLoopbackOrigin?: string;
  localProtocol?: 'mcp' | 'a2a';
  /** Recheck a durable capability at every async egress boundary. */
  authorizeRequest?: () => void | Promise<void>;
  /** Revocation signal for a capability shared by connected clients. */
  authorizationSignal?: AbortSignal;
}

/**
 * Resolve once under policy and bind the new socket to that validated address.
 * Each call owns its dispatcher; redirects are deliberately manual. The caller
 * may stream the response and cancellation propagates to the socket.
 */
export async function secureFetch(
  input: string | URL | Request,
  init: RequestInit = {},
  options: SecureFetchOptions = {},
): Promise<Response> {
  // Normalize with the same WHATWG parser, and retain Request-carried method,
  // body and cancellation when callers do not repeat them in init.
  const request = new Request(input, init);
  const principalDigest = networkPrincipalDigest(request.headers);
  const capability = options.allowLoopbackOrigin
    ? await networkRequestCapability(request, options.localProtocol) : undefined;
  const authorize = async () => {
    if (options.allowLoopbackOrigin) assertLocalNetworkAccess(request.url, capability!, principalDigest);
    await options.authorizeRequest?.();
  };
  await authorize?.();
  const signal = options.authorizationSignal
    ? AbortSignal.any([request.signal, options.authorizationSignal])
    : request.signal;
  if (signal.aborted) throw new Error('Request cancelled before destination validation');
  const target = request.url;
  const policy = options.policy ?? new SSRFProtection();
  const result = await policy.resolve(target, options.allowLoopbackOrigin);
  if (result.verdict.blocked || !result.parsed || result.addresses.length === 0) {
    throw new Error(`URL blocked by network policy: ${result.verdict.reason ?? 'unsafe destination'}`);
  }
  if (signal.aborted) throw new Error('Request cancelled before connection');
  await authorize?.();
  if (signal.aborted) throw new Error('Request cancelled before connection');
  const validated = result.addresses;
  const dispatcher = new Agent({
    connections: 1,
    pipelining: 1,
    connect: {
      autoSelectFamily: true,
      lookup: (_hostname, lookupOptions, callback) => {
        try {
          if (options.allowLoopbackOrigin) assertLocalNetworkAccess(target, capability!, principalDigest);
        } catch (error) {
          callback(error as NodeJS.ErrnoException, [], 0);
          return;
        }
        if (lookupOptions.all) {
          callback(null, validated);
        } else {
          callback(null, validated[0].address, validated[0].family);
        }
      },
    },
  });

  const headerDeadline = new AbortController();
  const headerTimer = setTimeout(() => headerDeadline.abort(), 15_000);
  headerTimer.unref?.();
  try {
    // Keep this check adjacent to dispatch. In particular, a DNS lookup that
    // waited across revocation must not authorize the later socket request.
    await authorize?.();
    if (signal.aborted) throw new Error('Request cancelled before connection');
    if (options.allowLoopbackOrigin) assertLocalNetworkAccess(target, capability!, principalDigest);
    const response = await undiciFetch(target, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      duplex: 'half',
      redirect: 'manual',
      dispatcher,
      signal: AbortSignal.any([signal, headerDeadline.signal]),
    } as unknown as NonNullable<Parameters<typeof undiciFetch>[1]>);
    clearTimeout(headerTimer);
    if (!response.body) {
      void dispatcher.close();
      return response as Response;
    }
    const reader = response.body.getReader();
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader.read();
          if (next.done) {
            controller.close();
            void dispatcher.close();
          } else {
            controller.enqueue(next.value);
          }
        } catch (error) {
          controller.error(error);
          await dispatcher.destroy();
        }
      },
      async cancel(reason) {
        try { await reader.cancel(reason); }
        finally { await dispatcher.destroy(); }
      },
    });
    const wrapped = new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    Object.defineProperty(wrapped, 'url', { value: response.url });
    return wrapped;
  } catch (error) {
    clearTimeout(headerTimer);
    await dispatcher.destroy();
    throw error;
  }
}

/** Only ordinary read-only web fetches follow redirects, with a fresh policy
 * resolution and pinned connection for every hop. */
export async function secureWebFetch(
  url: string,
  init: RequestInit = {},
  options: SecureFetchOptions = {},
): Promise<Response> {
  if (init.method && !['GET', 'HEAD'].includes(init.method.toUpperCase())) {
    throw new Error('Redirecting fetch supports only GET or HEAD');
  }
  let target = new URL(url);
  const seen = new Set<string>();
  const headers = new Headers(init.headers);
  for (let hop = 0; hop <= 5; hop++) {
    if (seen.has(target.href)) throw new Error('Redirect loop blocked');
    seen.add(target.href);
    const response = await secureFetch(target, { ...init, headers }, options);
    if (response.status < 300 || response.status >= 400 || !response.headers.has('location')) return response;
    await response.body?.cancel();
    const next = new URL(response.headers.get('location')!, target);
    if (target.protocol === 'https:' && next.protocol !== 'https:') throw new Error('HTTPS downgrade redirect blocked');
    if (hop === 5) throw new Error('Redirect limit exceeded');
    if (next.origin !== target.origin) {
      for (const name of ['authorization', 'cookie', 'proxy-authorization']) headers.delete(name);
    }
    target = next;
  }
  throw new Error('Redirect limit exceeded');
}

/** Enforce the limit while receiving, then cancel the socket on overflow. */
export async function readTextBounded(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maxBytes) throw new Error('Response exceeds byte limit');
      text += decoder.decode(part.value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}
