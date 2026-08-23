/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Read-only operator projection for durable A2A identities and RemoteTasks.
 * Agent Cards advertise capabilities; the shared external authority remains
 * the source of trust, recovery, quarantine, and local verification truth.
 */
import type { SlashCommand, SlashCommandContext } from '../commandRegistry';
import type { ExternalAuthority, RemoteTaskRecord } from '../../../core/v4/external/externalAuthority';

function externalAuthority(ctx: SlashCommandContext): ExternalAuthority | null {
  return ctx.jobEngine?.external ?? null;
}

function digestPrefix(value: string | null | undefined): string {
  return value ? `${value.slice(0, 12)}…` : 'not observed';
}

function renderAgents(ctx: SlashCommandContext, authority: ExternalAuthority): void {
  const identities = authority.listIdentities('a2a');
  ctx.display.write('\n◆ A2A agents · protocol 1.0 JSON-RPC · read-only preview\n');
  if (identities.length === 0) {
    ctx.display.dim('No A2A agents configured. The durable identity store is ready.');
  }
  for (const identity of identities) {
    const capabilities = authority.latestCapabilities(identity.externalIdentityId);
    const review = capabilities?.reviewRequired ? ' · review required' : '';
    const drift = capabilities?.changeClass ? ` · ${capabilities.changeClass}` : '';
    ctx.display.write(
      `  ${identity.displayName} · ${identity.trustState}${drift}${review}\n`
      + `    identity ${identity.externalIdentityId} · key ${digestPrefix(identity.observedIdentityKeyDigest)}\n`
      + `    endpoint ${identity.canonicalEndpoint}\n`,
    );
  }
  ctx.display.dim('Mutation delegation is disabled. Agent Card claims never grant authority.');
}

function renderTasks(ctx: SlashCommandContext, authority: ExternalAuthority): void {
  const tasks = authority.listRecoverableRemoteTasks();
  ctx.display.write('\n◆ A2A recoverable RemoteTasks\n');
  if (tasks.length === 0) {
    ctx.display.dim('No recoverable RemoteTasks.');
    return;
  }
  for (const task of tasks) {
    ctx.display.write(
      `  ${task.remoteTaskRecordId} · ${task.state} · local ${task.localJobId}/${task.localAttemptId}`
      + `${task.remoteTaskId ? ` · remote ${task.remoteTaskId}` : ''}\n`,
    );
  }
}

function renderTask(ctx: SlashCommandContext, authority: ExternalAuthority, task: RemoteTaskRecord): void {
  const identity = authority.getIdentity(task.externalIdentityId);
  const events = authority.listRemoteTaskEvents(task.remoteTaskRecordId);
  const artifacts = authority.listRemoteArtifacts(task.remoteTaskRecordId);
  ctx.display.write(`\n◆ RemoteTask ${task.remoteTaskRecordId}\n`);
  ctx.display.write(`  state        ${task.state}${task.locallyVerified ? ' · locally verified' : ' · not locally verified'}\n`);
  ctx.display.write(`  agent        ${identity?.displayName ?? task.externalIdentityId} · ${identity?.trustState ?? 'identity unavailable'}\n`);
  ctx.display.write(`  local        ${task.localJobId} · ${task.localAttemptId} · generation ${task.localGeneration}\n`);
  ctx.display.write(`  remote       ${task.remoteTaskId ?? 'not assigned'} · context ${task.remoteContextId ?? 'not assigned'}\n`);
  ctx.display.write(`  verification ${task.verificationId ?? 'pending'} · evidence ${task.evidenceIds.length}\n`);
  ctx.display.write('  events\n');
  for (const event of events) {
    ctx.display.write(`    ${event.remoteTaskEventId} · ${event.sequence} · ${event.kind} · ${event.taskState}\n`);
  }
  if (events.length === 0) ctx.display.write('    none\n');
  ctx.display.write('  artifacts\n');
  for (const artifact of artifacts) {
    ctx.display.write(
      `    ${artifact.remoteArtifactId} · ${artifact.declaredName} · ${artifact.quarantineState} · ${artifact.byteLength} bytes\n`,
    );
  }
  if (artifacts.length === 0) ctx.display.write('    none\n');
}

export const a2a: SlashCommand = {
  name: 'a2a',
  description: 'Inspect read-only A2A agents, trust, RemoteTasks, and quarantine state.',
  category: 'system',
  icon: '◆',
  handler: async (ctx) => {
    const authority = externalAuthority(ctx);
    if (!authority) {
      ctx.display.warn('A2A durable external authority is unavailable in this runtime.');
      return {};
    }
    const sub = (ctx.args[0] ?? 'agents').toLowerCase();
    if (sub === 'agents' || sub === 'list') {
      renderAgents(ctx, authority);
      return {};
    }
    if (sub === 'tasks') {
      renderTasks(ctx, authority);
      return {};
    }
    if (sub === 'agent') {
      const id = ctx.args[1];
      const identity = id ? authority.getIdentity(id) : null;
      if (!identity) {
        ctx.display.warn(id ? `A2A identity not found: ${id}` : 'Usage: /a2a agent <external-identity-id>');
        return {};
      }
      const capabilities = authority.latestCapabilities(identity.externalIdentityId);
      ctx.display.write(`\n◆ A2A agent ${identity.externalIdentityId}\n`);
      ctx.display.write(`  name         ${identity.displayName}\n`);
      ctx.display.write(`  endpoint     ${identity.canonicalEndpoint}\n`);
      ctx.display.write(`  trust        ${identity.trustState} · version ${identity.stateVersion}\n`);
      ctx.display.write(`  identity key ${digestPrefix(identity.observedIdentityKeyDigest)}\n`);
      ctx.display.write(`  protocol     ${capabilities?.protocolVersion ?? 'not observed'}\n`);
      ctx.display.write(`  capabilities ${capabilities?.changeClass ?? 'not observed'}${capabilities?.reviewRequired ? ' · review required' : ''}\n`);
      ctx.display.dim('Mutation delegation is disabled. Local policy and verification remain authoritative.');
      return {};
    }
    if (sub === 'task') {
      const id = ctx.args[1];
      const task = id ? authority.getRemoteTask(id) : null;
      if (!task) {
        ctx.display.warn(id ? `RemoteTask not found: ${id}` : 'Usage: /a2a task <remote-task-record-id>');
        return {};
      }
      renderTask(ctx, authority, task);
      return {};
    }
    ctx.display.warn(`Unknown /a2a subcommand: ${sub}. Use agents, agent, tasks, or task.`);
    return {};
  },
};
