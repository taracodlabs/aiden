import { describe, it, expect, vi } from 'vitest';

import {
  RuntimeResolver,
  deprecationNotice,
} from '../../../providers/v4/runtimeResolver';
import { CredentialResolver } from '../../../providers/v4/credentialResolver';

/**
 * DeepSeek retires `deepseek-chat` / `deepseek-reasoner` on 2026-07-24 in
 * favour of `deepseek-v4-pro`. The resolver surfaces a one-line heads-up when
 * a session resolves either dying alias.
 */
describe('model deprecation — DeepSeek legacy aliases (EOL 2026-07-24)', () => {
  describe('deprecationNotice() — pure lookup', () => {
    it('names the date + replacement for deepseek-chat', () => {
      const msg = deprecationNotice('deepseek', 'deepseek-chat');
      expect(msg).toBeTruthy();
      expect(msg).toContain('2026-07-24');
      expect(msg).toContain('deepseek-v4-pro');
    });

    it('names the date + replacement for deepseek-reasoner', () => {
      const msg = deprecationNotice('deepseek', 'deepseek-reasoner');
      expect(msg).toContain('2026-07-24');
      expect(msg).toContain('deepseek-v4-pro');
    });

    it('returns null for the replacement model itself', () => {
      expect(deprecationNotice('deepseek', 'deepseek-v4-pro')).toBeNull();
    });

    it('returns null for an unrelated model (no false positives)', () => {
      expect(deprecationNotice('chatgpt-plus', 'gpt-5.6-sol')).toBeNull();
    });
  });

  describe('resolve() — emits the warning at resolve time', () => {
    const mkResolver = () => new RuntimeResolver(new CredentialResolver());

    it('warns once when a session resolves deepseek-chat', async () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      // apiKeyOverride short-circuits credential resolution → adapter builds
      // offline (no network), so the resolve-time warning is observable.
      await mkResolver().resolve({
        providerId: 'deepseek',
        modelId: 'deepseek-chat',
        apiKeyOverride: 'test-key',
      });
      const emitted = spy.mock.calls.map((c) => c.join(' ')).join('\n');
      spy.mockRestore();
      expect(emitted).toContain('2026-07-24');
      expect(emitted).toContain('deepseek-v4-pro');
    });

    it('does NOT warn when resolving the replacement (deepseek-v4-pro)', async () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await mkResolver().resolve({
        providerId: 'deepseek',
        modelId: 'deepseek-v4-pro',
        apiKeyOverride: 'test-key',
      });
      const emitted = spy.mock.calls.map((c) => c.join(' ')).join('\n');
      spy.mockRestore();
      expect(emitted).not.toContain('deprecated');
    });
  });
});
