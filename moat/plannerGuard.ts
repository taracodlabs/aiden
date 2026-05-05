/**
 * moat/plannerGuard.ts — Aiden v4.0.0
 *
 * Pre-loop intent classifier — selects a tool subset for this turn.
 *
 * Why this exists:
 *   LLMs degrade as tool count grows. Aiden registers 50+ tools by Phase 8;
 *   smaller models (Llama 3, Mistral) start hallucinating tool names or
 *   picking the wrong tool when the menu gets that long. Some tool names
 *   also collide with the model's training data (e.g. Llama-3.3 emits the
 *   legacy `<|python_tag|>web_search` syntax instead of native tool calls).
 *
 *   PlannerGuard runs BEFORE the LLM is called, narrows the registered
 *   tool list to a relevant subset for the user's current message, and
 *   passes only that subset into AidenAgent.runConversation.
 *
 * Safety contract:
 *   PlannerGuard NARROWS — it never adds tools the registry didn't already
 *   contain. Worst-case misclassification = LLM has fewer options and
 *   may say "I can't do that with available tools". A future Phase 13
 *   fallback can re-run with the full list. Phase 12 just narrows.
 *
 * Three modes:
 *   off              — returns all tools verbatim (no-op).
 *   rule_based       — keyword-driven; matches user message against a rule
 *                      table. Default.
 *   llm_classified   — auxiliary LLM call. Wired but defaulted off; user
 *                      enables in config. Falls back to rule_based on any
 *                      malformed/timeout response.
 *
 * Skill-driven activation:
 *   When `skill_view <name>` is called and the skill declares
 *   `metadata.aiden.requires_toolsets: [...]`, PlannerGuard adds those
 *   toolsets to its "active" set for the rest of the conversation via
 *   `activateToolsets()`. Caller (AidenAgent) plumbs this in Phase 12.
 *
 * Status: PHASE 12.
 */

import type {
  ProviderAdapter,
  Message,
  ToolSchema,
} from '../providers/v4/types';
import type { ToolHandler } from '../core/v4/toolRegistry';

/** Minimal registry surface PlannerGuard needs. */
export interface PlannerGuardRegistry {
  /** All registered handlers — PlannerGuard reads `name` and `toolset`. */
  list(): string[];
  get(name: string): ToolHandler | undefined;
  getSchemas(filterToolsets?: string[]): ToolSchema[];
}

export type PlannerGuardMode = 'off' | 'rule_based' | 'llm_classified';

export interface PlannerGuardDecision {
  /** Tool names to expose this turn. */
  selectedTools: string[];
  /** Tool names trimmed from the registry. */
  excludedTools: string[];
  /**
   * Where the decision came from. `no_filter` = `off` mode or empty registry.
   * `fallback` = llm_classified attempted but failed; rule_based result used.
   */
  reason:
    | 'no_filter'
    | 'rule_match'
    | 'llm_classification'
    | 'fallback'
    /**
     * Phase 16g: no keyword rule matched — open the inventory rather
     * than narrow to CORE_TOOL_NAMES. Per
     * `docs/sprint/hermes-autonomy-audit.md`, Hermes never narrows
     * per-turn. Restoring full agency for fuzzy multi-step intents
     * ("play me a song on youtube") that don't match any rule.
     */
    | 'no_rule_match_open';
  /** 0–1, only set in llm_classified mode. */
  confidence?: number;
}

/**
 * Tool-name → toolset rule. Order matters: first match wins is NOT the
 * pattern; matches UNION (a single message about "search files" hits both
 * `web` and `files`).
 */
interface KeywordRule {
  keywords: RegExp;
  toolsets: string[];
}

const RULES: KeywordRule[] = [
  // Files (file_*, fs operations)
  {
    keywords:
      /\b(file|files|read|write|delete|move|copy|patch|directory|folder|path)\b/i,
    toolsets: ['files'],
  },
  // Web fetch / search
  {
    keywords:
      /\b(search|google|web|fetch|url|http|https|page|website|online|internet)\b/i,
    toolsets: ['web'],
  },
  // Browser automation
  {
    keywords:
      /\b(browser|click|navigate|screenshot|scroll|chromium|chrome)\b/i,
    toolsets: ['browser'],
  },
  // Shell / terminal
  {
    keywords: /\b(shell|run|exec|terminal|command|bash|powershell|cmd)\b/i,
    toolsets: ['terminal', 'execute'],
  },
  // Memory
  {
    keywords:
      /\b(remember|forget|memory|preference|recall|note that|memorize)\b/i,
    toolsets: ['memory'],
  },
  // Skills
  {
    keywords: /\b(skill|skills|plugin|extension)\b/i,
    toolsets: ['skills'],
  },
  // Sessions
  {
    keywords:
      /\b(session|sessions|history|past|previous|earlier|conversation)\b/i,
    toolsets: ['sessions'],
  },
  // Code execution / data work
  {
    keywords:
      /\b(python|node|javascript|code|calculate|compute|analy[sz]e|data|script)\b/i,
    toolsets: ['execute'],
  },
  // Process registry
  {
    keywords:
      /\b(process|background|long.?running|server|spawn|kill|daemon)\b/i,
    toolsets: ['process'],
  },
];

/** Always-on tools regardless of mode. The agent needs schema lookup
 *  + skill discovery + session search to be useful even on cold turns. */
const CORE_TOOL_NAMES = new Set<string>([
  'skills_list',
  'lookup_tool_schema',
  'session_search',
]);

/** LLM-classified mode: max tokens for the classifier response. Cheap. */
const LLM_CLASSIFIER_MAX_TOKENS = 100;
/** LLM-classified mode: timeout (ms) before falling back to rule_based. */
const LLM_CLASSIFIER_TIMEOUT_MS = 4000;

export class PlannerGuard {
  private mode: PlannerGuardMode;
  /** Toolsets activated by `skill_view` for the rest of the conversation. */
  private readonly activeToolsets = new Set<string>();

  constructor(
    private readonly registry: PlannerGuardRegistry,
    mode: PlannerGuardMode = 'rule_based',
    private readonly llmAdapter?: ProviderAdapter,
  ) {
    this.mode = mode;
  }

  /** Switch mode at runtime (e.g. from a `/planner` slash command). */
  setMode(mode: PlannerGuardMode): void {
    this.mode = mode;
  }

  getMode(): PlannerGuardMode {
    return this.mode;
  }

  /**
   * Mark toolsets as "active" for the rest of the conversation. Called
   * by AidenAgent after a successful `skill_view` for a skill that
   * declares `metadata.aiden.requires_toolsets`.
   */
  activateToolsets(toolsets: string[]): void {
    for (const t of toolsets) this.activeToolsets.add(t);
  }

  /** Reset activation set (typically on conversation reset). */
  resetActivation(): void {
    this.activeToolsets.clear();
  }

  /** Decide tool subset for this turn. */
  async decide(
    userMessage: string,
    _conversationContext: Message[] = [],
  ): Promise<PlannerGuardDecision> {
    const allNames = this.registry.list();
    if (allNames.length === 0) {
      return {
        selectedTools: [],
        excludedTools: [],
        reason: 'no_filter',
      };
    }

    if (this.mode === 'off') {
      return {
        selectedTools: allNames,
        excludedTools: [],
        reason: 'no_filter',
      };
    }

    if (this.mode === 'llm_classified' && this.llmAdapter) {
      const llmResult = await this.tryLlmClassify(userMessage, allNames);
      if (llmResult) {
        return llmResult;
      }
      // Fall through to rule_based on any failure.
      const ruleResult = this.decideRuleBased(userMessage, allNames);
      return { ...ruleResult, reason: 'fallback' };
    }

    return this.decideRuleBased(userMessage, allNames);
  }

  // ─────────────────────────────────────────────────────────────────────
  // rule_based
  // ─────────────────────────────────────────────────────────────────────

  private decideRuleBased(
    userMessage: string,
    allNames: string[],
  ): PlannerGuardDecision {
    const matchedToolsets = new Set<string>();

    for (const rule of RULES) {
      if (rule.keywords.test(userMessage)) {
        for (const t of rule.toolsets) matchedToolsets.add(t);
      }
    }
    // Always include skill-activated toolsets.
    for (const t of this.activeToolsets) matchedToolsets.add(t);

    // Phase 16g: no keyword rule matched. Pre-16g this returned only
    // CORE_TOOL_NAMES (3 tools), which broke fuzzy multi-step intents
    // like "play me a song on youtube" — the model could not see
    // browser_navigate / web_search / open_url and had no pathway to
    // chain. Per docs/sprint/hermes-autonomy-audit.md, Hermes never
    // narrows per-turn; restoring full agency on fuzzy intents.
    //
    // Explicit single-domain intents still narrow correctly because
    // their keyword rule fires (the path below this block).
    const ruleMatched = matchedToolsets.size > 0;
    if (!ruleMatched) {
      return {
        selectedTools: allNames,
        excludedTools: [],
        reason: 'no_rule_match_open',
      };
    }

    const selected: string[] = [];
    const excluded: string[] = [];
    for (const name of allNames) {
      const handler = this.registry.get(name);
      const inToolset =
        !!handler?.toolset && matchedToolsets.has(handler.toolset);
      const isCore = CORE_TOOL_NAMES.has(name);
      if (inToolset || isCore) selected.push(name);
      else excluded.push(name);
    }

    return {
      selectedTools: selected,
      excludedTools: excluded,
      reason: 'rule_match',
    };
  }

  // ─────────────────────────────────────────────────────────────────────
  // llm_classified
  // ─────────────────────────────────────────────────────────────────────

  private async tryLlmClassify(
    userMessage: string,
    allNames: string[],
  ): Promise<PlannerGuardDecision | null> {
    if (!this.llmAdapter) return null;

    const toolDescriptions = allNames
      .map((n) => {
        const h = this.registry.get(n);
        const desc = h?.schema.description ?? '';
        return `- ${n}: ${desc.slice(0, 80)}`;
      })
      .join('\n');

    const systemPrompt =
      'You select which tools an AI agent needs for one user request.\n' +
      'Output ONLY a JSON array of tool names from the provided list.\n' +
      'Example: ["file_read","web_search"]';

    const userPrompt =
      `User request: "${userMessage.slice(0, 500)}"\n\n` +
      `Available tools:\n${toolDescriptions}\n\n` +
      'Return JSON array of tool names that are most relevant.';

    try {
      const callPromise = this.llmAdapter.call({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        tools: [],
        maxTokens: LLM_CLASSIFIER_MAX_TOKENS,
        temperature: 0,
      });
      const timeoutPromise = new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), LLM_CLASSIFIER_TIMEOUT_MS);
      });
      const result = await Promise.race([callPromise, timeoutPromise]);
      if (!result) return null; // timeout → fallback

      const raw = (result as { content: string | null }).content ?? '';
      const parsed = parseJsonArray(raw);
      if (!parsed) return null;

      // Intersect with registry — never add tools the registry doesn't have.
      const allowed = new Set(allNames);
      const llmSelected = parsed.filter((n) => allowed.has(n));

      // If the model returned nothing useful, fall back to rule_based —
      // core-tool injection should not mask a failed classification.
      if (llmSelected.length === 0) return null;

      // Always include core tools that exist.
      for (const n of allNames) {
        if (CORE_TOOL_NAMES.has(n) && !llmSelected.includes(n)) {
          llmSelected.push(n);
        }
      }
      // Always include skill-activated toolsets' tools.
      if (this.activeToolsets.size > 0) {
        for (const n of allNames) {
          const h = this.registry.get(n);
          if (
            h?.toolset &&
            this.activeToolsets.has(h.toolset) &&
            !llmSelected.includes(n)
          ) {
            llmSelected.push(n);
          }
        }
      }

      return {
        selectedTools: llmSelected,
        excludedTools: allNames.filter((n) => !llmSelected.includes(n)),
        reason: 'llm_classification',
        confidence: 0.85,
      };
    } catch {
      return null;
    }
  }
}

/**
 * Parse a JSON array of strings from an LLM response. Tolerates code-fence
 * wrappers and leading/trailing prose. Returns null on failure.
 */
function parseJsonArray(raw: string): string[] | null {
  if (!raw) return null;
  // Strip code fences.
  let text = raw.trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  // Find the first [ … ].
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  const slice = text.slice(start, end + 1);
  try {
    const parsed = JSON.parse(slice);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    return null;
  }
}

/** Exported for tests. */
export const __test__ = { parseJsonArray, RULES, CORE_TOOL_NAMES };
