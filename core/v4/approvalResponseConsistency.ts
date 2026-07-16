/**
 * Read-only projection of approval and execution facts already present in a
 * turn trace, plus narrow reconciliation of contradictory approval narration.
 */
import type { HonestyTraceEntry } from '../../moat/honestyEnforcement';

export type ApprovalOccurrence = boolean | 'unknown';
export type ApprovalExecution = 'succeeded' | 'failed' | 'timed_out' | 'not_started' | 'unknown';

export interface ApprovalFactEvent {
  readonly id: string;
  readonly tool: string;
  readonly decision: 'approved' | 'denied' | 'interrupted' | 'blocked';
  readonly execution: ApprovalExecution;
}

export interface ApprovalFacts {
  readonly occurred: ApprovalOccurrence;
  readonly totalEvents: number;
  readonly decisions: Readonly<{
    allow: number;
    deny: number;
    interrupted: number;
    timedOut: number;
  }>;
  readonly anyAllowed: boolean;
  readonly anyDenied: boolean;
  readonly anyInterrupted: boolean;
  readonly allDenied: boolean;
  readonly mixedDecision: boolean;
  readonly executionOccurredAfterApproval: boolean | 'unknown';
  readonly approvedOperations: readonly string[];
  readonly deniedOperations: readonly string[];
  readonly events: readonly ApprovalFactEvent[];
}

function executionFor(entry: HonestyTraceEntry): ApprovalExecution {
  const state = entry.approvalDecision?.state;
  if (state === 'denied' || state === 'interrupted' || state === 'blocked') return 'not_started';
  if (entry.classification?.category === 'timeout' || /timed?\s*out|timeout/i.test(entry.error ?? '')) {
    return 'timed_out';
  }
  if (entry.error) return 'failed';
  if (state === 'approved') return 'succeeded';
  return 'unknown';
}

function operationId(value: unknown, fallback: string): string {
  if (!value || typeof value !== 'object') return fallback;
  const operation = value as Record<string, unknown>;
  const tool = typeof operation.tool === 'string' ? operation.tool : 'operation';
  const args = operation.args && typeof operation.args === 'object'
    ? operation.args as Record<string, unknown>
    : {};
  const target = ['path', 'from', 'to', 'url'].map((key) => args[key]).find((v) => typeof v === 'string');
  return `${tool}:${typeof target === 'string' ? target : fallback}`;
}

function batchEvents(entry: HonestyTraceEntry, traceIndex: number): ApprovalFactEvent[] {
  if (entry.name !== 'plan_approval' || !entry.result || typeof entry.result !== 'object') return [];
  const result = entry.result as Record<string, unknown>;
  const events: ApprovalFactEvent[] = [];
  for (const [decision, key] of [['approved', 'approved'], ['denied', 'declined']] as const) {
    const operations = result[key];
    if (!Array.isArray(operations)) continue;
    operations.forEach((operation, operationIndex) => {
      const fallback = `trace:${traceIndex}:${key}:${operationIndex}`;
      events.push(Object.freeze({
        id: operationId(operation, fallback),
        tool: operation && typeof operation === 'object' && typeof (operation as Record<string, unknown>).tool === 'string'
          ? String((operation as Record<string, unknown>).tool)
          : 'operation',
        decision,
        // plan_approval only records intent. A later tool trace proves execution.
        execution: 'unknown',
      }));
    });
  }
  return events;
}

export function projectApprovalFacts(trace: readonly HonestyTraceEntry[]): ApprovalFacts {
  const events: ApprovalFactEvent[] = [];
  let incompleteMutation = false;

  trace.forEach((entry, index) => {
    if (entry.approvalDecision) {
      events.push(Object.freeze({
        id: `trace:${index}:${entry.name}`,
        tool: entry.name,
        decision: entry.approvalDecision.state,
        execution: executionFor(entry),
      }));
    } else {
      events.push(...batchEvents(entry, index));
      if (entry.handlerMutates === true) incompleteMutation = true;
    }
  });

  const allow = events.filter((event) => event.decision === 'approved').length;
  const deny = events.filter((event) => event.decision === 'denied' || event.decision === 'blocked').length;
  const interrupted = events.filter((event) => event.decision === 'interrupted').length;
  const timedOut = events.filter((event) => event.execution === 'timed_out').length;
  const terminalKinds = Number(allow > 0) + Number(deny > 0) + Number(interrupted > 0);
  const knownExecution = events.filter((event) => event.decision === 'approved');
  const executionOccurredAfterApproval = knownExecution.length === 0
    ? (events.length === 0 ? (incompleteMutation ? 'unknown' : false) : false)
    : knownExecution.some((event) => event.execution !== 'not_started' && event.execution !== 'unknown')
      ? true
      : knownExecution.every((event) => event.execution === 'not_started') ? false : 'unknown';
  const occurred: ApprovalOccurrence = events.length > 0 ? true : incompleteMutation ? 'unknown' : false;
  const decisions = Object.freeze({ allow, deny, interrupted, timedOut });
  const approvedOperations = Object.freeze(events.filter((event) => event.decision === 'approved').map((event) => event.id));
  const deniedOperations = Object.freeze(events.filter((event) => event.decision === 'denied' || event.decision === 'blocked').map((event) => event.id));
  const frozenEvents = Object.freeze([...events]);

  return Object.freeze({
    occurred,
    totalEvents: events.length,
    decisions,
    anyAllowed: allow > 0,
    anyDenied: deny > 0,
    anyInterrupted: interrupted > 0,
    allDenied: deny > 0 && allow === 0 && interrupted === 0,
    mixedDecision: terminalKinds > 1,
    executionOccurredAfterApproval,
    approvedOperations,
    deniedOperations,
    events: frozenEvents,
  });
}

const APPROVAL_TERM = /\b(?:approv(?:al|ed)|allow(?:ed)?|den(?:y|ied)|declin(?:e|ed)|refus(?:e|ed)|permission|modal|prompt(?:ed|ing)?|block(?:ed)?)\b/i;
const ABSENCE_CLAIM = /\b(?:no\s+approval|without\s+(?:asking\s+for\s+)?approval|approval\s+(?:was\s+)?(?:not\s+(?:requested|required)|bypassed)|did\s+not\s+prompt)\b/i;
const ALLOW_CLAIM = /\b(?:approv(?:al\s+was\s+granted|ed)|allow(?:ed)?|permission\s+(?:was\s+)?granted)\b/i;
const DENY_CLAIM = /\b(?:den(?:y|ied)|declin(?:e|ed)|refus(?:e|ed)|blocked\s+by\s+approval)\b/i;
const INTERRUPT_CLAIM = /\b(?:interrupt(?:ed|ion)?|cancel(?:led|ed)?\s+(?:at|during)\s+approval)\b/i;
const SUCCESS_CLAIM = /\b(?:executed|completed|succeeded|ran\s+successfully)\b/i;
const ALL_CLAIM = /\b(?:all|every)\b/i;
const EXPLICIT_APPROVAL_CLAIM = /\b(?:approval|approval\s+modal|approval\s+prompt|user\s+(?:approved|allowed|denied|declined|refused)|(?:command|operation|request)\s+(?:was\s+)?(?:approved|allowed|denied|declined))\b/i;

function deterministicCorrection(facts: ApprovalFacts): string {
  if (facts.mixedDecision) {
    return facts.executionOccurredAfterApproval === true
      ? 'Only the approved operations were executed; the remaining operations were denied.'
      : 'Some operations were approved and others were denied; successful execution was not confirmed.';
  }
  if (facts.anyInterrupted) {
    return 'The approval was interrupted, so the command was not executed.';
  }
  if (facts.allDenied) {
    return 'The command was denied and was not executed.';
  }
  if (facts.anyAllowed) {
    const executions = facts.events
      .filter((event) => event.decision === 'approved')
      .map((event) => event.execution);
    if (executions.some((state) => state === 'timed_out')) return 'The command was approved, but execution timed out.';
    if (executions.some((state) => state === 'failed')) return 'The command was approved, but execution failed.';
    if (executions.every((state) => state === 'succeeded')) return 'The command was approved and executed successfully.';
    return 'The command was approved, but successful execution was not confirmed.';
  }
  return '';
}

function contradicts(sentence: string, facts: ApprovalFacts): boolean {
  if (facts.occurred === 'unknown') return EXPLICIT_APPROVAL_CLAIM.test(sentence) || ABSENCE_CLAIM.test(sentence);
  if (facts.occurred === false) return APPROVAL_TERM.test(sentence) && !ABSENCE_CLAIM.test(sentence);
  if (ABSENCE_CLAIM.test(sentence)) return true;
  if (facts.mixedDecision && ALL_CLAIM.test(sentence) && (ALLOW_CLAIM.test(sentence) || DENY_CLAIM.test(sentence) || SUCCESS_CLAIM.test(sentence))) return true;
  if (facts.anyInterrupted && !facts.anyAllowed && !facts.anyDenied) return DENY_CLAIM.test(sentence) || ALLOW_CLAIM.test(sentence) || SUCCESS_CLAIM.test(sentence);
  if (facts.allDenied) return ALLOW_CLAIM.test(sentence) || SUCCESS_CLAIM.test(sentence) || INTERRUPT_CLAIM.test(sentence);
  if (facts.anyAllowed && !facts.anyDenied && !facts.anyInterrupted) {
    if (DENY_CLAIM.test(sentence) || INTERRUPT_CLAIM.test(sentence)) return true;
    const failed = facts.events.some((event) => event.execution === 'failed' || event.execution === 'timed_out');
    return failed && SUCCESS_CLAIM.test(sentence);
  }
  return false;
}

function sentences(response: string): string[] {
  const Segmenter = (Intl as unknown as {
    Segmenter: new (locale: string, options: { granularity: 'sentence' }) => {
      segment(input: string): Iterable<{ segment: string }>;
    };
  }).Segmenter;
  return Array.from(
    new Segmenter('en', { granularity: 'sentence' }).segment(response),
    ({ segment }) => segment,
  );
}

export function reconcileApprovalResponse(response: string, facts: ApprovalFacts): string {
  if (!response.trim()) return response;
  const parts = sentences(response);
  const incompatible = parts.map((part) => contradicts(part.trim(), facts));
  if (!incompatible.some(Boolean)) return response;

  const correction = facts.occurred === 'unknown' || facts.occurred === false
    ? ''
    : deterministicCorrection(facts);
  let inserted = false;
  const reconciled = parts.flatMap((part, index) => {
    if (!incompatible[index]) return [part];
    if (!inserted && correction) {
      inserted = true;
      const leading = part.match(/^\s*/)?.[0] ?? '';
      const trailing = part.match(/\s*$/)?.[0] ?? '';
      return [`${leading}${correction}${trailing}`];
    }
    return [];
  });
  return reconciled.join('').trim();
}
