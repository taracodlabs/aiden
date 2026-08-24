import { afterEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ALWAYS_AVAILABLE_CAPABILITIES,
  detectProductEdition,
  EditionAuthority,
} from '../../../core/v4/commercial/edition';
import {
  EntitlementAuthority,
  type EntitlementClaim,
  type SignedEntitlement,
} from '../../../core/v4/commercial/entitlementAuthority';
import { canonicalJson } from '../../../core/v4/commercial/signedPayload';
import { verifyUpdateMetadata, type UpdateMetadata } from '../../../core/v4/commercial/updateChannel';
import { LocalProductMetrics } from '../../../core/v4/commercial/localProductMetrics';
import { classifyPlatform } from '../../../core/v4/commercial/platformSupport';
import { buildOnboardingPlan } from '../../../core/v4/commercial/onboardingPlan';
import type { SystemReadinessProjection } from '../../../core/v4/workbench/systemReadiness';

const roots: string[] = [];

async function makePaths() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-commercial-'));
  roots.push(root);
  return { root } as any;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const keys = generateKeyPairSync('ed25519');
const publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();

function signedClaim(overrides: Partial<EntitlementClaim> = {}): SignedEntitlement {
  const claim: EntitlementClaim = {
    product: 'aiden',
    accountId: 'account_1',
    edition: 'pro',
    capabilities: ['workflow.premium'],
    issuedAt: '2026-08-01T00:00:00.000Z',
    expiresAt: '2026-09-01T00:00:00.000Z',
    offlineUntil: '2026-09-08T00:00:00.000Z',
    ...overrides,
  };
  return {
    claim,
    signature: sign(null, Buffer.from(canonicalJson(claim)), keys.privateKey).toString('base64'),
  };
}

describe('commercial edition authority', () => {
  it('derives the installed edition from explicit package metadata', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-edition-'));
    roots.push(root);
    const nested = path.join(root, 'dist', 'core', 'v4');
    await fs.mkdir(nested, { recursive: true });
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
      name: 'aiden-runtime',
      private: false,
      aiden: { edition: 'pro' },
    }));
    expect(detectProductEdition(nested)).toBe('pro');
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
      name: 'aiden-runtime',
      private: true,
      aiden: { edition: 'community' },
    }));
    expect(detectProductEdition(nested)).toBe('community');
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
      name: 'aiden-runtime',
      aiden: { edition: 'unknown' },
    }));
    expect(detectProductEdition(nested)).toBe('community');
  });

  it('keeps every safety capability available in Community', () => {
    const authority = new EditionAuthority({ edition: 'community', grants: [] });
    for (const capability of ALWAYS_AVAILABLE_CAPABILITIES) expect(authority.can(capability)).toBe(true);
  });

  it('grants explicit Pro capabilities and fails closed for unknown capabilities', () => {
    const authority = new EditionAuthority({ edition: 'pro', grants: ['workflow.premium'] });
    expect(authority.can('workflow.premium')).toBe(true);
    expect(authority.can('relay.remote')).toBe(false);
    expect(authority.can('unknown.capability')).toBe(false);
  });

  it('gates external protocol product surfaces without treating entitlement as permission', () => {
    const community = new EditionAuthority({ edition: 'community', grants: [] });
    const pro = new EditionAuthority({
      edition: 'pro',
      grants: ['mcp.external', 'a2a.preview'],
    });

    expect(community.can('mcp.external')).toBe(false);
    expect(community.can('a2a.preview')).toBe(false);
    expect(pro.can('mcp.external')).toBe(true);
    expect(pro.can('a2a.preview')).toBe(true);
    expect(pro.can('safety.approvals')).toBe(true);
    expect(pro.can('external.mutation')).toBe(false);
  });
});

describe('signed entitlement authority', () => {
  it('returns Community when no entitlement exists', async () => {
    const authority = new EntitlementAuthority({ paths: await makePaths(), publicKeyPem });
    expect(await authority.snapshot()).toEqual({ state: 'community', edition: 'community', capabilities: [] });
  });

  it('accepts a valid active Pro entitlement', async () => {
    const paths = await makePaths();
    const authority = new EntitlementAuthority({
      paths, publicKeyPem, now: () => new Date('2026-08-15T00:00:00Z'),
      refreshProvider: { refresh: async () => signedClaim() },
    });
    const result = await authority.refresh();
    expect(result.state).toBe('active');
    expect(result.edition).toBe('pro');
    expect(authority.editionAuthority(result).can('workflow.premium')).toBe(true);
  });

  it('distinguishes a signed trial from an active subscription', async () => {
    const authority = new EntitlementAuthority({ paths: await makePaths(), publicKeyPem, now: () => new Date('2026-08-15T00:00:00Z') });
    expect(authority.evaluate(signedClaim({ trial: true })).state).toBe('trial');
  });

  it('classifies expired and offline-grace claims truthfully', async () => {
    const paths = await makePaths();
    const grace = new EntitlementAuthority({ paths, publicKeyPem, now: () => new Date('2026-09-04T00:00:00Z') });
    expect(grace.evaluate(signedClaim()).state).toBe('grace');
    const expired = new EntitlementAuthority({ paths, publicKeyPem, now: () => new Date('2026-09-09T00:00:00Z') });
    const snapshot = expired.evaluate(signedClaim());
    expect(snapshot.state).toBe('expired');
    expect(snapshot.capabilities).toEqual([]);
  });

  it('rejects bad signatures, wrong products, revoked claims, and wrong device bindings', async () => {
    const paths = await makePaths();
    const authority = new EntitlementAuthority({ paths, publicKeyPem, deviceBinding: 'device-A' });
    expect(authority.evaluate({ ...signedClaim(), signature: 'bad' }).reason).toBe('invalid entitlement signature');
    expect(authority.evaluate(signedClaim({ product: 'aiden' as any, accountId: 'x' })).state).toBe('active');
    const wrongProduct = signedClaim();
    (wrongProduct.claim as any).product = 'other';
    wrongProduct.signature = sign(null, Buffer.from(canonicalJson(wrongProduct.claim)), keys.privateKey).toString('base64');
    expect(authority.evaluate(wrongProduct).reason).toBe('wrong entitlement product');
    expect(authority.evaluate(signedClaim({ revoked: true })).state).toBe('revoked');
    expect(authority.evaluate(signedClaim({ deviceBinding: 'device-B' })).reason).toBe('wrong device binding');
  });

  it('returns unavailable when no refresh service exists without exposing a signing secret', async () => {
    const authority = new EntitlementAuthority({ paths: await makePaths(), publicKeyPem });
    expect((await authority.refresh()).state).toBe('unavailable');
    expect(JSON.stringify(await authority.snapshot())).not.toContain('PRIVATE KEY');
  });
});

describe('signed update channels', () => {
  const metadata: UpdateMetadata = {
    version: '4.22.0', edition: 'pro', channel: 'pro-preview',
    artifact: 'https://updates.taracod.com/aiden-pro/4.22.0/windows-x64.exe',
    sha256: 'a'.repeat(64), minimumRuntime: '20.0.0',
    releaseNotesUrl: 'https://updates.taracod.com/aiden-pro/4.22.0/notes',
  };
  const signed = () => ({ metadata, signature: sign(null, Buffer.from(canonicalJson(metadata)), keys.privateKey).toString('base64') });

  it('accepts valid signed metadata for the selected channel', () => {
    expect(verifyUpdateMetadata({ signed: signed(), expectedChannel: 'pro-preview', publicKeyPem }).ok).toBe(true);
  });

  it('rejects invalid signatures and wrong channels', () => {
    expect(verifyUpdateMetadata({ signed: { ...signed(), signature: 'bad' }, expectedChannel: 'pro-preview', publicKeyPem })).toEqual({ ok: false, reason: 'invalid update signature' });
    expect(verifyUpdateMetadata({ signed: signed(), expectedChannel: 'pro-stable', publicKeyPem })).toEqual({ ok: false, reason: 'wrong update channel' });
  });
});

describe('local product metrics and support matrix', () => {
  it('stores only named local milestones and preserves first occurrence', async () => {
    const paths = await makePaths();
    let now = new Date('2026-08-01T00:00:00Z');
    const metrics = new LocalProductMetrics(paths, () => now);
    await metrics.mark('first_launch');
    now = new Date('2026-08-02T00:00:00Z');
    const snapshot = await metrics.mark('first_launch');
    expect(snapshot).toEqual({ version: 1, milestones: { first_launch: '2026-08-01T00:00:00.000Z' } });
    expect(JSON.stringify(snapshot)).not.toMatch(/prompt|source|token|filename/i);
  });

  it('classifies Windows/Node 22 as supported, Unix as partially validated, and Node 24 as unsupported', () => {
    expect(classifyPlatform({ platform: 'win32', release: '10.0.26100', nodeVersion: '22.23.1' }).level).toBe('supported');
    expect(classifyPlatform({ platform: 'win32', release: '10.0.19045', nodeVersion: '22.23.1' }).level).toBe('unsupported');
    expect(classifyPlatform({ platform: 'linux', release: '6.8', nodeVersion: '20.20.2' }).level).toBe('partially_validated');
    expect(classifyPlatform({ platform: 'win32', release: '10.0.26100', nodeVersion: '24.0.0' }).level).toBe('unsupported');
  });
});

describe('readiness-backed onboarding plan', () => {
  it('projects the existing readiness authority without forcing optional capabilities', () => {
    const item = (id: string, healthy: boolean, blocking: boolean, detail: string) => ({
      id, category: 'chat' as const, state: healthy ? 'ready' as const : 'needs_setup' as const,
      title: id, detail, configured: healthy, available: healthy, healthy, blocking,
      severity: healthy ? 'info' as const : 'warning' as const, availableActions: [], checkedAt: 1,
    });
    const items = [
      item('workspace', true, true, 'ready'), item('chat-provider', true, true, 'ready'),
      item('browser', false, false, 'permission required'), item('coding-provider', false, false, 'not configured'),
      item('apps', false, false, 'not connected'),
    ];
    const projection: SystemReadinessProjection = { overall: 'ready', items, issues: [], checkedAt: 1 };
    const plan = buildOnboardingPlan(projection);
    expect(plan.find((entry) => entry.id === 'browser')).toMatchObject({ state: 'optional', skippable: true });
    expect(plan.at(-1)?.state).toBe('ready');
  });
});
