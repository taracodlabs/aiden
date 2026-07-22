import { describe, expect, it } from 'vitest';
import {
  chooseAutomaticModel,
  isAutomaticModelCandidate,
  providerAuxiliaryDefault,
  providerMainDefault,
  resolveModelSelection,
} from '../../../providers/v4/providerModelAuthority';

describe('provider model authority', () => {
  it('accepts a live-confirmed model missing from curated metadata', () => {
    const resolved = resolveModelSelection({
      providerId: 'groq',
      modelId: 'provider/new-model',
      liveModelIds: ['provider/new-model'],
    });
    expect(resolved?.model.id).toBe('provider/new-model');
    expect(resolved?.verification).toBe('live');
    expect(resolved?.metadataSource).toBe('synthetic');
  });

  it('does not let a stale curated entry override live discovery', () => {
    expect(resolveModelSelection({
      providerId: 'groq',
      modelId: 'mixtral-8x7b-32768',
      liveModelIds: ['openai/gpt-oss-120b'],
    })).toBeNull();
  });

  it('retains an explicitly saved raw model as unverified', () => {
    const resolved = resolveModelSelection({
      providerId: 'groq',
      modelId: 'private/gated-model',
      allowUnverified: true,
    });
    expect(resolved?.verification).toBe('unverified');
  });

  it('centralizes the main and auxiliary defaults', () => {
    expect(providerMainDefault('groq')).toBe('openai/gpt-oss-120b');
    expect(providerAuxiliaryDefault('groq')).toBe('openai/gpt-oss-20b');
    expect(providerMainDefault('together')).toBe('openai/gpt-oss-120b');
    expect(providerMainDefault('deepseek')).toBe('deepseek-v4-pro');
    expect(providerMainDefault('huggingface')).toBe('openai/gpt-oss-120b');
  });

  it('never automatically selects retired or imminently retiring models', () => {
    const now = Date.parse('2026-07-18T00:00:00Z');
    expect(isAutomaticModelCandidate('groq', 'mixtral-8x7b-32768', now)).toBe(false);
    expect(isAutomaticModelCandidate('groq', 'llama-3.3-70b-versatile', now)).toBe(false);
    expect(chooseAutomaticModel('groq', [
      'llama-3.3-70b-versatile',
      'openai/gpt-oss-120b',
    ], now)).toBe('openai/gpt-oss-120b');
    expect(isAutomaticModelCandidate('deepseek', 'deepseek-chat', now)).toBe(false);
    expect(chooseAutomaticModel('deepseek', [
      'deepseek-chat',
      'deepseek-v4-flash',
      'deepseek-v4-pro',
    ], now)).toBe('deepseek-v4-pro');
  });
});
