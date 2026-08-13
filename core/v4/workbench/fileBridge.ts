/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import type { Artifact, ArtifactStore } from '../daemon/artifactStore';

export interface WorkbenchAttachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  path: string;
}

export interface WorkbenchArtifactContent {
  id: string;
  name: string;
  mime: string;
  bytes: Buffer;
}

export interface WorkbenchFileBridge {
  saveAttachment(input: { name: string; mime?: string; bytes: Buffer }): WorkbenchAttachment;
  resolveAttachments(ids: readonly string[]): WorkbenchAttachment[];
  listArtifacts(input: { runId?: number; sessionId?: string; limit?: number }): Artifact[];
  readArtifact(id: string): WorkbenchArtifactContent | null;
}

const DEFAULT_ATTACHMENT_LIMIT = 8 * 1024 * 1024;
const DEFAULT_ARTIFACT_LIMIT = 12 * 1024 * 1024;

function safeName(input: string): string {
  const base = path.basename(input.replace(/\\/g, '/')).replace(/[^a-zA-Z0-9._ -]+/g, '_').trim();
  return (base || 'attachment').slice(0, 120);
}

function mimeFor(file: string): string {
  switch (path.extname(file).toLowerCase()) {
    case '.svg': return 'image/svg+xml';
    case '.png': return 'image/png';
    case '.jpg': case '.jpeg': return 'image/jpeg';
    case '.gif': return 'image/gif';
    case '.webp': return 'image/webp';
    case '.pdf': return 'application/pdf';
    case '.json': return 'application/json';
    case '.md': case '.markdown': return 'text/markdown';
    case '.txt': case '.log': case '.csv': return 'text/plain';
    default: return 'application/octet-stream';
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/** Conservative SVG preview sanitizer. Workbench previews need shapes and text,
 * not script, foreign documents, event handlers, or remote references. */
export function sanitizeSvg(input: string): string {
  return input
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<foreignObject\b[^>]*>[\s\S]*?<\/foreignObject\s*>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s+(?:href|xlink:href)\s*=\s*(?:"(?:javascript:|https?:)[^"]*"|'(?:javascript:|https?:)[^']*')/gi, '');
}

export function createWorkbenchFileBridge(options: {
  root: string;
  artifacts?: Pick<ArtifactStore, 'get' | 'listRecent'>;
  artifactCwd?: string;
  maxAttachmentBytes?: number;
  maxArtifactBytes?: number;
}): WorkbenchFileBridge {
  const attachmentRoot = path.resolve(options.root, 'attachments');
  const maxAttachmentBytes = Math.max(1, options.maxAttachmentBytes ?? DEFAULT_ATTACHMENT_LIMIT);
  const maxArtifactBytes = Math.max(1, options.maxArtifactBytes ?? DEFAULT_ARTIFACT_LIMIT);
  const attachments = new Map<string, WorkbenchAttachment>();
  fs.mkdirSync(attachmentRoot, { recursive: true });

  return {
    saveAttachment(input) {
      if (!Buffer.isBuffer(input.bytes) || input.bytes.length > maxAttachmentBytes) {
        throw new Error(`attachment too large (maximum ${maxAttachmentBytes} bytes)`);
      }
      const id = `attachment_${randomBytes(12).toString('hex')}`;
      const name = safeName(input.name);
      const file = path.join(attachmentRoot, `${randomBytes(8).toString('hex')}-${name}`);
      fs.writeFileSync(file, input.bytes, { flag: 'wx' });
      const attachment: WorkbenchAttachment = {
        id,
        name,
        mime: typeof input.mime === 'string' && input.mime.trim() ? input.mime.slice(0, 120) : mimeFor(name),
        size: input.bytes.length,
        path: file,
      };
      attachments.set(id, attachment);
      return attachment;
    },
    resolveAttachments(ids) {
      const unique = [...new Set(ids)];
      return unique.map((id) => {
        const attachment = attachments.get(id);
        if (!attachment) throw new Error(`unknown attachment: ${id}`);
        return attachment;
      });
    },
    listArtifacts(input) {
      if (!options.artifacts) return [];
      const limit = Math.max(1, Math.min(input.limit ?? 50, 200));
      return options.artifacts.listRecent({ sessionId: input.sessionId, limit: 500 })
        .filter((artifact) => input.runId === undefined || artifact.runId === input.runId)
        .slice(0, limit);
    },
    readArtifact(id) {
      const artifact = options.artifacts?.get(id);
      if (!artifact || artifact.kind !== 'file') return null;
      const workspace = path.resolve(options.artifactCwd ?? process.cwd());
      const candidate = path.resolve(workspace, artifact.path);
      let stat: fs.Stats;
      try { stat = fs.lstatSync(candidate); } catch { return null; }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxArtifactBytes) return null;
      let realWorkspace: string;
      let realCandidate: string;
      try {
        realWorkspace = fs.realpathSync(workspace);
        realCandidate = fs.realpathSync(candidate);
      } catch { return null; }
      if (!isInside(realWorkspace, realCandidate)) return null;
      let bytes = fs.readFileSync(realCandidate);
      const mime = mimeFor(candidate);
      if (mime === 'image/svg+xml') bytes = Buffer.from(sanitizeSvg(bytes.toString('utf8')), 'utf8');
      return { id: artifact.id, name: safeName(candidate), mime, bytes };
    },
  };
}
