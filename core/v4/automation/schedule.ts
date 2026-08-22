/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import { Cron } from 'croner';

export interface SchedulePreview {
  expression: string;
  timezone: string;
  instants: readonly string[];
}

export function assertIanaTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date(0));
  } catch {
    throw new Error(`Invalid IANA timezone: ${timezone}`);
  }
}

export function nextScheduleInstants(command: {
  expression: string;
  timezone: string;
  after: Date | string | number;
  count: number;
}): string[] {
  assertIanaTimezone(command.timezone);
  if (!Number.isInteger(command.count) || command.count < 1 || command.count > 100) {
    throw new Error('Schedule preview count must be between 1 and 100');
  }
  const after = command.after instanceof Date ? command.after : new Date(command.after);
  if (Number.isNaN(after.getTime())) throw new Error('Invalid schedule preview anchor');
  if (command.expression.startsWith('interval:')) {
    const intervalMs = Number.parseInt(command.expression.slice('interval:'.length), 10);
    if (!Number.isFinite(intervalMs) || intervalMs < 1) throw new Error('Invalid interval schedule');
    return Array.from({ length: command.count }, (_, index) =>
      new Date(after.getTime() + intervalMs * (index + 1)).toISOString());
  }
  if (command.expression.startsWith('oneshot:')) {
    const instant = new Date(command.expression.slice('oneshot:'.length));
    if (Number.isNaN(instant.getTime())) throw new Error('Invalid one-shot schedule');
    if (command.count !== 1 || instant.getTime() <= after.getTime()) {
      throw new Error('One-shot schedule has no requested future occurrence');
    }
    return [instant.toISOString()];
  }
  const expression = command.expression.startsWith('cron:')
    ? command.expression.slice('cron:'.length)
    : command.expression;
  let cron: Cron;
  try {
    cron = new Cron(expression, { timezone: command.timezone });
  } catch (error) {
    throw new Error(`Invalid schedule expression: ${error instanceof Error ? error.message : String(error)}`);
  }
  const instants = cron.nextRuns(command.count, after).map((date) => date.toISOString());
  if (instants.length !== command.count) throw new Error('Schedule does not have enough future occurrences');
  if (new Set(instants).size !== instants.length) throw new Error('Schedule produced duplicate UTC instants');
  return instants;
}

export function previewSchedule(command: {
  expression: string;
  timezone: string;
  after?: Date | string | number;
  count?: number;
}): SchedulePreview {
  return {
    expression: command.expression,
    timezone: command.timezone,
    instants: nextScheduleInstants({
      expression: command.expression,
      timezone: command.timezone,
      after: command.after ?? Date.now(),
      count: command.count ?? 5,
    }),
  };
}

export function previousScheduleInstant(command: {
  expression: string;
  timezone: string;
  before: Date | string | number;
}): string | null {
  assertIanaTimezone(command.timezone);
  const before = command.before instanceof Date ? command.before : new Date(command.before);
  if (Number.isNaN(before.getTime())) throw new Error('Invalid schedule history anchor');
  if (command.expression.startsWith('oneshot:')) {
    const instant = new Date(command.expression.slice('oneshot:'.length));
    return instant.getTime() < before.getTime() ? instant.toISOString() : null;
  }
  if (command.expression.startsWith('interval:')) return null;
  const expression = command.expression.startsWith('cron:')
    ? command.expression.slice('cron:'.length) : command.expression;
  const cron = new Cron(expression, { timezone: command.timezone });
  return cron.previousRuns(1, before)[0]?.toISOString() ?? null;
}
