/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

export type SupportLevel = 'supported' | 'partially_validated' | 'experimental' | 'unsupported';

export interface PlatformSupport {
  platform: NodeJS.Platform;
  release: string;
  nodeMajor: number;
  level: SupportLevel;
  detail: string;
}

export function classifyPlatform(input: {
  platform?: NodeJS.Platform;
  release?: string;
  nodeVersion?: string;
} = {}): PlatformSupport {
  const platform = input.platform ?? process.platform;
  const release = input.release ?? require('node:os').release();
  const nodeVersion = input.nodeVersion ?? process.versions.node;
  const nodeMajor = Number.parseInt(nodeVersion.split('.')[0], 10);
  if (![20, 22].includes(nodeMajor)) {
    return { platform, release, nodeMajor, level: 'unsupported', detail: `Node ${nodeMajor} is not certified; use Node 20 or 22.` };
  }
  if (platform === 'win32') {
    const windowsMajor = Number.parseInt(release.split('.')[0], 10);
    return windowsMajor >= 10
      ? { platform, release, nodeMajor, level: 'supported', detail: 'Windows 11 is the primary supported platform.' }
      : { platform, release, nodeMajor, level: 'unsupported', detail: 'Windows 11 is required.' };
  }
  if (platform === 'darwin' || platform === 'linux') {
    return { platform, release, nodeMajor, level: 'partially_validated', detail: 'Validated by CI; physical platform certification is limited.' };
  }
  return { platform, release, nodeMajor, level: 'experimental', detail: 'This platform is not part of the supported test matrix.' };
}

