import type { Message, ToolSchema } from '../../providers/v4/types';
import type { UsageMode } from './usageLedger';

export type BudgetLifecycleState =
  | 'unbudgeted'
  | 'estimated'
  | 'running_green'
  | 'running_yellow'
  | 'running_red'
  | 'over_budget_critical'
  | 'completed'
  | 'aborted';

export interface EconomyToolSelection {
  selected: ToolSchema[];
  deferredCount: number;
  originalSchemaBytes: number;
  selectedSchemaBytes: number;
  estimatedSchemaSavings: number;
  confidence: 'high' | 'medium' | 'low';
}

const ALWAYS = new Set([
  'clarify',
  'plan_approval',
  'lookup_tool_schema',
  'tool_search',
  'tool_call',
  'tool_result_artifact_read',
]);

const DOMAIN_HINTS: ReadonlyArray<{ pattern: RegExp; prefixes: readonly string[] }> = [
  { pattern: /\b(file|folder|directory|repository|code|source|edit|write|patch|read)\b/i, prefixes: ['file_', 'read_pdf'] },
  { pattern: /\b(shell|terminal|command|test|build|lint|typecheck|script)\b/i, prefixes: ['shell_', 'execute_', 'process_'] },
  { pattern: /\b(web|search|url|site|research|online)\b/i, prefixes: ['web_', 'open_url', 'youtube_'] },
  { pattern: /\b(browser|page|click|form|screenshot|accessibility)\b/i, prefixes: ['browser_'] },
  { pattern: /\b(memory|remember|preference|profile)\b/i, prefixes: ['memory_'] },
  { pattern: /\b(skill|workflow)\b/i, prefixes: ['skill', 'skills_'] },
  { pattern: /\b(session|history|previous conversation|recall)\b/i, prefixes: ['session_', 'recall_'] },
  { pattern: /\b(subagent|sub-agent|fanout|delegate|parallel agent)\b/i, prefixes: ['spawn_sub_agent', 'subagent_'] },
];

export function selectEconomyTools(tools: readonly ToolSchema[], task: string): EconomyToolSelection {
  const prefixes = new Set<string>();
  for (const hint of DOMAIN_HINTS) {
    if (hint.pattern.test(task)) for (const prefix of hint.prefixes) prefixes.add(prefix);
  }
  const confidence: EconomyToolSelection['confidence'] = prefixes.size >= 2
    ? 'high'
    : prefixes.size === 1 ? 'medium' : 'low';
  if (prefixes.size === 0) {
    for (const prefix of ['file_read', 'file_list', 'web_search', 'web_fetch', 'shell_exec']) {
      prefixes.add(prefix);
    }
  }
  const selected = tools.filter((tool) => (
    ALWAYS.has(tool.name)
    || [...prefixes].some((prefix) => tool.name === prefix || tool.name.startsWith(prefix))
  ));
  const safeSelected = selected.length > 0 ? selected : [...tools];
  const originalSchemaBytes = byteSize(tools);
  const selectedSchemaBytes = byteSize(safeSelected);
  return {
    selected: safeSelected,
    deferredCount: Math.max(0, tools.length - safeSelected.length),
    originalSchemaBytes,
    selectedSchemaBytes,
    estimatedSchemaSavings: Math.max(0, Math.ceil((originalSchemaBytes - selectedSchemaBytes) / 4)),
    confidence,
  };
}

export function classifyBudgetState(used: number, budget: number | null | undefined): BudgetLifecycleState {
  if (!budget || budget <= 0) return 'unbudgeted';
  const ratio = Math.max(0, used) / budget;
  if (ratio > 1) return 'over_budget_critical';
  if (ratio >= 1) return 'running_red';
  if (ratio >= 0.8) return 'running_yellow';
  return 'running_green';
}

export interface TaskUsageEstimate {
  complexity: 'small' | 'medium' | 'large';
  estimatedTokenLow: number;
  estimatedTokenHigh: number;
  estimatedCallsLow: number;
  estimatedCallsHigh: number;
  estimatedCostLow: number | null;
  estimatedCostHigh: number | null;
  costStatus: 'estimated' | 'unknown';
  confidence: 'high' | 'medium' | 'low';
  mainCostDrivers: string[];
  selectedMode: UsageMode;
  configuredBudget: number | null;
}

export interface TaskUsageEstimateInput {
  task: string;
  messages: readonly Message[];
  tools: readonly ToolSchema[];
  mode: UsageMode;
  tokenBudget?: number | null;
  pricing: { inputPerM: number; outputPerM: number } | null;
  expectedSubagents?: number;
}

export function estimateTaskUsage(input: TaskUsageEstimateInput): TaskUsageEstimate {
  const historyTokens = Math.ceil(byteSize(input.messages) / 4);
  const schemaTokens = Math.ceil(byteSize(input.tools) / 4);
  const taskWords = input.task.trim().split(/\s+/).filter(Boolean).length;
  const risky = /\b(browse|research|unknown|debug|failing|repository|subagent|fanout)\b/i.test(input.task);
  const toolLikely = /\b(read|write|edit|run|test|search|fetch|inspect|create|delete|build)\b/i.test(input.task);
  const subagents = Math.max(0, Math.floor(input.expectedSubagents ?? 0));
  const callsLow = 1 + (toolLikely ? 1 : 0) + subagents;
  const callsHigh = callsLow + (risky ? 3 : 1) + subagents;
  const modeMultiplier = input.mode === 'economy' ? 0.75 : input.mode === 'thorough' ? 1.4 : 1;
  const base = historyTokens + schemaTokens + Math.max(64, taskWords * 2);
  const low = Math.ceil((base + callsLow * 350) * modeMultiplier);
  const high = Math.ceil((base + callsHigh * (risky ? 1_500 : 800)) * modeMultiplier);
  const complexity = high < 4_000 ? 'small' : high < 15_000 ? 'medium' : 'large';
  const confidence = risky ? 'low' : toolLikely ? 'medium' : 'high';
  const drivers = [
    ...(schemaTokens > 500 ? ['tool schemas'] : []),
    ...(historyTokens > 1_000 ? ['conversation history'] : []),
    ...(toolLikely ? ['tool results'] : []),
    ...(risky ? ['retry and exploration risk'] : []),
    ...(subagents > 0 ? ['subagent calls'] : []),
  ];
  const outputShare = 0.2;
  const price = (tokens: number): number | null => input.pricing
    ? ((tokens * (1 - outputShare)) / 1_000_000) * input.pricing.inputPerM
      + ((tokens * outputShare) / 1_000_000) * input.pricing.outputPerM
    : null;
  return {
    complexity,
    estimatedTokenLow: low,
    estimatedTokenHigh: Math.max(low + 1, high),
    estimatedCallsLow: callsLow,
    estimatedCallsHigh: callsHigh,
    estimatedCostLow: price(low),
    estimatedCostHigh: price(high),
    costStatus: input.pricing ? 'estimated' : 'unknown',
    confidence,
    mainCostDrivers: drivers.length > 0 ? drivers : ['response generation'],
    selectedMode: input.mode,
    configuredBudget: input.tokenBudget && input.tokenBudget > 0 ? input.tokenBudget : null,
  };
}

export function parseUsageMode(value: unknown): UsageMode | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return normalized === 'economy' || normalized === 'balanced' || normalized === 'thorough'
    ? normalized
    : null;
}

function byteSize(value: unknown): number {
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8'); } catch { return 0; }
}
