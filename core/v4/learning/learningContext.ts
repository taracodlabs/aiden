/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import type { LearningAuthority } from './learningAuthority';
import type { LearningRetrievalResult, LearningScope, LearningType } from './types';

export interface LearningContextRequest {
  objective: string;
  scopes: LearningScope[];
  maxEntries?: number;
  maxChars?: number;
  types?: LearningType[];
}

/** One provider-neutral read port. Callers never query Learning tables directly. */
export interface LearningContextProvider {
  retrieveLearning(input: LearningContextRequest): Promise<LearningRetrievalResult> | LearningRetrievalResult;
}

export function createLearningContextProvider(authority: LearningAuthority): LearningContextProvider {
  return {
    retrieveLearning(input) {
      return authority.retrieve({
        query: input.objective,
        scopes: input.scopes,
        limit: input.maxEntries,
        maxChars: input.maxChars,
        types: input.types,
      });
    },
  };
}
