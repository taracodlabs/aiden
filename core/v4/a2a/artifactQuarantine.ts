/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { runtimeArtifactDirectory } from '../runtimeStorage';

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export interface A2aArtifactQuarantine {
  put(remoteArtifactId: string, contentDigest: string, bytes: Buffer): string;
  read(remoteArtifactId: string, contentDigest: string): Buffer;
  remove(remoteArtifactId: string, contentDigest: string): void;
}

export function createA2aArtifactQuarantine(
  root = runtimeArtifactDirectory('remote-quarantine'),
): A2aArtifactQuarantine {
  const resolvedRoot = path.resolve(root);
  const fileFor = (remoteArtifactId: string, contentDigest: string): string => {
    if (!/^remote_artifact_[a-f0-9]{32}$/i.test(remoteArtifactId) || !/^[a-f0-9]{64}$/i.test(contentDigest)) {
      throw new Error('Remote artifact quarantine identity is invalid');
    }
    const candidate = path.resolve(resolvedRoot, remoteArtifactId, contentDigest);
    if (!isInside(resolvedRoot, candidate)) throw new Error('Remote artifact quarantine path escaped its root');
    return candidate;
  };
  return {
    put(remoteArtifactId, contentDigest, bytes) {
      const destination = fileFor(remoteArtifactId, contentDigest);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      try {
        fs.writeFileSync(destination, bytes, { flag: 'wx', mode: 0o600 });
      } catch (error) {
        if (!fs.existsSync(destination)) throw error;
        const existing = fs.readFileSync(destination);
        if (createHash('sha256').update(existing).digest('hex') !== contentDigest) {
          throw new Error('Remote artifact quarantine content conflict');
        }
      }
      return destination;
    },
    read(remoteArtifactId, contentDigest) {
      const source = fileFor(remoteArtifactId, contentDigest);
      const stat = fs.lstatSync(source);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Remote artifact quarantine entry is not a regular file');
      const bytes = fs.readFileSync(source);
      if (createHash('sha256').update(bytes).digest('hex') !== contentDigest) {
        throw new Error('Remote artifact quarantine digest changed');
      }
      return bytes;
    },
    remove(remoteArtifactId, contentDigest) {
      const source = fileFor(remoteArtifactId, contentDigest);
      fs.rmSync(source, { force: true });
      try { fs.rmdirSync(path.dirname(source)); } catch { /* another quarantined item remains */ }
    },
  };
}
