/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import {
  CAPABILITY_MANIFEST_VERSION,
  CAPABILITY_PROTOCOL_VERSION,
  type CapabilityIdentity,
  type CapabilityManifest,
  type CapabilityPermissionKind,
} from './types';
import { validateJsonSchema } from './schema';

const MANIFEST_FIELDS = new Set([
  'manifestVersion', 'id', 'version', 'displayName', 'description', 'runtime', 'entrypoint',
  'tools', 'permissions', 'effects', 'secretSlots', 'compatibility', 'limits', 'digest',
]);
const RUNTIME_FIELDS = new Set(['kind', 'protocolVersion']);
const TOOL_FIELDS = new Set(['name', 'description', 'mutates', 'inputSchema', 'outputSchema']);
const PERMISSION_FIELDS = new Set(['kind', 'scope']);
const SCOPE_FIELDS = new Set(['paths', 'hosts', 'secretSlots', 'applications']);
const EFFECT_FIELDS = new Set(['tool', 'kind', 'approval', 'reversible']);
const SECRET_FIELDS = new Set(['id', 'description', 'provider', 'required']);
const COMPATIBILITY_FIELDS = new Set(['aiden', 'node', 'os', 'architectures']);
const LIMIT_FIELDS = new Set(['runtimeMs', 'maxMessageBytes', 'maxTotalOutputBytes', 'maxBrokerRequests', 'maxEvidenceClaims']);
const PERMISSION_KINDS: CapabilityPermissionKind[] = [
  'filesystem.read', 'filesystem.write', 'network.egress', 'secret.use',
  'process.spawn', 'artifact.create', 'app.action',
];

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function unknownFields(value: Record<string, unknown>, allowed: ReadonlySet<string>, location: string): string[] {
  return Object.keys(value).filter((field) => !allowed.has(field)).map((field) => `${location} contains unknown field "${field}"`);
}

function stringArray(value: unknown, location: string, maxItems = 64): string[] {
  if (!Array.isArray(value) || value.length > maxItems || value.some((item) => typeof item !== 'string' || item.length === 0 || item.length > 512)) {
    return [`${location} must be a bounded non-empty string array`];
  }
  return [];
}

function boundedInt(value: unknown, min: number, max: number, location: string): string[] {
  return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max
    ? [] : [`${location} must be an integer between ${min} and ${max}`];
}

export interface CapabilityManifestValidation {
  ok: boolean;
  errors: string[];
  manifest?: CapabilityManifest;
}

export function validateCapabilityManifest(value: unknown): CapabilityManifestValidation {
  if (!record(value)) return { ok: false, errors: ['manifest must be an object'] };
  const errors = unknownFields(value, MANIFEST_FIELDS, 'manifest');
  if (value.manifestVersion !== CAPABILITY_MANIFEST_VERSION) errors.push(`manifestVersion must be ${CAPABILITY_MANIFEST_VERSION}`);
  if (typeof value.id !== 'string' || !/^[a-z0-9](?:[a-z0-9.-]{1,126}[a-z0-9])?$/u.test(value.id) || !value.id.includes('.')) {
    errors.push('capability id must be a reverse-domain lowercase identifier');
  }
  if (typeof value.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(value.version)) errors.push('version must be semantic version text');
  if (typeof value.displayName !== 'string' || value.displayName.trim().length < 1 || value.displayName.length > 120) errors.push('displayName must be 1-120 characters');
  if (value.description !== undefined && (typeof value.description !== 'string' || value.description.length > 1_000)) errors.push('description must be at most 1000 characters');

  if (!record(value.runtime)) errors.push('runtime must be an object');
  else {
    errors.push(...unknownFields(value.runtime, RUNTIME_FIELDS, 'runtime'));
    if (value.runtime.kind !== 'node') errors.push('runtime kind must be node');
    if (value.runtime.protocolVersion !== CAPABILITY_PROTOCOL_VERSION) errors.push(`runtime protocolVersion must be ${CAPABILITY_PROTOCOL_VERSION}`);
  }
  if (typeof value.entrypoint !== 'string' || value.entrypoint.length < 1 || value.entrypoint.length > 260
      || value.entrypoint.includes('\\') || value.entrypoint.startsWith('/') || /^[A-Za-z]:/u.test(value.entrypoint)
      || value.entrypoint.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    errors.push('entrypoint must be a normalized package-relative path without traversal');
  }
  if (typeof value.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value.digest)) errors.push('digest must be lowercase sha256 identity');

  const toolNames = new Set<string>();
  if (!Array.isArray(value.tools) || value.tools.length < 1 || value.tools.length > 32) errors.push('tools must contain 1-32 declarations');
  else value.tools.forEach((raw, index) => {
    const location = `tools[${index}]`;
    if (!record(raw)) { errors.push(`${location} must be an object`); return; }
    errors.push(...unknownFields(raw, TOOL_FIELDS, location));
    if (typeof raw.name !== 'string' || !/^[a-z][a-z0-9_]{1,63}$/u.test(raw.name)) errors.push(`${location}.name is invalid`);
    else if (toolNames.has(raw.name)) errors.push(`${location}.name is duplicated`);
    else toolNames.add(raw.name);
    if (typeof raw.description !== 'string' || raw.description.length < 1 || raw.description.length > 500) errors.push(`${location}.description is invalid`);
    if (typeof raw.mutates !== 'boolean') errors.push(`${location}.mutates must be boolean`);
    errors.push(...validateJsonSchema(raw.inputSchema, `${location}.inputSchema`));
    errors.push(...validateJsonSchema(raw.outputSchema, `${location}.outputSchema`));
    if (!record(raw.inputSchema) || raw.inputSchema.type !== 'object') {
      errors.push(`${location}.inputSchema must declare an object at the tool boundary`);
    }
  });

  const permissionKeys = new Set<string>();
  if (!Array.isArray(value.permissions) || value.permissions.length > 32) errors.push('permissions must be an array with at most 32 entries');
  else value.permissions.forEach((raw, index) => {
    const location = `permissions[${index}]`;
    if (!record(raw)) { errors.push(`${location} must be an object`); return; }
    errors.push(...unknownFields(raw, PERMISSION_FIELDS, location));
    if (!PERMISSION_KINDS.includes(raw.kind as CapabilityPermissionKind)) errors.push(`${location}.kind is unsupported`);
    if (!record(raw.scope)) errors.push(`${location}.scope must be an object`);
    else {
      errors.push(...unknownFields(raw.scope, SCOPE_FIELDS, `${location}.scope`));
      for (const field of ['paths', 'hosts', 'secretSlots', 'applications']) {
        if (raw.scope[field] !== undefined) errors.push(...stringArray(raw.scope[field], `${location}.scope.${field}`));
      }
      const key = JSON.stringify([raw.kind, raw.scope]);
      if (permissionKeys.has(key)) errors.push(`${location} is duplicated`);
      permissionKeys.add(key);
    }
  });

  if (!Array.isArray(value.effects) || value.effects.length > 32) errors.push('effects must be an array with at most 32 entries');
  else value.effects.forEach((raw, index) => {
    const location = `effects[${index}]`;
    if (!record(raw)) { errors.push(`${location} must be an object`); return; }
    errors.push(...unknownFields(raw, EFFECT_FIELDS, location));
    if (typeof raw.tool !== 'string' || !toolNames.has(raw.tool)) errors.push(`${location}.tool must reference a declared tool`);
    if (typeof raw.kind !== 'string' || raw.kind.length < 1 || raw.kind.length > 128) errors.push(`${location}.kind is invalid`);
    if (!['policy', 'required'].includes(String(raw.approval))) errors.push(`${location}.approval is invalid`);
    if (typeof raw.reversible !== 'boolean') errors.push(`${location}.reversible must be boolean`);
  });

  const secretIds = new Set<string>();
  if (!Array.isArray(value.secretSlots) || value.secretSlots.length > 16) errors.push('secretSlots must be an array with at most 16 entries');
  else value.secretSlots.forEach((raw, index) => {
    const location = `secretSlots[${index}]`;
    if (!record(raw)) { errors.push(`${location} must be an object`); return; }
    errors.push(...unknownFields(raw, SECRET_FIELDS, location));
    if (typeof raw.id !== 'string' || !/^[a-z][a-z0-9_.-]{1,63}$/u.test(raw.id)) errors.push(`${location}.id is invalid`);
    else if (secretIds.has(raw.id)) errors.push(`${location}.id is duplicated`);
    else secretIds.add(raw.id);
    if (raw.description !== undefined && (typeof raw.description !== 'string' || raw.description.length > 500)) errors.push(`${location}.description is invalid`);
    if (raw.provider !== undefined && (typeof raw.provider !== 'string' || raw.provider.length > 128)) errors.push(`${location}.provider is invalid`);
    if (typeof raw.required !== 'boolean') errors.push(`${location}.required must be boolean`);
  });

  if (!record(value.compatibility)) errors.push('compatibility must be an object');
  else {
    errors.push(...unknownFields(value.compatibility, COMPATIBILITY_FIELDS, 'compatibility'));
    if (typeof value.compatibility.aiden !== 'string' || value.compatibility.aiden.length > 128) errors.push('compatibility.aiden is invalid');
    if (typeof value.compatibility.node !== 'string' || value.compatibility.node.length > 128) errors.push('compatibility.node is invalid');
    errors.push(...stringArray(value.compatibility.os, 'compatibility.os', 3));
    errors.push(...stringArray(value.compatibility.architectures, 'compatibility.architectures', 2));
    if (Array.isArray(value.compatibility.os) && value.compatibility.os.some((item) => !['win32', 'linux', 'darwin'].includes(String(item)))) errors.push('compatibility.os contains an unsupported platform');
    if (Array.isArray(value.compatibility.architectures) && value.compatibility.architectures.some((item) => !['x64', 'arm64'].includes(String(item)))) errors.push('compatibility.architectures contains an unsupported architecture');
  }

  if (!record(value.limits)) errors.push('limits must be an object');
  else {
    errors.push(...unknownFields(value.limits, LIMIT_FIELDS, 'limits'));
    errors.push(...boundedInt(value.limits.runtimeMs, 100, 30_000, 'limits.runtimeMs'));
    errors.push(...boundedInt(value.limits.maxMessageBytes, 1_024, 262_144, 'limits.maxMessageBytes'));
    errors.push(...boundedInt(value.limits.maxTotalOutputBytes, 4_096, 1_048_576, 'limits.maxTotalOutputBytes'));
    errors.push(...boundedInt(value.limits.maxBrokerRequests, 0, 256, 'limits.maxBrokerRequests'));
    errors.push(...boundedInt(value.limits.maxEvidenceClaims, 0, 128, 'limits.maxEvidenceClaims'));
  }

  return errors.length === 0
    ? { ok: true, errors: [], manifest: value as unknown as CapabilityManifest }
    : { ok: false, errors };
}

export function capabilityIdentity(manifest: CapabilityManifest): CapabilityIdentity {
  return {
    capabilityId: manifest.id,
    version: manifest.version,
    manifestVersion: manifest.manifestVersion,
    protocolVersion: manifest.runtime.protocolVersion,
    digest: manifest.digest,
  };
}
