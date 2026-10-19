import http from 'node:http';
import { describe, expect, it } from 'vitest';
import { createSdkA2aRemoteClient } from '../../../core/v4/a2a/sdkClient';
import { normalizeA2aAgentCard } from '../../../core/v4/a2a/protocol';
import { localAccessFixture } from '../helpers/localAccess';

describe('A2A shared local approval at wire dispatch', () => {
  it.each(['revoked', 'expired', 'wrong-skill'])('retained clients send zero new requests/connections after %s', async mode => {
    let requests = 0, connections = 0, calls = 0;
    const server = http.createServer(async (req, res) => {
      requests++;
      let text = ''; for await (const chunk of req) text += chunk;
      const message = JSON.parse(text); calls++;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { task: {
        id: 'owned-task', contextId: 'owned-context', status: { state: 'TASK_STATE_COMPLETED' }, artifacts: [], history: [], metadata: {},
      } } }));
    });
    server.on('connection', () => connections++);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const grant = localAccessFixture(origin, ['a2a:SendMessage:read']);
    try {
      const card = normalizeA2aAgentCard({
        name: 'owned', description: 'owned fixture', version: '1',
        supportedInterfaces: [{ url: `${origin}/a2a`, protocolBinding: 'JSONRPC', protocolVersion: '1.0', tenant: '' }],
        capabilities: { streaming: false, pushNotifications: false, extensions: [] }, securitySchemes: {}, securityRequirements: [],
        defaultInputModes: ['application/json'], defaultOutputModes: ['application/json'], signatures: [],
        skills: [{ id: 'read', name: 'Read', description: 'Read', tags: ['read-only'], examples: [], inputModes: ['application/json'], outputModes: ['application/json'], securityRequirements: [] }],
      }, { allowLoopbackHttp: true });
      const client = await createSdkA2aRemoteClient(card, { allowLoopbackHttp: true });
      const input = { messageId: 'owned-message', skillId: 'read', payload: { serialized: '{}' } };
      await grant.run(async () => {
        expect((await client.sendReadOnly(input)).state).toBe('completed');
        expect(calls).toBe(1);
        const before = { requests, connections, calls };
        if (mode === 'revoked') grant.actions.invalidate(grant.binding.approvalId, 'owner revoked');
        if (mode === 'expired') grant.db.prepare('UPDATE approvals SET expires_at=1').run();
        await expect(client.sendReadOnly({ ...input, skillId: mode === 'wrong-skill' ? 'other' : 'read' })).rejects.toThrow();
        expect({ requests, connections, calls }).toEqual(before);
        console.log(JSON.stringify({ gate: `a2a-${mode}`, positiveCalls: 1, forbiddenRequests: requests-before.requests, forbiddenConnections: connections-before.connections, forbiddenCalls: calls-before.calls }));
      });
    } finally {
      grant.close(); server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
