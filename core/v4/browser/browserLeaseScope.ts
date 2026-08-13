/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { getLeaseStore, type LeaseStore } from '../browserState';
import { currentBrowserExecutionScope } from './browserExecutionScope';

export function currentBrowserLeaseStore(): LeaseStore {
  return getLeaseStore(currentBrowserExecutionScope()?.session.browserSessionId ?? 'legacy');
}
