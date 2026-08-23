/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import type { ToolHandler } from '../../../core/v4/toolRegistry';
import { truncatePreview } from '../../../core/v4/dryRun';

export const automationStatusTool: ToolHandler = {
  schema: {
    name: 'automation_status',
    description:
      'Inspect Aiden Reliable Automations or preview a schedule. Use this for ordinary recurring, later, daily, or scheduled Aiden work. It is read-only and does not create anything.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['capabilities', 'list', 'preview'] },
        expression: { type: 'string', description: 'Cron, interval, or one-shot schedule expression for preview.' },
        timezone: { type: 'string', description: 'IANA timezone for preview.' },
      },
      required: ['action'],
    },
  },
  category: 'read',
  mutates: false,
  toolset: 'automation',
  riskTier: 'safe',
  async execute(args, ctx) {
    if (!ctx.automation) return { available: false, reason: 'Reliable Automations are unavailable in this execution context.' };
    const action = String(args.action ?? '');
    if (action === 'capabilities') {
      const snapshot = ctx.automation.snapshot();
      return { capability: snapshot.capability, scheduler: snapshot.scheduler };
    }
    if (action === 'list') {
      const snapshot = ctx.automation.snapshot();
      return {
        capability: snapshot.capability,
        scheduler: snapshot.scheduler,
        automations: snapshot.automations.slice(0, 50),
        attention: snapshot.attention.slice(0, 50),
      };
    }
    if (action === 'preview') {
      const expression = String(args.expression ?? '').trim();
      const timezone = String(args.timezone ?? '').trim();
      if (!expression || !timezone) return { available: false, reason: 'Schedule expression and IANA timezone are required.' };
      return { expression, timezone, instants: ctx.automation.preview({ expression, timezone, count: 5 }) };
    }
    return { available: false, reason: 'Unknown Reliable Automations status action.' };
  },
};

export const automationManageTool: ToolHandler = {
  schema: {
    name: 'automation_manage',
    description:
      'Create, enable, disable, or run an Aiden Reliable Automation through the durable v4.22 authority. Use only when the user explicitly asks to mutate an Aiden Automation. Do not use for a preview or for an explicit Windows Task Scheduler request.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'enable', 'disable', 'run_now'] },
        automation_id: { type: 'string' },
        name: { type: 'string' },
        prompt: { type: 'string' },
        expression: { type: 'string' },
        timezone: { type: 'string' },
      },
      required: ['action'],
    },
  },
  category: 'write',
  mutates: true,
  toolset: 'automation',
  riskTier: 'caution',
  buildPreview(args) {
    return {
      tool: 'automation_manage', args, riskTier: 'caution',
      sideEffects: [{
        type: 'app_control',
        action: `reliable-automation:${String(args.action ?? 'unknown')}`,
        target: String(args.automation_id ?? args.name ?? 'automation'),
      }],
      detectedRisks: [],
      summary: `Would ${String(args.action ?? 'change')} Reliable Automation ${truncatePreview(String(args.automation_id ?? args.name ?? ''), 80)}`,
    };
  },
  async execute(args, ctx) {
    if (!ctx.automation) return { success: false, error: 'Reliable Automations are unavailable in this execution context.' };
    const action = String(args.action ?? '');
    if (action === 'create') {
      const name = String(args.name ?? '').trim();
      const prompt = String(args.prompt ?? '').trim();
      const expression = String(args.expression ?? '').trim();
      const timezone = String(args.timezone ?? '').trim();
      if (!name || !prompt || !expression || !timezone) {
        return { success: false, error: 'Name, prompt, schedule expression, and IANA timezone are required.' };
      }
      return ctx.automation.create({
        name: name.slice(0, 256), createdBy: 'local-user',
        action: { kind: 'prompt', prompt: prompt.slice(0, 100_000) },
        trigger: { kind: 'schedule', expression: expression.slice(0, 512), timezone: timezone.slice(0, 128) },
        policies: {
          misfire: { kind: 'run_once', maxAgeMs: 3_600_000 },
          overlap: 'skip', retry: { maxAttempts: 1 },
        },
        capabilities: [], credentialRefs: [], approval: { mode: 'policy' },
      });
    }
    const automationId = String(args.automation_id ?? '').trim();
    if (!automationId) return { success: false, error: 'Automation identity is required.' };
    if (action === 'enable') return ctx.automation.setEnabled(automationId, true);
    if (action === 'disable') return ctx.automation.setEnabled(automationId, false);
    if (action === 'run_now') return ctx.automation.runNow(automationId);
    return { success: false, error: 'Unknown Reliable Automations action.' };
  },
};
