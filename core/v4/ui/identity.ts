/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */

/** Canonical six-row Aiden wordmark shared by every presentation adapter. */
export const AIDEN_LOGO_LINES = Object.freeze([
  '█████╗  ██╗██████╗ ███████╗███╗   ██╗',
  '██╔══██╗██║██╔══██╗██╔════╝████╗  ██║',
  '███████║██║██║  ██║█████╗  ██╔██╗ ██║',
  '██╔══██║██║██║  ██║██╔══╝  ██║╚██╗██║',
  '██║  ██║██║██████╔╝███████╗██║ ╚████║',
  '╚═╝  ╚═╝╚═╝╚═════╝ ╚══════╝╚═╝  ╚═══╝',
] as const);

export const AIDEN_LOGO_TEXT = AIDEN_LOGO_LINES.join('\n');

/** Terminal-cell geometry of the canonical interactive boot identity. */
export const AIDEN_LOGO_CELL_WIDTH = 37;
export const AIDEN_LOGO_INDENT = '  ';
export const AIDEN_BOOT_SAFE_MARGIN = 2;
export const AIDEN_BOOT_MIN_COLUMNS =
  AIDEN_LOGO_CELL_WIDTH + AIDEN_LOGO_INDENT.length + AIDEN_BOOT_SAFE_MARGIN;
