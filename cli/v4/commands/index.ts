/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/commands/index.ts — Phase 14b barrel (Phase 16b.1: +/providers)
 *
 * Exports the system slash commands. Phase 14c imports `allCommands`
 * and registers each on the global CommandRegistry at boot.
 */

import type { SlashCommand } from '../commandRegistry';
import { help } from './help';
import { tools } from './tools';
import { model } from './model';
import { personality } from './personality';
import { save } from './save';
import { title } from './title';
import { compress } from './compress';
import { usage } from './usage';
import { yolo } from './yolo';
import { skin } from './skin';
import { skills } from './skills';
import { reloadMcp } from './reloadMcp';
import { reasoning } from './reasoning';
import { verbose } from './verbose';
import { clear } from './clear';
import { quit } from './quit';
import { providers } from './providers';
import { identity } from './identity';
import { debugPrompt } from './debugPrompt';
import { streaming } from './streaming';
import { plugins } from './plugins';
import { auth } from './auth';
import { license } from './license';
import { doctor } from './doctor';

export {
  help,
  tools,
  model,
  personality,
  save,
  title,
  compress,
  usage,
  yolo,
  skin,
  skills,
  reloadMcp,
  reasoning,
  verbose,
  clear,
  quit,
  providers,
  identity,
  debugPrompt,
  streaming,
  plugins,
  auth,
  license,
  doctor,
};

/** All built-in system commands, in canonical order. */
export const allCommands: SlashCommand[] = [
  help,
  tools,
  model,
  providers,
  personality,
  identity,
  debugPrompt,
  streaming,
  save,
  title,
  compress,
  usage,
  yolo,
  skin,
  skills,
  plugins,
  auth,
  license,
  doctor,
  reloadMcp,
  reasoning,
  verbose,
  clear,
  quit,
];
