/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import path from 'node:path';
import type { ScriptSpec, ScriptStep } from './types';

const MAX_CONTENT_BYTES = 256 * 1024;

export function validateScriptSpec(spec: ScriptSpec): void {
  if (spec.version !== 1) throw new Error('Unsupported ScriptSpec version');
  if (spec.steps.length < 1 || spec.steps.length > 100) throw new Error('ScriptSpec requires 1 to 100 steps');
  if (!Number.isInteger(spec.maxRuntimeMs) || spec.maxRuntimeMs < 1 || spec.maxRuntimeMs > 3_600_000) {
    throw new Error('ScriptSpec maxRuntimeMs must be between 1 and 3600000');
  }
  for (const step of spec.steps) validateStep(step);
}

function validateStep(step: ScriptStep): void {
  if ('path' in step) {
    const normalized = step.path.replace(/\\/g, '/');
    if (!normalized || normalized.includes('\0') || path.posix.isAbsolute(normalized)
      || normalized.split('/').includes('..')) {
      throw new Error('ScriptSpec paths must be bounded workspace-relative paths');
    }
  }
  if (step.kind === 'read_file' && (step.maxBytes ?? MAX_CONTENT_BYTES) > MAX_CONTENT_BYTES) {
    throw new Error(`ScriptSpec read_file maxBytes cannot exceed ${MAX_CONTENT_BYTES}`);
  }
  if (step.kind === 'list_directory' && (step.maxEntries ?? 1_000) > 1_000) {
    throw new Error('ScriptSpec list_directory maxEntries cannot exceed 1000');
  }
  if (step.kind === 'write_file' && Buffer.byteLength(step.content, 'utf8') > MAX_CONTENT_BYTES) {
    throw new Error(`ScriptSpec write_file content cannot exceed ${MAX_CONTENT_BYTES} bytes`);
  }
  if (step.kind === 'http_request') {
    const url = new URL(step.url);
    if (url.protocol !== 'https:') throw new Error('ScriptSpec network requests require HTTPS');
  }
}

export function projectScriptSpec(spec: ScriptSpec): string {
  validateScriptSpec(spec);
  const lines = spec.steps.map((step, index) => {
    if (step.kind === 'read_file') return `${index + 1}. Read file ${step.path} (max ${step.maxBytes ?? MAX_CONTENT_BYTES} bytes).`;
    if (step.kind === 'write_file') return `${index + 1}. Write ${Buffer.byteLength(step.content, 'utf8')} bytes to ${step.path} through normal approval and Effect authority.`;
    if (step.kind === 'list_directory') return `${index + 1}. List directory ${step.path} (max ${step.maxEntries ?? 1_000} entries).`;
    return `${index + 1}. Perform ${step.method} request to ${step.url} through normal network and Effect authority.`;
  });
  return [
    `Execute typed ScriptSpec v${spec.version}. Maximum runtime ${spec.maxRuntimeMs}ms.`,
    'Use only the exact typed operations below. Normal capability, approval, Effect, Evidence and Verification authority remains mandatory.',
    ...lines,
  ].join('\n');
}
