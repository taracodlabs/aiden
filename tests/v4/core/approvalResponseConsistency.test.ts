import { describe, expect, it } from 'vitest';

import type { HonestyTraceEntry } from '../../../moat/honestyEnforcement';
import {
  projectApprovalFacts,
  reconcileApprovalResponse,
} from '../../../core/v4/approvalResponseConsistency';

function gated(
  state: 'approved' | 'denied' | 'interrupted' | 'blocked',
  options: { error?: string; timeout?: boolean; name?: string } = {},
): HonestyTraceEntry {
  return {
    name: options.name ?? 'shell_exec',
    result: state === 'approved' && !options.error ? { exitCode: 0, stdout: 'ok' } : null,
    error: options.error,
    handlerMutates: true,
    approvalDecision: { state, approved: state === 'approved' },
    ...(options.timeout ? { classification: { category: 'timeout' } as never } : {}),
  };
}

describe('approval fact projection', () => {
  it('projects ordered gated decisions and execution independently', () => {
    const facts = projectApprovalFacts([
      gated('approved'),
      gated('denied', { name: 'file_delete', error: 'denied by approval engine' }),
      gated('approved', { name: 'file_write', error: 'disk full' }),
    ]);

    expect(facts).toMatchObject({
      occurred: true,
      totalEvents: 3,
      decisions: { allow: 2, deny: 1, interrupted: 0, timedOut: 0 },
      anyAllowed: true,
      anyDenied: true,
      anyInterrupted: false,
      allDenied: false,
      mixedDecision: true,
      executionOccurredAfterApproval: true,
    });
    expect(facts.events.map((event) => [event.id, event.decision, event.execution])).toEqual([
      ['trace:0:shell_exec', 'approved', 'succeeded'],
      ['trace:1:file_delete', 'denied', 'not_started'],
      ['trace:2:file_write', 'approved', 'failed'],
    ]);
    expect(Object.isFrozen(facts)).toBe(true);
    expect(Object.isFrozen(facts.events)).toBe(true);
  });

  it('projects exact batch operations without inventing dispatch approval facts', () => {
    const facts = projectApprovalFacts([{
      name: 'plan_approval',
      result: {
        status: 'partially_approved',
        approved: [{ tool: 'file_write', args: { path: 'kept.txt' }, required: true }],
        declined: [{ tool: 'file_delete', args: { path: 'old.txt' }, required: true }],
      },
      handlerMutates: false,
    }]);

    expect(facts).toMatchObject({ occurred: true, totalEvents: 2, mixedDecision: true });
    expect(facts.approvedOperations).toEqual(['file_write:kept.txt']);
    expect(facts.deniedOperations).toEqual(['file_delete:old.txt']);
  });

  it('keeps absent legacy metadata unknown', () => {
    const facts = projectApprovalFacts([{ name: 'shell_exec', result: { exitCode: 0 }, handlerMutates: true }]);
    expect(facts.occurred).toBe('unknown');
    expect(facts.executionOccurredAfterApproval).toBe('unknown');
  });

  it('proves no approval only for a complete trace with no approval-gated mutation', () => {
    expect(projectApprovalFacts([{ name: 'file_read', result: 'ok', handlerMutates: false }])).toMatchObject({
      occurred: false,
      totalEvents: 0,
    });
  });
});

describe('approval response reconciliation', () => {
  const allowed = projectApprovalFacts([gated('approved')]);

  it.each([
    'No approval modal was triggered by the runtime.',
    'The command executed without asking for approval.',
    'The user denied the command.',
  ])('corrects an incompatible allowed-and-executed claim: %s', (response) => {
    expect(reconcileApprovalResponse(response, allowed)).toBe(
      'The command was approved and executed successfully.',
    );
  });

  it('corrects false approval and execution after denial', () => {
    const facts = projectApprovalFacts([gated('denied', { error: 'denied by approval engine' })]);
    expect(reconcileApprovalResponse('The user approved the command and it completed.', facts)).toBe(
      'The command was denied and was not executed.',
    );
  });

  it('distinguishes interruption from denial', () => {
    const facts = projectApprovalFacts([gated('interrupted', { error: 'approval interrupted' })]);
    expect(reconcileApprovalResponse('The command was denied.', facts)).toBe(
      'The approval was interrupted, so the command was not executed.',
    );
  });

  it('keeps approval but corrects success when execution failed', () => {
    const facts = projectApprovalFacts([gated('approved', { error: 'exit code 1' })]);
    expect(reconcileApprovalResponse('The approved command completed successfully.', facts)).toBe(
      'The command was approved, but execution failed.',
    );
  });

  it('corrects success when approved execution timed out', () => {
    const facts = projectApprovalFacts([gated('approved', { error: 'timed out', timeout: true })]);
    expect(reconcileApprovalResponse('The approved command completed successfully.', facts)).toBe(
      'The command was approved, but execution timed out.',
    );
  });

  it('does not flatten mixed decisions', () => {
    const facts = projectApprovalFacts([
      gated('approved', { name: 'file_write' }),
      gated('denied', { name: 'file_delete', error: 'denied by approval engine' }),
    ]);
    expect(reconcileApprovalResponse('All operations were approved and completed.', facts)).toBe(
      'Only the approved operations were executed; the remaining operations were denied.',
    );
  });

  it('preserves unrelated useful prose while replacing only the contradiction', () => {
    const response = [
      'The report is at C:\\reports\\result.md.',
      'No approval modal was triggered by the runtime.',
      'You can open it with any Markdown viewer.',
    ].join(' ');
    expect(reconcileApprovalResponse(response, allowed)).toBe([
      'The report is at C:\\reports\\result.md.',
      'The command was approved and executed successfully.',
      'You can open it with any Markdown viewer.',
    ].join(' '));
  });

  it('leaves accurate no-approval prose unchanged when absence is proven', () => {
    const facts = projectApprovalFacts([{ name: 'file_read', result: 'ok', handlerMutates: false }]);
    const response = 'The read required no approval. The file contained three rows.';
    expect(reconcileApprovalResponse(response, facts)).toBe(response);
  });

  it('suppresses a strong absence claim when capture is unknown', () => {
    const facts = projectApprovalFacts([{ name: 'shell_exec', result: { exitCode: 0 }, handlerMutates: true }]);
    expect(reconcileApprovalResponse(
      'No approval was requested. The command returned three rows.',
      facts,
    )).toBe('The command returned three rows.');
  });

  it('preserves an execution permission error when approval capture is unknown', () => {
    const facts = projectApprovalFacts([{
      name: 'file_write',
      result: null,
      error: 'EACCES: permission denied',
      handlerMutates: true,
    }]);
    const response = 'I tried to write it but the operation failed — permission denied.';
    expect(reconcileApprovalResponse(response, facts)).toBe(response);
  });
});
