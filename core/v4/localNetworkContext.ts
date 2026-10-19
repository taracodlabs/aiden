/** Dispatch context for existing durable ActionAuthority approvals.
 * This carries a reference, never a cached authorization decision. */
import { createHash } from 'node:crypto';

export interface LocalAccessBinding {
  approvalId: string;
  jobId: string;
  attemptId: string;
  generation: number;
  fenceToken: string;
  toolCallId: string;
  effectId: string | null;
  actionDigest: string;
  policySnapshotId: string;
  workspaceId: string;
  sessionId: string;
  accountId: string | null;
  action: string;
}

/** Stored in PolicySnapshotInput.networkPolicy.localAccess before approval. */
export interface LocalNetworkScope {
  workspaceId: string;
  sessionId: string;
  accountId: string | null;
  action: string;
  origin: string;
  capabilities: string[];
  expiresAt: number;
  /** Digest of credential-bearing headers; null for unauthenticated access. */
  principalDigest?: string | null;
}

export function networkPrincipalDigest(headers: Headers): string | null {
  const principal = [...headers.entries()].filter(([name]) =>
    /authorization|cookie|api[-_]?key|token|secret|credential/i.test(name)).sort(([a], [b]) => a.localeCompare(b));
  return principal.length ? createHash('sha256').update(JSON.stringify(principal)).digest('hex') : null;
}

/** Read the actual wire operation, including the MCP tool name. Unknown/batch
 * payloads fail closed instead of inheriting the surrounding tool's authority. */
export async function networkRequestCapability(request: Request, protocol?: 'mcp' | 'a2a'): Promise<string> {
  if (!protocol) return `http:${request.method}`;
  if (request.method !== 'POST') return `${protocol}:http:${request.method}:${new URL(request.url).pathname}`;
  const body: unknown = await request.clone().json();
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid local protocol request');
  const message = body as { method?: unknown; params?: { name?: unknown; message?: { metadata?: { skillId?: unknown } } } };
  if (typeof message.method !== 'string' || !message.method) throw new Error('Missing local protocol capability');
  if (protocol === 'mcp' && message.method === 'tools/call') {
    if (typeof message.params?.name !== 'string' || !message.params.name) throw new Error('Missing MCP tool capability');
    return `mcp:tools/call:${message.params.name}`;
  }
  if (protocol === 'a2a' && ['SendMessage', 'SendStreamingMessage'].includes(message.method)) {
    const skill = message.params?.message?.metadata?.skillId;
    if (typeof skill !== 'string' || !skill) throw new Error('Missing A2A skill capability');
    return `a2a:${message.method}:${skill}`;
  }
  return `${protocol}:${message.method}`;
}
