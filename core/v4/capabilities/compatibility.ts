/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import type { CapabilityManifest } from '../../../packages/capability-sdk/src';

type ParsedVersion = [number, number, number];

function parseVersion(value: string): ParsedVersion | null {
  const match = value.trim().replace(/^v/u, '').match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/u);
  return match ? [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)] : null;
}

function compare(left: ParsedVersion, right: ParsedVersion): number {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

export function satisfiesCapabilityRange(versionText: string, range: string): boolean {
  const version = parseVersion(versionText);
  if (!version) return false;
  return range.split('||').some((alternative) => {
    const terms = alternative.trim().split(/\s+/u).filter(Boolean);
    if (terms.length === 0) return false;
    return terms.every((term) => {
      const match = term.match(/^(>=|<=|>|<|=|\^|~)?(\d+(?:\.\d+){0,2})$/u);
      if (!match) return false;
      const target = parseVersion(match[2]);
      if (!target) return false;
      const result = compare(version, target);
      switch (match[1] ?? '=') {
        case '>=': return result >= 0;
        case '<=': return result <= 0;
        case '>': return result > 0;
        case '<': return result < 0;
        case '^': return result >= 0 && version[0] === target[0];
        case '~': return result >= 0 && version[0] === target[0] && version[1] === target[1];
        default: return result === 0;
      }
    });
  });
}

export interface CapabilityCompatibilityResult {
  compatible: boolean;
  errors: string[];
  enforcement: 'docker_required';
}

export function validateCapabilityCompatibility(manifest: CapabilityManifest, environment: {
  aidenVersion: string;
  nodeVersion?: string;
  platform?: NodeJS.Platform;
  architecture?: string;
}): CapabilityCompatibilityResult {
  const nodeVersion = environment.nodeVersion ?? process.versions.node;
  const platform = environment.platform ?? process.platform;
  const architecture = environment.architecture ?? process.arch;
  const errors: string[] = [];
  if (!satisfiesCapabilityRange(environment.aidenVersion, manifest.compatibility.aiden)) errors.push('Aiden runtime version is incompatible');
  if (!satisfiesCapabilityRange(nodeVersion, manifest.compatibility.node)) errors.push('Node runtime version is incompatible');
  if (!manifest.compatibility.os.includes(platform as 'win32' | 'linux' | 'darwin')) errors.push(`Operating system ${platform} is incompatible`);
  if (!manifest.compatibility.architectures.includes(architecture as 'x64' | 'arm64')) errors.push(`Architecture ${architecture} is incompatible`);
  return { compatible: errors.length === 0, errors, enforcement: 'docker_required' };
}
