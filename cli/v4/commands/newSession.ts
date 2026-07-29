/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
import type { SlashCommand } from '../commandRegistry';
import { clear } from './clear';

export const newSession: SlashCommand = {
  name: 'new',
  description: 'Alias for /clear: start a clean conversation and retain durable work.',
  category: 'system',
  icon: '+',
  handler: clear.handler,
};
