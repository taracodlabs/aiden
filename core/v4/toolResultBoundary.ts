import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { scrubString } from './logger/redact';
import { McpCredentialFilter } from './mcp/credentialFilter';

export const DEFAULT_MODEL_TOOL_RESULT_CAP_BYTES = 12_000;
const filter = new McpCredentialFilter();

export interface ToolResultTransmissionMetadata {
  rawSize: number;
  transmittedSize: number;
  contentHash: string;
  truncated: boolean;
  summarized: boolean;
  artifactHandle: string | null;
  pagingHandle: { offset: number; limit: number } | null;
  retrievalMethod: 'tool_result_artifact_read' | null;
}

export interface SerializedToolResult {
  content: string;
  metadata: ToolResultTransmissionMetadata;
}

export interface ToolResultArtifactRead {
  content: string;
  offset: number;
  nextOffset: number | null;
  totalBytes: number;
  complete: boolean;
}

export interface ToolResultArtifactStore {
  put(content: string): Promise<string>;
  read(handle: string, offset?: number, limit?: number): Promise<ToolResultArtifactRead>;
  cleanup(olderThanMs: number): Promise<number>;
}

let configuredArtifactStore: ToolResultArtifactStore | null = null;

export function configureToolResultArtifactStore(root: string | null): ToolResultArtifactStore | null {
  configuredArtifactStore = root ? new LocalToolResultArtifactStore(root) : null;
  return configuredArtifactStore;
}

export function currentToolResultArtifactStore(): ToolResultArtifactStore | null {
  return configuredArtifactStore;
}

/** Local, content-addressed storage for sanitized oversized tool results. */
export class LocalToolResultArtifactStore implements ToolResultArtifactStore {
  constructor(private readonly root: string) {}

  async put(content: string): Promise<string> {
    const hash = sha256(content);
    const target = path.join(this.root, `${hash}.txt`);
    await mkdir(this.root, { recursive: true });
    try {
      await stat(target);
    } catch {
      const temporary = path.join(this.root, `.${hash}.${randomBytes(6).toString('hex')}.tmp`);
      await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' });
      try {
        await rename(temporary, target);
      } catch (error) {
        await rm(temporary, { force: true });
        try { await stat(target); } catch { throw error; }
      }
    }
    return `tool-result://${hash}`;
  }

  async read(handle: string, offset = 0, limit = 12_000): Promise<ToolResultArtifactRead> {
    const hash = parseHandle(handle);
    const content = await readFile(path.join(this.root, `${hash}.txt`), 'utf8');
    const bytes = Buffer.from(content, 'utf8');
    const start = clampInteger(offset, 0, bytes.length);
    const count = clampInteger(limit, 1, 100_000);
    const end = Math.min(bytes.length, start + count);
    return {
      content: bytes.subarray(start, end).toString('utf8'),
      offset: start,
      nextOffset: end < bytes.length ? end : null,
      totalBytes: bytes.length,
      complete: start === 0 && end === bytes.length,
    };
  }

  async cleanup(olderThanMs: number): Promise<number> {
    const { readdir } = await import('node:fs/promises');
    const cutoff = Date.now() - Math.max(0, olderThanMs);
    let removed = 0;
    let entries: string[];
    try { entries = await readdir(this.root); } catch { return 0; }
    for (const entry of entries) {
      if (!/^[a-f0-9]{64}\.txt$/.test(entry)) continue;
      const file = path.join(this.root, entry);
      try {
        if ((await stat(file)).mtimeMs < cutoff) {
          await rm(file, { force: true });
          removed += 1;
        }
      } catch { /* concurrent cleanup is harmless */ }
    }
    return removed;
  }
}

export interface SerializeToolResultOptions {
  toolName: string;
  toolCallId?: string;
  capBytes?: number;
  artifactStore?: ToolResultArtifactStore | null;
}

/**
 * The single boundary applied immediately before a tool result enters model
 * history. Small values remain byte-identical. Oversized values are sanitized,
 * stored locally when configured, and replaced by one protocol-valid envelope.
 */
export async function serializeToolResultForModel(
  raw: string,
  options: SerializeToolResultOptions,
): Promise<SerializedToolResult> {
  const rawSize = Buffer.byteLength(raw, 'utf8');
  const capBytes = clampInteger(
    options.capBytes ?? DEFAULT_MODEL_TOOL_RESULT_CAP_BYTES,
    1_024,
    1_000_000,
  );
  const safe = sanitize(raw);
  const contentHash = sha256(safe);
  if (rawSize <= capBytes) {
    return {
      content: raw,
      metadata: {
        rawSize,
        transmittedSize: rawSize,
        contentHash,
        truncated: false,
        summarized: false,
        artifactHandle: null,
        pagingHandle: null,
        retrievalMethod: null,
      },
    };
  }

  let artifactHandle: string | null = null;
  if (options.artifactStore) {
    try { artifactHandle = await options.artifactStore.put(safe); } catch { artifactHandle = null; }
  }
  const excerptBudget = Math.max(256, capBytes - 1_500);
  const excerpt = boundedHeadTail(safe, excerptBudget);
  const envelope = {
    toolCallId: options.toolCallId ?? null,
    tool: options.toolName,
    result: excerpt,
    transmission: {
      rawSize,
      contentHash,
      truncated: true,
      summarized: false,
      artifactHandle,
      pagingHandle: artifactHandle ? { offset: 0, limit: 12_000 } : null,
      retrievalMethod: artifactHandle ? 'tool_result_artifact_read' : null,
      reason: 'model-visible tool result exceeded the transmission budget',
    },
  };
  const content = JSON.stringify(envelope);
  return {
    content,
    metadata: {
      rawSize,
      transmittedSize: Buffer.byteLength(content, 'utf8'),
      contentHash,
      truncated: true,
      summarized: false,
      artifactHandle,
      pagingHandle: artifactHandle ? { offset: 0, limit: 12_000 } : null,
      retrievalMethod: artifactHandle ? 'tool_result_artifact_read' : null,
    },
  };
}

function sanitize(value: string): string {
  return filter.redact(scrubString(value));
}

function boundedHeadTail(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maxBytes) return value;
  const marker = Buffer.from('\n[... content externalized ...]\n', 'utf8');
  const available = Math.max(0, maxBytes - marker.length);
  const head = Math.floor(available * 0.4);
  const tail = available - head;
  return Buffer.concat([
    bytes.subarray(0, head),
    marker,
    bytes.subarray(bytes.length - tail),
  ]).toString('utf8');
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function parseHandle(handle: string): string {
  const match = /^tool-result:\/\/([a-f0-9]{64})$/.exec(handle);
  if (!match) throw new Error('Invalid tool-result artifact handle');
  return match[1];
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}
