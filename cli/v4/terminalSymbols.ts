/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

export type TerminalStateSymbol = 'running' | 'completed' | 'failed' | 'warning' | 'unknown' | 'user' | 'agent';

export function terminalSupportsUnicode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AIDEN_UI_UNICODE !== '0' && env.TERM?.toLowerCase() !== 'dumb';
}

export function terminalStateSymbol(
  state: TerminalStateSymbol,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const unicode: Record<TerminalStateSymbol, string> = {
    running: '◐', completed: '✓', failed: '✕', warning: '!', unknown: '?',
    user: '▲', agent: '│',
  };
  const ascii: Record<TerminalStateSymbol, string> = {
    running: '[>]', completed: '[+]', failed: '[x]', warning: '[!]', unknown: '[?]',
    user: '>', agent: '|',
  };
  return (terminalSupportsUnicode(env) ? unicode : ascii)[state];
}
