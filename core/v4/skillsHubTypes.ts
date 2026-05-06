/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/skillsHubTypes.ts — Aiden v4.0.0
 *
 * Shared types for the skills hub. Split out so the security
 * scanner can reference `HubSource` without pulling in the full
 * SkillsHub class (and its network-dependent install machinery).
 *
 * Status: PHASE 10.
 */

export type HubSourceType =
  | 'official'
  | 'agentskills'
  | 'skills-sh'
  | 'well-known'
  | 'github'
  | 'url'
  | 'clawhub'
  | 'claude-marketplace'
  | 'builtin';

export type HubSource =
  | { type: 'official'; identifier: string }
  | { type: 'agentskills'; identifier: string }
  | { type: 'skills-sh'; identifier: string }
  | { type: 'well-known'; url: string }
  | { type: 'github'; identifier: string; org: string; repo: string; skillPath?: string }
  | { type: 'url'; url: string }
  | { type: 'clawhub'; identifier: string }
  | { type: 'claude-marketplace'; identifier: string }
  | { type: 'builtin'; identifier: string };

export interface HubSearchResult {
  source: HubSource;
  name: string;
  description: string;
  version?: string;
  author?: string;
  url: string;
}
