/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

export function resolveDesktopApiClientLocalCommand(
  args: readonly string[],
  version: string,
): string | null {
  if (args.includes('--version') || args.includes('-v')) return `${version}\n`;
  if (args.includes('--help') || args.includes('-h')) {
    return [
      `Aiden desktop/API client ${version}`,
      '',
      'Connects to an already-running Aiden API service.',
      'Set AIDEN_API to override the default http://localhost:4200 endpoint.',
      '',
      'The public aiden and aiden-runtime commands use the standalone local runtime.',
      '',
    ].join('\n');
  }
  return null;
}
