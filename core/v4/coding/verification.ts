/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 */

import {
  structuredValidationPlanForShell,
  type StructuredValidationPlan,
  type StructuredValidationRun,
  type ValidationEnvironment,
  type ValidationExecutionResult,
} from '../codebase/structuredValidationAuthority';
import { normalizedArgsDigest } from '../daemon/jobExecutionContext';
import { externalCodingIdentity } from './identities';
import { externalCodingReconciliationTruth } from './mutationAuthority';
import { parseExternalCodingValidationCommand } from './validationExecutor';
import type { ExternalCodingAcceptanceCriterion } from './types';
import type {
  ExternalCodingClaimVerification,
  ExternalCodingVerificationContext,
  ExternalCodingVerificationResult,
} from './runtime';

const PRODUCER = 'external-coding-verifier';

export interface ExternalCodingValidationExecutionRequest {
  readonly command: string;
  readonly cwd: string;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}

export interface ExternalCodingValidationExecutor {
  execute(request: ExternalCodingValidationExecutionRequest): Promise<ValidationExecutionResult>;
}

export interface ExternalCodingVerifierDependencies {
  readonly executor: ExternalCodingValidationExecutor;
  readonly environment?: ValidationEnvironment;
}

interface CompletedValidation {
  readonly command: string;
  readonly run: StructuredValidationRun;
  readonly usable: boolean;
  readonly reasons: readonly string[];
  readonly output: string;
  readonly trustedOutputMarkers: readonly string[];
}

function pathIsAbsolute(value: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|[\\/]{1,2})/u.test(value);
}

function directNodeTestScript(command: string): string | null {
  try {
    const [program, script] = parseExternalCodingValidationCommand(command);
    if (!program || !script || !/^(?:node|node\.exe)$/iu.test(program)) return null;
    if (script.startsWith('-') || pathIsAbsolute(script) || script.split(/[\\/]/u).includes('..')) return null;
    if (!/(?:^|[\\/])[^\\/]*(?:test|spec)[^\\/]*\.(?:c|m)?js$/iu.test(script)) return null;
    return script.replace(/\\/gu, '/').replace(/^\.\//u, '');
  } catch {
    return null;
  }
}

function validationPlan(command: string, workingDirectory: string): StructuredValidationPlan | null {
  const shared = structuredValidationPlanForShell(command, workingDirectory);
  if (shared) return shared;
  return directNodeTestScript(command)
    ? { kind: 'test', command: command.trim(), workingDirectory, scope: 'focused' }
    : null;
}

function reconciledRepositoryInspection(command: string): boolean {
  try {
    const [program, operation] = parseExternalCodingValidationCommand(command);
    return /^(?:git|git\.exe)$/iu.test(program ?? '') && ['diff', 'status'].includes((operation ?? '').toLowerCase());
  } catch {
    return false;
  }
}

function requiredOutputMarkers(criterion: ExternalCodingAcceptanceCriterion): string[] {
  return [...new Set(criterion.statement.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/gu) ?? [])]
    .filter((value) => value.length <= 128);
}

function containsMarker(output: string, marker: string): boolean {
  return output.split(/[^A-Za-z0-9_]+/u).includes(marker);
}

async function trustedDirectNodeMarkers(
  context: ExternalCodingVerificationContext,
  command: string,
): Promise<string[]> {
  const script = directNodeTestScript(command);
  if (!script) return [];
  try {
    const [before, after] = await Promise.all([
      context.engine.repository.readFile(context.preSnapshotId, script),
      context.engine.repository.readFile(context.postSnapshotId, script),
    ]);
    if (before.encoding !== 'utf8' || after.encoding !== 'utf8'
      || typeof before.content !== 'string' || typeof after.content !== 'string'
      || before.fullContentHash !== after.fullContentHash) return [];
    return [...new Set(before.content.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/gu) ?? [])]
      .filter((value) => value.length <= 128);
  } catch {
    return [];
  }
}

function defaultEnvironment(): ValidationEnvironment {
  const npmVersion = process.env.npm_config_user_agent?.match(/(?:^|\s)npm\/([^\s]+)/u)?.[1] ?? 'unknown';
  return {
    platform: process.platform,
    architecture: process.arch,
    nodeVersion: process.version,
    npmVersion,
  };
}

function verificationState(
  admittedCommands: readonly string[],
  completed: readonly CompletedValidation[],
  unsupported: readonly string[],
): ExternalCodingClaimVerification['state'] {
  if (completed.some(({ run }) => ['failed', 'environment_failed', 'timed_out', 'cancelled'].includes(run.state))) {
    return 'failed';
  }
  if (admittedCommands.length === 0 || unsupported.length > 0 || completed.length !== admittedCommands.length) return 'unknown';
  return completed.every((item) => item.usable) ? 'verified' : 'unknown';
}

function normalizedPath(value: string): string {
  return value.trim().replace(/\\/gu, '/').replace(/^\.\//u, '').replace(/\/$/u, '').toLowerCase();
}

function statementMentionsPath(statement: string, candidate: string): boolean {
  const normalizedStatement = statement.replace(/\\/gu, '/').toLowerCase();
  const normalizedCandidate = normalizedPath(candidate);
  return normalizedCandidate.length > 0 && normalizedStatement.includes(normalizedCandidate);
}

function mutationVerificationState(
  context: ExternalCodingVerificationContext,
  criterion: ExternalCodingAcceptanceCriterion,
): ExternalCodingClaimVerification['state'] | null {
  const truth = externalCodingReconciliationTruth(context.mutation);
  const statement = criterion.statement.toLowerCase();
  const actualOutcomeKnown = truth.actualOutcomeKnown && context.processTreeSettled;
  const protectedCriterion = context.task.protectedPaths.some((value) => statementMentionsPath(statement, value))
    && /(?:unchanged|intact|protected|not\s+(?:change|modify|touch))/iu.test(statement);
  if (protectedCriterion) {
    if (!actualOutcomeKnown) return 'unknown';
    return truth.protectedPathsIntact ? 'verified' : 'failed';
  }

  const scopeCriterion = /\bonly\b/iu.test(statement)
    && /(?:change|changed|modif|file)/iu.test(statement)
    && context.task.allowedScope.some((value) => statementMentionsPath(statement, value));
  if (scopeCriterion) {
    if (!actualOutcomeKnown) return 'unknown';
    if (truth.actualChangedFiles.length === 0) return 'unknown';
    return truth.workspaceContained && truth.protectedPathsIntact ? 'verified' : 'failed';
  }

  const diffCriterion = /(?:\b(?:actual|reconciled|observed)\b.*\bdiff\b|\bdiff\b.*\b(?:provide|review|show)\b)/iu.test(statement);
  if (diffCriterion) {
    if (!actualOutcomeKnown) return 'unknown';
    if (!truth.workspaceContained || !truth.protectedPathsIntact) return 'failed';
    return context.mutation.changedPaths.length > 0 && context.mutation.observedDiffDigest
      ? 'verified'
      : 'unknown';
  }

  const forbiddenTerms = context.task.forbiddenOperations
    .map((value) => {
      const parts = value.split('.');
      return parts[parts.length - 1]?.replace(/_/gu, ' ').toLowerCase() ?? '';
    })
    .filter(Boolean);
  const forbiddenCriterion = forbiddenTerms.length > 0
    && forbiddenTerms.some((value) => statement.includes(value))
    && /(?:\bno\b|not\s+(?:perform|execute|run)|forbidden)/iu.test(statement);
  if (forbiddenCriterion) {
    if (!actualOutcomeKnown) return 'unknown';
    const gitMetadataChanged = [...context.mutation.protectedPathViolations, ...context.mutation.unexpectedPaths]
      .some((value) => normalizedPath(value).startsWith('.git'));
    if (gitMetadataChanged) return 'failed';
    if (forbiddenTerms.includes('push') && context.task.networkPolicy !== 'disabled') return 'unknown';
    return truth.workspaceContained && truth.protectedPathsIntact ? 'verified' : 'failed';
  }
  return null;
}

function directCommandVerificationState(
  context: ExternalCodingVerificationContext,
  criterion: ExternalCodingAcceptanceCriterion,
  completed: readonly CompletedValidation[],
): ExternalCodingClaimVerification['state'] | null {
  const statement = criterion.statement.toLowerCase().replace(/\s+/gu, ' ');
  if (!/(?:\bpass(?:es|ed)?\b|\bsucceed(?:s|ed)?\b|\bexits?\s+(?:successfully|with\s+(?:status|code)\s+0)\b)/iu.test(statement)) {
    return null;
  }
  const matching = completed.filter((item) => statement.includes(item.command.toLowerCase().replace(/\s+/gu, ' ')));
  if (matching.length === 0) return null;
  if (matching.some(({ run }) => ['failed', 'environment_failed', 'timed_out', 'cancelled'].includes(run.state))) {
    return 'failed';
  }
  if (!context.processTreeSettled) return 'unknown';
  return matching.every(({ run }) => run.state === 'succeeded' && run.sourceMutations.length === 0)
    ? 'verified'
    : 'unknown';
}

function criterionVerificationState(
  context: ExternalCodingVerificationContext,
  criterion: ExternalCodingAcceptanceCriterion,
  admittedCommands: readonly string[],
  completed: readonly CompletedValidation[],
  unsupported: readonly string[],
): ExternalCodingClaimVerification['state'] {
  const mutationState = mutationVerificationState(context, criterion);
  if (mutationState !== null) return mutationState;
  const markers = requiredOutputMarkers(criterion);
  if (markers.length > 0) {
    if (completed.some(({ run }) => ['failed', 'environment_failed', 'timed_out', 'cancelled'].includes(run.state))) {
      return 'failed';
    }
    const output = completed.map((item) => item.output).join('\n');
    const trusted = new Set(completed.flatMap((item) => item.trustedOutputMarkers));
    return markers.every((marker) => trusted.has(marker) && containsMarker(output, marker))
      && completed.every(({ run }) => run.state === 'succeeded' && run.sourceMutations.length === 0)
      ? 'verified'
      : 'unknown';
  }
  const commandState = directCommandVerificationState(context, criterion, completed);
  if (commandState !== null) return commandState;
  return verificationState(admittedCommands, completed, unsupported);
}

/**
 * Runs only the exact validation commands admitted in the durable task envelope.
 * Provider prose and provider exit status never participate in this verdict.
 */
export function createExternalCodingVerifier(
  dependencies: ExternalCodingVerifierDependencies,
): (context: ExternalCodingVerificationContext) => Promise<ExternalCodingVerificationResult> {
  return async (context) => {
    const completed: CompletedValidation[] = [];
    const admittedCommands: string[] = [];
    const reconciledInspectionCommands: string[] = [];
    const unsupported: string[] = [];
    const environment = dependencies.environment ?? defaultEnvironment();

    for (let index = 0; index < context.task.validationCommands.length; index += 1) {
      const command = context.task.validationCommands[index]!;
      const plan = validationPlan(command, context.workspace.worktreePath);
      if (!plan) {
        if (reconciledRepositoryInspection(command)) reconciledInspectionCommands.push(command);
        else unsupported.push(command);
        continue;
      }
      admittedCommands.push(command);
      const toolCallId = externalCodingIdentity('coding_validation_tool', {
        codingSessionId: context.codingSessionId,
        command,
        index,
      });
      const prior = context.engine.validation.getRunForToolCall(toolCallId);
      if (prior) {
        const currentSnapshot = context.engine.repository.getSnapshot(context.postSnapshotId);
        const sameCandidate = currentSnapshot?.stateDigest === prior.sourceStateDigest;
        const assessment = sameCandidate
          ? await context.engine.validation.assess(prior.runId, {
              repositorySnapshotId: prior.repositorySnapshotId,
              requiredScope: plan.scope,
            })
          : { usable: false, reasons: ['candidate_snapshot_mismatch'] };
        const logArtifact = prior.artifactIds
          .map((artifactId) => context.engine.validation.getArtifact(artifactId))
          .find((artifact) => artifact?.kind === 'log');
        completed.push({
          command,
          run: prior,
          usable: assessment.usable,
          reasons: assessment.reasons,
          output: logArtifact
            ? context.engine.validation.readLogArtifact(logArtifact.artifactId)
            : '',
          trustedOutputMarkers: sameCandidate
            ? await trustedDirectNodeMarkers(context, command)
            : [],
        });
        continue;
      }
      const prepared = context.engine.prepareToolCall({
        ...context.authority,
        toolCallId,
        toolName: 'shell_exec',
        normalizedArgsDigest: normalizedArgsDigest({ command, cwd: context.workspace.worktreePath }),
        riskTier: 'caution',
        mutates: true,
        producer: PRODUCER,
        effect: {
          classification: 'unsafe_mutation',
          kind: 'process.execute',
          target: command,
          retrySafety: 'never_automatic',
          idempotencySupported: false,
          idempotencyKey: null,
          reconciliationSupported: false,
          verificationSupported: true,
          approvalRequirement: 'policy',
          approvalState: 'not_required',
          sensitiveFields: ['command'],
          redactionRules: ['digest_arguments'],
          trusted: true,
        },
      });
      if (!prepared.effectId) throw new Error('External coding validation Effect was not created');
      context.engine.startToolCall({ ...context.authority, toolCallId, producer: PRODUCER });
      const started = context.engine.validation.start({
        ...context.authority,
        repositorySnapshotId: context.postSnapshotId,
        toolCallId,
        effectId: prepared.effectId,
        plan,
        environment,
        producer: PRODUCER,
      });
      let execution: ValidationExecutionResult;
      try {
        execution = await dependencies.executor.execute({
          command,
          cwd: context.workspace.worktreePath,
          signal: context.signal,
          timeoutMs: context.task.budgets.runtimeMs,
        });
      } catch (error) {
        context.engine.completeToolCall({
          ...context.authority,
          toolCallId,
          state: 'unknown',
          sideEffectState: 'unknown',
          resultRef: started.runId,
          producer: PRODUCER,
        });
        throw error;
      }
      const result = await context.engine.validation.complete({
        ...context.authority,
        runId: started.runId,
        execution,
        rawOutput: { stdout: execution.stdout, stderr: execution.stderr },
        producer: PRODUCER,
      });
      const assessment = await context.engine.validation.assess(result.run.runId, {
        repositorySnapshotId: context.postSnapshotId,
        requiredScope: plan.scope,
      });
      const terminalState = result.run.state === 'succeeded'
        ? 'completed'
        : result.run.state === 'cancelled' ? 'cancelled'
          : result.run.state === 'unknown' ? 'unknown' : 'failed';
      context.engine.completeToolCall({
        ...context.authority,
        toolCallId,
        state: terminalState,
        sideEffectState: terminalState === 'unknown' ? 'unknown' : 'committed',
        resultRef: result.run.runId,
        verificationRef: assessment.usable ? result.run.runId : null,
        producer: PRODUCER,
      });
      completed.push({
        command,
        run: result.run,
        usable: assessment.usable,
        reasons: assessment.reasons,
        output: `${execution.stdout}${execution.stderr ? `\n${execution.stderr}` : ''}`,
        trustedOutputMarkers: await trustedDirectNodeMarkers(context, command),
      });
    }

    const payloadFor = (criterion: ExternalCodingAcceptanceCriterion) => ({
      source: 'structured_validation',
      validationRuns: completed.map((item) => ({
        command: item.command,
        runId: item.run.runId,
        state: item.run.state,
        parseState: item.run.parseState,
        usable: item.usable,
        reasons: item.reasons,
      })),
      unsupportedCommands: unsupported,
      reconciledInspectionCommands,
      reconciliation: externalCodingReconciliationTruth(context.mutation),
      processTreeSettled: context.processTreeSettled,
      requiredOutputMarkers: requiredOutputMarkers(criterion).map((marker) => ({
        marker,
        observed: completed.some((item) => containsMarker(item.output, marker)),
        trustedSource: completed.some((item) => item.trustedOutputMarkers.includes(marker)),
      })),
      reason: context.task.validationCommands.length === 0 ? 'no_explicit_validation_commands' : undefined,
    });
    return {
      claims: context.task.acceptanceCriteria.map((criterion) => ({
        claimId: criterion.claimId,
        state: criterionVerificationState(
          context,
          criterion,
          admittedCommands,
          completed,
          unsupported,
        ),
        payload: payloadFor(criterion),
      })),
      validationRefs: completed.map((item) => item.run.runId),
    };
  };
}
