/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
import type { SlashCommand, SlashCommandContext } from '../commandRegistry';
import type { JobRecord } from '../../../core/v4/daemon/jobEngine';

function recentJobs(ctx: SlashCommandContext, limit = 20): JobRecord[] {
  if (!ctx.jobEngine) return [];
  return ctx.jobEngine.listJobs({ sessionId: ctx.session?.getSessionId?.(), limit });
}

function targetJob(ctx: SlashCommandContext): JobRecord | null {
  if (!ctx.jobEngine) return null;
  const requested = ctx.args[0];
  return requested ? ctx.jobEngine.getJob(requested) : recentJobs(ctx, 1)[0] ?? null;
}

function snapshotFor(ctx: SlashCommandContext): ReturnType<NonNullable<SlashCommandContext['jobEngine']>['projection']['rebuild']> | null {
  const job = targetJob(ctx);
  return job && ctx.jobEngine ? ctx.jobEngine.projection.rebuild(job.id) : null;
}

function unavailable(ctx: SlashCommandContext): void {
  ctx.display.warn('Durable Job state is unavailable in this runtime.');
}

function value(row: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const candidate = row[key];
    if (candidate !== null && candidate !== undefined && String(candidate).length > 0) return String(candidate);
  }
  return 'unknown';
}

function renderJob(ctx: SlashCommandContext, job: JobRecord): void {
  const snapshot = ctx.jobEngine!.projection.rebuild(job.id);
  ctx.display.write(`\n◆ Job ${job.id}\n`);
  ctx.display.write(`  goal        ${job.goal}\n`);
  ctx.display.write(`  state       ${job.status}${job.terminalOutcome ? ` · ${job.terminalOutcome}` : ''}\n`);
  ctx.display.write(`  generation  ${Math.max(0, ...snapshot.attempts.map((attempt) => attempt.generation))}\n`);
  ctx.display.write(`  attempts    ${snapshot.attempts.length}\n`);
  ctx.display.write(`  effects     ${snapshot.effects.length}\n`);
  ctx.display.write(`  approvals   ${snapshot.approvals.length}\n`);
  ctx.display.write(`  evidence    ${snapshot.evidence.length}\n`);
  ctx.display.write(`  verdict     ${snapshot.verdict ? value(snapshot.verdict, 'outcome', 'verdict', 'state') : 'pending'}\n`);
  for (const attempt of snapshot.attempts) {
    const lease = attempt.leaseOwner ? ` · owner ${attempt.leaseOwner}` : '';
    ctx.display.write(`  └─ ${attempt.id} · ${attempt.status} · gen ${attempt.generation}${lease}\n`);
  }
}

export const jobs: SlashCommand = {
  name: 'jobs',
  description: 'Inspect durable Jobs, Attempts, Effects, and current outcomes.',
  category: 'system',
  icon: '◆',
  handler: async (ctx) => {
    if (!ctx.jobEngine) { unavailable(ctx); return {}; }
    const requested = ctx.args[0];
    if (!requested) {
      const rows = recentJobs(ctx);
      if (rows.length === 0) { ctx.display.dim('No durable Jobs for this session.'); return {}; }
      ctx.display.write('\n◆ Jobs\n');
      for (const job of rows) {
        const active = job.activeAttemptId ? ` · attempt ${job.activeAttemptId}` : '';
        const outcome = job.terminalOutcome ? ` · ${job.terminalOutcome}` : '';
        ctx.display.write(`  ${job.id} · ${job.status}${outcome}${active}\n`);
      }
      ctx.display.dim('Use /job <job-id> for Attempts, Effects, approvals, and verdict.');
      return {};
    }
    const job = ctx.jobEngine.getJob(requested);
    if (!job) { ctx.display.warn(`Job not found: ${requested}`); return {}; }
    renderJob(ctx, job);
    return {};
  },
};

export const job: SlashCommand = {
  name: 'job',
  description: 'Inspect one durable Job and its authoritative state.',
  category: 'system',
  icon: '◆',
  handler: async (ctx) => {
    if (!ctx.jobEngine) { unavailable(ctx); return {}; }
    const selected = targetJob(ctx);
    if (!selected) { ctx.display.warn(ctx.args[0] ? `Job not found: ${ctx.args[0]}` : 'No durable Job is available to inspect.'); return {}; }
    renderJob(ctx, selected);
    return {};
  },
};

export const attempts: SlashCommand = {
  name: 'attempts',
  description: 'Inspect durable Attempts for a Job.',
  category: 'system',
  icon: '↻',
  handler: async (ctx) => {
    if (!ctx.jobEngine) { unavailable(ctx); return {}; }
    const snapshot = snapshotFor(ctx);
    if (!snapshot) { ctx.display.dim('No durable Job is available to inspect.'); return {}; }
    ctx.display.write(`\n↻ Attempts · ${snapshot.job.id}\n`);
    for (const attempt of snapshot.attempts) {
      const lease = attempt.leaseOwner ? ` · lease ${attempt.leaseOwner}` : '';
      ctx.display.write(`  ${attempt.id} · ${attempt.status} · attempt ${attempt.attemptNumber} · gen ${attempt.generation}${lease}\n`);
    }
    if (snapshot.attempts.length === 0) ctx.display.dim('No durable Attempts.');
    return {};
  },
};

export const effects: SlashCommand = {
  name: 'effects',
  description: 'Inspect durable real-world Effects and reconciliation state.',
  category: 'system',
  icon: '⚙',
  handler: async (ctx) => {
    if (!ctx.jobEngine) { unavailable(ctx); return {}; }
    const snapshot = snapshotFor(ctx);
    if (!snapshot) { ctx.display.dim('No durable Job is available to inspect.'); return {}; }
    ctx.display.write(`\n⚙ Effects · ${snapshot.job.id}\n`);
    for (const effect of snapshot.effects) {
      ctx.display.write(`  ${value(effect, 'key', 'effect_id', 'id')} · ${value(effect, 'effect_state', 'state', 'status')} · ${value(effect, 'kind', 'effect_kind')} · retry ${value(effect, 'retry_safety', 'retrySafety')}\n`);
    }
    if (snapshot.effects.length === 0) ctx.display.dim('No durable Effects.');
    return {};
  },
};

export const evidence: SlashCommand = {
  name: 'evidence',
  description: 'Inspect durable evidence records without changing their verdict.',
  category: 'system',
  icon: '✓',
  handler: async (ctx) => {
    if (!ctx.jobEngine) { unavailable(ctx); return {}; }
    const snapshot = snapshotFor(ctx);
    if (!snapshot) { ctx.display.dim('No durable Job is available to inspect.'); return {}; }
    ctx.display.write(`\n✓ Evidence · ${snapshot.job.id}\n`);
    for (const item of snapshot.evidence) {
      ctx.display.write(`  ${value(item, 'evidence_id', 'id')} · ${value(item, 'verification_result', 'state')} · ${value(item, 'coverage')} · ${value(item, 'source')}\n`);
    }
    if (snapshot.evidence.length === 0) ctx.display.dim('No durable evidence.');
    return {};
  },
};

export const proof: SlashCommand = {
  name: 'proof',
  description: 'Inspect durable evidence, claims, and final verdict for a Job.',
  category: 'system',
  icon: '✓',
  handler: async (ctx) => {
    const job = targetJob(ctx);
    if (!ctx.jobEngine) { unavailable(ctx); return {}; }
    if (!job) { ctx.display.dim('No durable Job is available to inspect.'); return {}; }
    const snapshot = ctx.jobEngine.projection.rebuild(job.id);
    ctx.display.write(`\n✓ Proof · ${job.id}\n`);
    ctx.display.write(`  claims    ${snapshot.claims.length}\n`);
    ctx.display.write(`  evidence  ${snapshot.evidence.length}\n`);
    ctx.display.write(`  verdict   ${snapshot.verdict ? value(snapshot.verdict, 'outcome', 'verdict', 'state') : 'pending'}\n`);
    if (snapshot.verdict) {
      const reason = value(snapshot.verdict, 'reason', 'summary', 'finish_reason');
      if (reason !== 'unknown') ctx.display.write(`  reason    ${reason}\n`);
    }
    return {};
  },
};

export const approvals: SlashCommand = {
  name: 'approvals',
  description: 'Inspect exact-action approval records for durable Jobs.',
  category: 'system',
  icon: '!',
  handler: async (ctx) => {
    if (!ctx.jobEngine) { unavailable(ctx); return {}; }
    const requested = ctx.args[0];
    const jobsToInspect = requested
      ? [ctx.jobEngine.getJob(requested)].filter((job): job is JobRecord => job !== null)
      : recentJobs(ctx);
    const rows = jobsToInspect.flatMap((job) => (
      ctx.jobEngine!.projection.rebuild(job.id).approvals.map((approval) => ({ job, approval }))
    ));
    if (rows.length === 0) { ctx.display.dim('No durable approval records.'); return {}; }
    ctx.display.write('\n! Approvals\n');
    for (const { job, approval } of rows) {
      const id = value(approval, 'approval_id', 'id');
      const state = value(approval, 'state', 'status');
      const risk = value(approval, 'risk_level', 'risk');
      ctx.display.write(`  ${id} · ${state} · ${risk} · job ${job.id}\n`);
    }
    return {};
  },
};
