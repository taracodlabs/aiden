/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import type { ConnectedAccountAuthority } from './connectedAccountAuthority';
import { currentJobExecutionContext } from '../daemon/jobExecutionContext';
import type {
  ActionDiscoveryPage,
  ConnectedAccountRecord,
  IntegrationActionDescriptor,
  IntegrationProvider,
} from './types';

function terms(value: string): Set<string> {
  return new Set(value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(/\s+/).filter((term) => term.length > 1));
}

function relevance(action: IntegrationActionDescriptor, intent: Set<string>): number {
  const identity = terms(`${action.actionId} ${action.label}`);
  const description = terms(action.description);
  let score = 0;
  for (const term of intent) {
    if (identity.has(term)) score += 4;
    if (description.has(term)) score += 1;
  }
  return score;
}

export interface IntegrationResolution {
  providerId: string;
  toolkitId: string;
  account: ConnectedAccountRecord;
  actions: IntegrationActionDescriptor[];
  discovery: { total: number; candidates: number; exposed: number };
}

/** Resolves immutable execution candidates. It has no execution or approval capability. */
export class IntegrationResolver {
  private readonly accounts: ConnectedAccountAuthority;
  private readonly provider: (providerId: string) => IntegrationProvider;
  private readonly discover?: (input: {
    providerId: string; toolkitId: string; ownerId: string; workspaceId: string;
    limit: number; providerCredential?: string;
  }) => Promise<ActionDiscoveryPage>;

  constructor(options: {
    accounts: ConnectedAccountAuthority;
    provider: (providerId: string) => IntegrationProvider;
    discover?: (input: {
      providerId: string; toolkitId: string; ownerId: string; workspaceId: string;
      limit: number; providerCredential?: string;
    }) => Promise<ActionDiscoveryPage>;
  }) {
    this.accounts = options.accounts;
    this.provider = options.provider;
    this.discover = options.discover;
  }

  async resolve(input: {
    providerId: string;
    toolkitId: string;
    ownerId: string;
    workspaceId: string;
    accountId?: string;
    intent: string;
    actionIds?: string[];
    maxActions?: number;
    providerCredential?: string;
  }): Promise<IntegrationResolution> {
    const account = this.accounts.resolve(input);
    const maxActions = Math.max(1, Math.min(12, input.maxActions ?? 6));
    const page = this.discover
      ? await this.discover({
          providerId: input.providerId, toolkitId: input.toolkitId,
          ownerId: input.ownerId, workspaceId: input.workspaceId,
          limit: 100, providerCredential: input.providerCredential,
        })
      : await this.provider(input.providerId).discoverActions({
          toolkitId: input.toolkitId,
          limit: 100,
          providerCredential: input.providerCredential,
        });
    const exactIds = new Set((input.actionIds ?? []).map((id) => id.toLowerCase()));
    const candidates = exactIds.size > 0
      ? page.actions.filter((action) => exactIds.has(action.actionId.toLowerCase()))
      : page.actions;
    const intent = terms(input.intent);
    const ranked = candidates.map((action, index) => ({ action, index, score: relevance(action, intent) }))
      .sort((left, right) => right.score - left.score || left.index - right.index)
      .slice(0, maxActions)
      .map(({ action }) => structuredClone(action));
    const context = currentJobExecutionContext();
    if (context) {
      this.accounts.bindJob({
        jobId: context.jobId,
        attemptId: context.attemptId,
        generation: context.generation,
        account,
      });
    }
    return {
      providerId: input.providerId,
      toolkitId: input.toolkitId,
      account,
      actions: ranked,
      discovery: { total: page.actions.length, candidates: candidates.length, exposed: ranked.length },
    };
  }
}
