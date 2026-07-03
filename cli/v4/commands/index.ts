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
import { undo } from './undo';
import { retry } from './retry';
import { yolo } from './yolo';
import { autonomy } from './autonomy';
import { busy } from './busy';
import { queue } from './queue';
import { redirect } from './redirect';
import { skin } from './skin';
// v4.9.0 Slice 1a — unified theme system.
import { theme } from './theme';
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
import { cron } from './cron';
import { setup } from './setup';
import { channel } from './channel';
import { voice } from './voice';
import { status } from './status';
import { show } from './show';
import { history } from './history';
import { reloadSoul } from './reloadSoul';
import { update } from './update';
// v4.5 Phase 8a — subsystem live-flip slash commands.
import { sandbox } from './sandbox';
import { tce } from './tce';
import { browserDepth } from './browserDepth';
import { browser } from './browser';
import { budget } from './budget';
import { daemonStatus } from './daemonStatus';
// v4.5 Phase 8b — contextual capability suggestions toggle.
import { suggestions } from './suggestions';
// v4.6 Phase 2M — opt-in keyword-based tool narrower (default OFF).
import { plannerGuard } from './plannerGuard';
// v4.6 Phase 3A — operator kill-switch for sub-agent spawning.
import { spawnPause } from './spawnPause';
// v4.6 Phase 3b — self-improvement loop operator surface.
import { recovery } from './recovery';
// ONB1 slice 10 — new-user guided tour.
import { walkthrough } from './walkthrough';
// v4.9.1 amendment — REPL slash surfaces for memory + hooks (mirrors CLI).
import { memory } from './memorySlash';
import { hooks }  from './hooksSlash';
// v4.9.3 Slice 1b — boot greeter management.
import { greeter } from './greeter';
// v4.12 Slice 1a — /mcp read-only surfacing of the MCP client.
import { mcp } from './mcpManage';
// v4.12 /commands slice — /home working-directory show/change.
import { home } from './home';

export {
  help,
  tools,
  model,
  personality,
  save,
  title,
  compress,
  usage,
  undo,
  retry,
  yolo,
  autonomy,
  busy,
  queue,
  redirect,
  skin,
  theme,
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
  cron,
  setup,
  channel,
  voice,
  status,
  show,
  history,
  reloadSoul,
  update,
  // v4.5 Phase 8a — subsystem toggles.
  sandbox,
  tce,
  browserDepth,
  browser,
  budget,
  daemonStatus,
  // v4.5 Phase 8b — contextual suggestions toggle.
  suggestions,
  // v4.6 Phase 2M — opt-in keyword-based tool narrower.
  plannerGuard,
  // v4.6 Phase 3A — operator kill-switch for sub-agent spawning.
  spawnPause,
  // v4.6 Phase 3b — self-improvement loop operator surface.
  recovery,
  // ONB1 slice 10 — new-user guided tour.
  walkthrough,
  // v4.9.1 amendment.
  memory,
  hooks,
  mcp,
  home,
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
  undo,
  retry,
  yolo,
  autonomy,
  busy,
  queue,
  redirect,
  skin,
  theme,
  skills,
  plugins,
  auth,
  license,
  doctor,
  cron,
  setup,
  channel,
  voice,
  status,
  show,
  history,
  reloadSoul,
  reloadMcp,
  // v4.12 Slice 1a — /mcp read-only surfacing.
  mcp,
  reasoning,
  verbose,
  // Phase v4.1.2-update: /update + /update install — fresh registry
  // probe + shared executeInstall executor (also wired into
  // aiden_self_update tool for natural-language requests).
  update,
  // v4.5 Phase 8a — subsystem live-flip slash commands.
  sandbox,
  tce,
  browserDepth,
  browser,
  budget,
  daemonStatus,
  // v4.5 Phase 8b — contextual suggestions toggle.
  suggestions,
  // v4.6 Phase 2M — opt-in keyword-based tool narrower (default OFF).
  plannerGuard,
  // v4.6 Phase 3A — operator kill-switch for sub-agent spawning.
  spawnPause,
  // v4.6 Phase 3b — self-improvement loop operator surface.
  recovery,
  // ONB1 slice 10 — new-user guided tour.
  walkthrough,
  // v4.9.1 amendment — REPL slash surfaces mirroring CLI subcommands.
  memory,
  hooks,
  // v4.9.3 Slice 1b — boot greeter management.
  greeter,
  // v4.12 /commands slice — /home working-directory show/change.
  home,
  clear,
  quit,
];
