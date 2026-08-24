import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../../..');

describe('unified public release boundary', () => {
  it('keeps the public runtime publishable without disabling the complete edition', () => {
    const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      name?: string;
      private?: boolean;
      publishConfig?: { access?: string };
      aiden?: { edition?: string };
    };
    expect(manifest.name).toBe('aiden-runtime');
    expect(manifest.private).not.toBe(true);
    expect(manifest.publishConfig?.access).toBe('public');
    expect(manifest.aiden?.edition).toBe('pro');
  });

  it('does not retain obsolete private-distribution guards', () => {
    expect(existsSync(path.join(root, 'scripts', 'verify-commercial-publish.mjs'))).toBe(false);
    expect(existsSync(path.join(root, 'scripts', 'verify-commercial-remote.mjs'))).toBe(false);
    expect(existsSync(path.join(root, '.githooks', 'pre-push'))).toBe(false);
  });

  it('keeps private development audit material out of the public tree', () => {
    const privateDocs = path.join(root, 'docs', 'private');
    expect(existsSync(privateDocs) ? readdirSync(privateDocs) : []).toEqual([]);
  });
});

