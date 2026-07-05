/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * cli/v4/tuiCallbacks.ts — Aiden v4.0.0 (Phase 15)
 *
 * TUI-flavoured implementations of the moat callback contracts. Mirrors
 * `CliCallbacks` (Phase 14b) — same input/output surface — but renders
 * modal dialogs via `blessed` instead of inquirer prompts.
 *
 * Used in TUI mode when the ApprovalEngine or SkillTeacher needs the
 * user's input. The classic CliCallbacks remains the default; TUI swaps
 * this in via runTuiMode().
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type {
  ApprovalRequest,
  ApprovalDecision,
  RiskTier,
} from '../../moat/approvalEngine';
import type { SkillProposal } from '../../moat/skillTeacher';
import type { AuxiliaryClient } from '../../core/v4/auxiliaryClient';
import type { CompressionResult } from '../../core/v4/contextCompressor';
import type { PlannerGuardDecision } from '../../moat/plannerGuard';

export interface TuiCallbacksOptions {
  /** Test injection: blessed module. */
  blessedModule?: any;
  /** Test injection: skip screen.render() in headless tests. */
  noRender?: boolean;
  /** Reference to the live screen built by AidenTUI. */
  getScreen: () => any;
  /** History append fn — same one AidenTUI uses for inline messages. */
  appendHistory: (line: string) => void;
  /** Optional auxiliary client for smart-mode risk assessment. */
  auxiliaryClient?: AuxiliaryClient;
}

const KNOWN_TIERS: ReadonlySet<RiskTier> = new Set([
  'safe',
  'caution',
  'dangerous',
]);

function parseRiskTier(content: string): RiskTier {
  const head = content.trim().toLowerCase().split(/\s+/)[0] ?? '';
  const cleaned = head.replace(/[^a-z]/g, '');
  if (KNOWN_TIERS.has(cleaned as RiskTier)) return cleaned as RiskTier;
  return 'caution';
}

export function riskTierColor(tier?: RiskTier): string {
  switch (tier) {
    case 'safe':
      return 'green';
    case 'dangerous':
      return 'red';
    case 'caution':
    default:
      return 'yellow';
  }
}

export function riskTierIcon(tier?: RiskTier): string {
  switch (tier) {
    case 'safe':
      return '🟢';
    case 'dangerous':
      return '🔴';
    case 'caution':
    default:
      return '🟡';
  }
}

export class TuiCallbacks {
  private blessed: any;

  constructor(private opts: TuiCallbacksOptions) {
    this.blessed = opts.blessedModule ?? require('blessed');
  }

  /** ApprovalEngine.callbacks.promptUser */
  promptApproval = async (req: ApprovalRequest): Promise<ApprovalDecision> => {
    return new Promise((resolve) => {
      const screen = this.opts.getScreen();
      const colour = riskTierColor(req.riskTier);
      const icon = riskTierIcon(req.riskTier);
      const argsPreview = safeJson(req.args).slice(0, 200);

      const dialog = this.blessed.box({
        parent: screen,
        top: 'center',
        left: 'center',
        width: '70%',
        height: 14,
        label: ` ${icon} approval required `,
        border: { type: 'line' },
        tags: true,
        style: { border: { fg: colour } },
        content: [
          '',
          `  Tool:     ${req.toolName}`,
          `  Category: ${req.category}`,
          `  Tier:     ${req.riskTier ?? '—'}`,
          `  Args:     ${argsPreview}`,
          req.reason ? `  Reason:   ${req.reason}` : '',
          '',
          '  {bold}[O]{/bold}nce  |  {bold}[S]{/bold}ession  |  {bold}[A]{/bold}lways  |  {bold}[D]{/bold}eny',
        ]
          .filter((l) => l !== '')
          .join('\n'),
      });

      const finish = (decision: ApprovalDecision) => {
        try {
          dialog.destroy();
        } catch {
          /* ignore */
        }
        if (!this.opts.noRender) {
          try {
            screen.render();
          } catch {
            /* ignore */
          }
        }
        resolve(decision);
      };

      // Both lower- and upper-case keys map to the same decision.
      screen.key(['o', 'O'], () => finish('allow'));
      screen.key(['s', 'S'], () => finish('allow_session'));
      screen.key(['a', 'A'], () => finish('allow_always'));
      screen.key(['d', 'D', 'escape'], () => finish('deny'));

      // Test seam: dialog exposes `__resolveDecision` so unit tests can
      // simulate user choice without driving real keypresses.
      (dialog as any).__resolveDecision = (d: ApprovalDecision) => finish(d);

      if (!this.opts.noRender) {
        try {
          screen.render();
        } catch {
          /* ignore */
        }
      }
    });
  };

  /** ApprovalEngine.callbacks.riskAssess */
  riskAssess = async (
    req: ApprovalRequest,
  ): Promise<{ tier: RiskTier; rationale: string }> => {
    if (!this.opts.auxiliaryClient) {
      return { tier: 'caution', rationale: 'no auxiliary client wired' };
    }
    const prompt = `Classify this tool call into one of: safe, caution, dangerous.
Tool: ${req.toolName}
Category: ${req.category}
Args: ${safeJson(req.args).slice(0, 400)}

Reply with ONE word: safe, caution, or dangerous.`;
    const result = await this.opts.auxiliaryClient.call({
      purpose: 'risk_assess',
      prompt,
      maxTokens: 8,
    });
    if (!result.content) {
      return { tier: 'caution', rationale: 'empty auxiliary response' };
    }
    const tier = parseRiskTier(result.content);
    return { tier, rationale: result.content.trim() };
  };

  /** SkillTeacher.callbacks.promptUser */
  promptSkillProposal = async (
    proposal: SkillProposal,
  ): Promise<boolean> => {
    return new Promise((resolve) => {
      const screen = this.opts.getScreen();
      const dialog = this.blessed.box({
        parent: screen,
        top: 'center',
        left: 'center',
        width: '70%',
        height: 16,
        label: ' ⚡ save as skill? ',
        border: { type: 'line' },
        tags: true,
        style: { border: { fg: '#ff6b35' } },
        content: [
          '',
          `  Name:        ${proposal.proposedName}`,
          `  Description: ${proposal.description}`,
          `  Tools:       ${proposal.toolsUsed.join(', ') || '(none)'}`,
          `  Confidence:  ${proposal.confidence.toFixed(2)}`,
          '',
          '  {bold}[Y]{/bold}es  |  {bold}[N]{/bold}o',
        ].join('\n'),
      });

      const finish = (yes: boolean) => {
        try {
          dialog.destroy();
        } catch {
          /* ignore */
        }
        if (!this.opts.noRender) {
          try {
            screen.render();
          } catch {
            /* ignore */
          }
        }
        resolve(yes);
      };

      screen.key(['y', 'Y'], () => finish(true));
      screen.key(['n', 'N', 'escape'], () => finish(false));

      (dialog as any).__resolveDecision = (yes: boolean) => finish(yes);

      if (!this.opts.noRender) {
        try {
          screen.render();
        } catch {
          /* ignore */
        }
      }
    });
  };

  /** PlannerGuard sink. Inline (no modal). */
  onPlannerGuardDecision = (decision: PlannerGuardDecision): void => {
    if (decision.reason === 'no_filter') return;
    if (decision.excludedTools.length === 0) return;
    this.opts.appendHistory(
      `{gray-fg}[planner] kept ${decision.selectedTools.length} tools (${decision.reason}){/gray-fg}`,
    );
  };

  /** Compression sink. Inline. */
  onCompression = (result: CompressionResult): void => {
    // v4.14 — a refusal is internal housekeeping; never surface it in chat.
    if (result.refused && !result.error) {
      return;
    }
    if (result.error) {
      this.opts.appendHistory(
        '{yellow-fg}[compress] auxiliary call failed; history unchanged{/yellow-fg}',
      );
      return;
    }
    this.opts.appendHistory(
      `{gray-fg}[compress] removed ${result.removedMessageCount} msgs, kept ${result.preservedRecentCount} recent (~${result.summaryTokens} tok){/gray-fg}`,
    );
  };

  /** Budget warning sink. */
  onBudgetWarning = (
    level: 'caution' | 'warning',
    turn: number,
    max: number,
  ): void => {
    const label = `Turn ${turn}/${max}`;
    if (level === 'warning') {
      this.opts.appendHistory(
        `{yellow-fg}! Budget: ${label} — approaching the cap.{/yellow-fg}`,
      );
    } else {
      this.opts.appendHistory(`{gray-fg}[budget] ${label}{/gray-fg}`);
    }
  };
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
