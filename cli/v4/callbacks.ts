/**
 * cli/v4/callbacks.ts — Aiden v4.0.0 (Phase 14b)
 *
 * CLI-side implementations of the moat callback contracts. Wired up in
 * Phase 14c when AidenAgent is constructed; each callback is otherwise
 * self-contained so unit tests don't need a chat REPL.
 *
 * Hermes reference: hermes_cli/callbacks.py — clarify, sudo, approval
 * prompt callbacks. Aiden v4 trims the scope to what Phase 14b needs:
 * approval prompts, smart-mode risk assessment, skill-teacher proposals,
 * planner-guard / compression / budget notices. Clarify + sudo arrive in
 * v4.1 alongside the multi-pane TUI.
 */

import type { Display } from './display';
import type {
  ApprovalRequest,
  ApprovalDecision,
  RiskTier,
} from '../../moat/approvalEngine';
import type { SkillProposal } from '../../moat/skillTeacher';
import type { PlannerGuardDecision } from '../../moat/plannerGuard';
import type { CompressionResult } from '../../core/v4/contextCompressor';
import type { AuxiliaryClient } from '../../core/v4/auxiliaryClient';

export type VerboseMode = 'compact' | 'normal' | 'verbose';

export interface CliCallbacksOptions {
  display: Display;
  auxiliaryClient?: AuxiliaryClient;
  verboseMode?: VerboseMode;
  /** Injectable inquirer module for tests. */
  promptModule?: PromptApi;
}

export interface PromptApi {
  select(opts: {
    message: string;
    choices: { name: string; value: string }[];
  }): Promise<string>;
  confirm(opts: { message: string; default?: boolean }): Promise<boolean>;
}

async function defaultPrompts(): Promise<PromptApi> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const inq = require('@inquirer/prompts');
  return {
    async select(opts) {
      return inq.select(opts);
    },
    async confirm(opts) {
      return inq.confirm(opts);
    },
  };
}

const DECISION_CHOICES: { name: string; value: ApprovalDecision }[] = [
  { name: 'Allow once', value: 'allow' },
  { name: 'Allow this session', value: 'allow_session' },
  { name: 'Allow always', value: 'allow_always' },
  { name: 'Deny', value: 'deny' },
];

const KNOWN_TIERS: ReadonlySet<RiskTier> = new Set(['safe', 'caution', 'dangerous']);

function parseRiskTier(content: string): RiskTier {
  const head = content.trim().toLowerCase().split(/\s+/)[0] ?? '';
  // Strip punctuation that might bleed in from JSON: "safe.", "caution,"...
  const cleaned = head.replace(/[^a-z]/g, '');
  if (KNOWN_TIERS.has(cleaned as RiskTier)) return cleaned as RiskTier;
  return 'caution';
}

export class CliCallbacks {
  private readonly display: Display;
  private readonly auxiliaryClient?: AuxiliaryClient;
  private verboseMode: VerboseMode;
  private promptsPromise: Promise<PromptApi>;

  constructor(opts: CliCallbacksOptions) {
    this.display = opts.display;
    this.auxiliaryClient = opts.auxiliaryClient;
    this.verboseMode = opts.verboseMode ?? 'normal';
    this.promptsPromise = opts.promptModule
      ? Promise.resolve(opts.promptModule)
      : defaultPrompts();
  }

  /** Update verbose mode at runtime (wired to /verbose). */
  setVerboseMode(mode: VerboseMode): void {
    this.verboseMode = mode;
  }

  /** ApprovalEngine.callbacks.promptUser */
  promptApproval = async (req: ApprovalRequest): Promise<ApprovalDecision> => {
    const tierBadge = badgeForTier(req.riskTier);
    this.display.line(60);
    this.display.warn(
      `Approval required: ${req.toolName} ${tierBadge}`,
    );
    if (req.reason) this.display.dim(`  reason: ${req.reason}`);
    const argsPreview = JSON.stringify(req.args).slice(0, 200);
    this.display.dim(`  args: ${argsPreview}`);
    this.display.line(60);

    const prompts = await this.promptsPromise;
    let choice: string;
    try {
      choice = await prompts.select({
        message: 'Decision',
        choices: DECISION_CHOICES,
      });
    } catch {
      // User hit Ctrl+C or otherwise cancelled — fail closed.
      return 'deny';
    }
    return choice as ApprovalDecision;
  };

  /** ApprovalEngine.callbacks.riskAssess */
  riskAssess = async (
    req: ApprovalRequest,
  ): Promise<{ tier: RiskTier; rationale: string }> => {
    if (!this.auxiliaryClient) {
      return { tier: 'caution', rationale: 'no auxiliary client wired' };
    }
    const prompt = `Classify this tool call into one of: safe, caution, dangerous.
Tool: ${req.toolName}
Category: ${req.category}
Args: ${JSON.stringify(req.args).slice(0, 400)}

Reply with ONE word: safe, caution, or dangerous.`;
    const result = await this.auxiliaryClient.call({
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
  promptSkillProposal = async (proposal: SkillProposal): Promise<boolean> => {
    this.display.line(60);
    this.display.info(`Skill suggestion: ${proposal.proposedName}`);
    this.display.dim(`  ${proposal.description}`);
    if (proposal.toolsUsed.length > 0) {
      this.display.dim(`  tools: ${proposal.toolsUsed.join(', ')}`);
    }
    this.display.dim(`  confidence: ${proposal.confidence.toFixed(2)}`);
    this.display.line(60);

    const prompts = await this.promptsPromise;
    try {
      return await prompts.confirm({
        message: 'Save this as a reusable skill?',
        default: false,
      });
    } catch {
      return false;
    }
  };

  /** PlannerGuard sink. Quiet in compact mode. */
  onPlannerGuardDecision = (decision: PlannerGuardDecision): void => {
    if (this.verboseMode === 'compact') return;
    if (decision.reason === 'no_filter') return;
    if (this.verboseMode === 'verbose') {
      const conf =
        decision.confidence !== undefined
          ? ` (conf ${decision.confidence.toFixed(2)})`
          : '';
      this.display.dim(
        `[planner] ${decision.reason}${conf}: kept ${decision.selectedTools.length} / dropped ${decision.excludedTools.length}`,
      );
      return;
    }
    // normal
    if (decision.excludedTools.length > 0) {
      this.display.dim(
        `[planner] kept ${decision.selectedTools.length} tools (${decision.reason})`,
      );
    }
  };

  /** ContextCompressor sink — always shows. */
  onCompression = (result: CompressionResult): void => {
    if (result.refused) {
      this.display.dim('[compress] refused — conversation too short');
      return;
    }
    if (result.error) {
      this.display.warn('[compress] auxiliary call failed; history unchanged');
      return;
    }
    this.display.dim(
      `[compress] removed ${result.removedMessageCount} msgs, kept ${result.preservedRecentCount} recent (~${result.summaryTokens} tok)`,
    );
  };

  /** Budget warning sink. Caution = dim line, warning = visible warn. */
  onBudgetWarning = (
    level: 'caution' | 'warning',
    turn: number,
    max: number,
  ): void => {
    const msg = `Turn ${turn}/${max}`;
    if (level === 'warning') {
      this.display.warn(`Budget: ${msg} — approaching the cap.`);
    } else {
      this.display.dim(`[budget] ${msg}`);
    }
  };

  /**
   * Phase 16d: memory refresh sink. Fires once per turn after the agent
   * rebuilds the system prompt against fresh MEMORY.md / USER.md content.
   * The "✓ Saved" confirmation that the user sees is rendered separately
   * by the chat loop right after `memory_add` returns `verified=true` —
   * this hook is the diagnostic counterpart for verbose mode.
   */
  onMemoryRefresh = (which: 'memory' | 'user' | 'both'): void => {
    this.display.dim(`[memory] refreshed system prompt (${which})`);
  };
}

function badgeForTier(tier?: RiskTier): string {
  switch (tier) {
    case 'safe':
      return '🟢 safe';
    case 'caution':
      return '🟡 caution';
    case 'dangerous':
      return '🔴 dangerous';
    default:
      return '';
  }
}
