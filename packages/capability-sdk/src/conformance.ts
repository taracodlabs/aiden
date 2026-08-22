/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import type { CapabilityManifest, JsonValue } from './types';
import { validateCapabilityManifest } from './manifest';
import { validateJsonValue } from './schema';

export interface CapabilityConformanceExample {
  tool: string;
  input: JsonValue;
  output: JsonValue;
}
export interface CapabilityConformanceCheck {
  name: string;
  passed: boolean;
  errors: string[];
}

export function runCapabilityConformance(input: {
  manifest: CapabilityManifest;
  examples?: CapabilityConformanceExample[];
}): { passed: boolean; checks: CapabilityConformanceCheck[] } {
  const validation = validateCapabilityManifest(input.manifest);
  const checks: CapabilityConformanceCheck[] = [{ name: 'manifest', passed: validation.ok, errors: validation.errors }];
  for (const example of input.examples ?? []) {
    const tool = input.manifest.tools.find((candidate) => candidate.name === example.tool);
    if (!tool) {
      checks.push({ name: `example input:${example.tool}`, passed: false, errors: ['tool is not declared'] });
      checks.push({ name: `example output:${example.tool}`, passed: false, errors: ['tool is not declared'] });
      continue;
    }
    const inputErrors = validateJsonValue(tool.inputSchema, example.input);
    const outputErrors = validateJsonValue(tool.outputSchema, example.output);
    checks.push({ name: `example input:${example.tool}`, passed: inputErrors.length === 0, errors: inputErrors });
    checks.push({ name: `example output:${example.tool}`, passed: outputErrors.length === 0, errors: outputErrors });
  }
  return { passed: checks.every((check) => check.passed), checks };
}
