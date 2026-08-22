/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import type { JsonSchema, JsonValue } from './types';

const SCHEMA_FIELDS = new Set([
  'type', 'description', 'properties', 'required', 'additionalProperties', 'items',
  'enum', 'const', 'minLength', 'maxLength', 'minItems', 'maxItems', 'minimum', 'maximum',
]);
const MAX_SCHEMA_DEPTH = 16;
const MAX_SCHEMA_NODES = 512;
const MAX_SCHEMA_PROPERTIES = 128;
const MAX_SCHEMA_LIST_ITEMS = 128;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateJsonSchemaNode(
  schema: unknown,
  location: string,
  depth: number,
  state: { nodes: number },
): string[] {
  if (!record(schema)) return [`${location} must be a JSON schema object`];
  if (depth > MAX_SCHEMA_DEPTH) return [`${location} exceeds maximum schema depth ${MAX_SCHEMA_DEPTH}`];
  state.nodes += 1;
  if (state.nodes > MAX_SCHEMA_NODES) return [`${location} exceeds maximum schema complexity ${MAX_SCHEMA_NODES}`];
  const errors: string[] = [];
  for (const field of Object.keys(schema)) {
    if (!SCHEMA_FIELDS.has(field)) errors.push(`${location} contains unknown schema field "${field}"`);
  }
  const supported = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'];
  if (schema.type !== undefined && !supported.includes(String(schema.type))) {
    errors.push(`${location}.type is unsupported`);
  }
  if (schema.description !== undefined && typeof schema.description !== 'string') {
    errors.push(`${location}.description must be a string`);
  }
  if (schema.properties !== undefined) {
    if (!record(schema.properties)) errors.push(`${location}.properties must be an object`);
    else {
      const entries = Object.entries(schema.properties);
      if (entries.length > MAX_SCHEMA_PROPERTIES) errors.push(`${location}.properties exceeds ${MAX_SCHEMA_PROPERTIES} entries`);
      for (const [key, child] of entries.slice(0, MAX_SCHEMA_PROPERTIES)) {
        if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/u.test(key)) errors.push(`${location}.properties contains an invalid key`);
        errors.push(...validateJsonSchemaNode(child, `${location}.properties.${key}`, depth + 1, state));
      }
    }
  }
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required) || schema.required.length > MAX_SCHEMA_LIST_ITEMS
        || schema.required.some((item) => typeof item !== 'string' || item.length < 1 || item.length > 128)) {
      errors.push(`${location}.required must be a bounded string array`);
    } else if (new Set(schema.required).size !== schema.required.length) {
      errors.push(`${location}.required contains duplicate fields`);
    }
  }
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') {
    errors.push(`${location}.additionalProperties must be boolean`);
  }
  if (schema.items !== undefined) errors.push(...validateJsonSchemaNode(schema.items, `${location}.items`, depth + 1, state));
  if (schema.enum !== undefined && (!Array.isArray(schema.enum)
      || schema.enum.length === 0 || schema.enum.length > MAX_SCHEMA_LIST_ITEMS)) {
    errors.push(`${location}.enum must be a bounded non-empty array`);
  }
  for (const field of ['minLength', 'maxLength', 'minItems', 'maxItems'] as const) {
    const value = schema[field];
    if (value !== undefined && (!Number.isSafeInteger(value) || Number(value) < 0)) {
      errors.push(`${location}.${field} must be a non-negative integer`);
    }
  }
  for (const field of ['minimum', 'maximum'] as const) {
    const value = schema[field];
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
      errors.push(`${location}.${field} must be a finite number`);
    }
  }
  return errors;
}

export function validateJsonSchema(schema: unknown, location = '$'): string[] {
  return validateJsonSchemaNode(schema, location, 0, { nodes: 0 });
}

export function validateJsonValue(schema: JsonSchema, value: unknown, location = '$'): string[] {
  const errors: string[] = [];
  if (schema.enum && !schema.enum.some((candidate) => jsonEqual(candidate, value))) {
    errors.push(`${location} must match one of the declared enum values`);
  }
  if ('const' in schema && !jsonEqual(schema.const, value)) errors.push(`${location} must match the declared constant`);
  switch (schema.type) {
    case 'null': if (value !== null) errors.push(`${location} must be null`); break;
    case 'boolean': if (typeof value !== 'boolean') errors.push(`${location} must be boolean`); break;
    case 'string': {
      if (typeof value !== 'string') errors.push(`${location} must be string`);
      else {
        if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${location} is shorter than minLength`);
        if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${location} exceeds maxLength`);
      }
      break;
    }
    case 'number':
    case 'integer': {
      if (typeof value !== 'number' || !Number.isFinite(value) || (schema.type === 'integer' && !Number.isInteger(value))) {
        errors.push(`${location} must be ${schema.type}`);
      } else {
        if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${location} is below minimum`);
        if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${location} exceeds maximum`);
      }
      break;
    }
    case 'array': {
      if (!Array.isArray(value)) errors.push(`${location} must be array`);
      else {
        if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${location} has fewer than minItems`);
        if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${location} exceeds maxItems`);
        if (schema.items) value.forEach((item, index) => errors.push(...validateJsonValue(schema.items!, item, `${location}[${index}]`)));
      }
      break;
    }
    case 'object': {
      if (!record(value)) errors.push(`${location} must be object`);
      else {
        for (const field of schema.required ?? []) {
          if (!(field in value)) errors.push(`${location}.${field} is required`);
        }
        const properties = schema.properties ?? {};
        if (schema.additionalProperties === false) {
          for (const field of Object.keys(value)) {
            if (!(field in properties)) errors.push(`${location}.${field} is an additional property`);
          }
        }
        for (const [field, child] of Object.entries(properties)) {
          if (field in value) errors.push(...validateJsonValue(child, value[field], `${location}.${field}`));
        }
      }
      break;
    }
    default:
      break;
  }
  return errors;
}

export function asJsonValue(value: unknown): JsonValue {
  const errors = validateJsonSerializable(value);
  if (errors.length > 0) throw new Error(errors[0]);
  return value as JsonValue;
}

function validateJsonSerializable(value: unknown, location = '$'): string[] {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return [];
  if (typeof value === 'number') return Number.isFinite(value) ? [] : [`${location} is not finite`];
  if (Array.isArray(value)) return value.flatMap((item, index) => validateJsonSerializable(item, `${location}[${index}]`));
  if (record(value)) return Object.entries(value).flatMap(([key, item]) => validateJsonSerializable(item, `${location}.${key}`));
  return [`${location} is not JSON serializable`];
}
