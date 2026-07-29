/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

export interface RawValidationOutput {
  stdout: string;
  stderr: string;
}

const rawValidationOutput = Symbol('aiden.rawValidationOutput');

export function attachRawValidationOutput<T extends object>(value: T, output: RawValidationOutput): T {
  Object.defineProperty(value, rawValidationOutput, {
    value: output,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return value;
}

export function getRawValidationOutput(value: unknown): RawValidationOutput | undefined {
  if (!value || typeof value !== 'object') return undefined;
  return (value as Record<symbol, unknown>)[rawValidationOutput] as RawValidationOutput | undefined;
}
