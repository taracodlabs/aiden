import { describe, it, expect, afterEach } from 'vitest';
import {
  getMachineFingerprint,
  getMachineDisplayName,
} from '../../../core/v4/license/machineFingerprint';

describe('machineFingerprint', () => {
  afterEach(() => {
    delete process.env.AIDEN_MACHINE_KEY;
  });

  it('1. is deterministic across two calls on the same machine', () => {
    const a = getMachineFingerprint();
    const b = getMachineFingerprint();
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
  });

  it('2. AIDEN_MACHINE_KEY override changes the fingerprint deterministically', () => {
    process.env.AIDEN_MACHINE_KEY = 'machine-A';
    const a = getMachineFingerprint();
    process.env.AIDEN_MACHINE_KEY = 'machine-B';
    const b = getMachineFingerprint();
    process.env.AIDEN_MACHINE_KEY = 'machine-A';
    const a2 = getMachineFingerprint();
    expect(a).not.toBe(b);
    expect(a).toBe(a2);
    expect(getMachineDisplayName()).toBeTypeOf('string');
  });
});
