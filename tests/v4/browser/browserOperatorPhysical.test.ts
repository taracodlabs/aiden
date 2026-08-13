import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { pwClose, pwListTabs } from '../../../core/playwrightBridge';
import { runWithAuthorizedBrowserSession } from '../../../core/v4/browser/browserExecutionScope';
import { runMigrations } from '../../../core/v4/daemon/db/migrations';
import { runWithJobExecutionContext } from '../../../core/v4/daemon/jobExecutionContext';
import { createJobEngine, type JobEngine } from '../../../core/v4/daemon/jobEngine';
import type { ToolContext, ToolHandler } from '../../../core/v4/toolRegistry';
import { browserClickTool } from '../../../tools/v4/browser/browserClick';
import { browserControlTool } from '../../../tools/v4/browser/browserControl';
import { browserDownloadTool } from '../../../tools/v4/browser/browserDownload';
import { browserExtractTool } from '../../../tools/v4/browser/browserExtract';
import { browserFillTool } from '../../../tools/v4/browser/browserFill';
import { browserNavigateTool } from '../../../tools/v4/browser/browserNavigate';
import { browserSnapshotTool } from '../../../tools/v4/browser/browserSnapshot';
import { browserUploadTool } from '../../../tools/v4/browser/browserUpload';

const physical = process.env.AIDEN_PHYSICAL_BROWSER === '1' ? describe : describe.skip;

physical('physical durable Browser Operator fixture', () => {
  let root = '';
  let baseUrl = '';
  let server: http.Server;
  let db: Database.Database;
  let engine: JobEngine;
  let jobContext: ReturnType<typeof admit>;
  const uploads: Array<{ name: string; sha256: string }> = [];
  const downloadBody = 'AIDEN_BROWSER_DOWNLOAD_SMOKE';

  function admit() {
    const admission = engine.submitJob({
      entryPoint: 'test', source: 'browser-physical', sessionId: 'browser-physical',
      workspaceId: root, instanceId: 'browser-physical', idempotencyNamespace: 'browser-physical',
      idempotencyKey: 'fixture', goal: 'exercise deterministic browser fixture',
    });
    const lease = engine.claimAttempt({ attemptId: admission.attemptId, ownerId: 'browser-physical', ttlMs: 120_000 });
    if (!lease.acquired || !lease.fenceToken || lease.generation === undefined) throw new Error('browser fixture lease');
    return {
      engine, jobId: admission.jobId, attemptId: admission.attemptId,
      generation: lease.generation, fenceToken: lease.fenceToken,
      producer: 'browser-physical', workspacePath: root,
    };
  }

  async function run(tool: ToolHandler, args: Record<string, unknown>) {
    return runWithJobExecutionContext(jobContext, () => tool.execute(args, { signal: undefined } as ToolContext)) as Promise<Record<string, any>>;
  }

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'aiden-browser-physical-'));
    process.env.AIDEN_HOME = root;
    process.env.AIDEN_BROWSER_PROFILE_DIR = path.join(root, 'browser-profile');
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    const now = Date.now();
    db.prepare(
      `INSERT INTO daemon_instances (instance_id,pid,hostname,started_at,last_heartbeat,version)
       VALUES ('browser-physical',1,'localhost',?,?, '4.19.1')`,
    ).run(now, now);
    engine = createJobEngine({ db });
    jobContext = admit();
    server = http.createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/download') {
        response.writeHead(200, {
          'content-type': 'text/plain',
          'content-disposition': 'attachment; filename="browser-download-smoke.txt"',
        });
        response.end(downloadBody);
        return;
      }
      if (url.pathname === '/upload-record' && request.method === 'POST') {
        const chunks: Buffer[] = [];
        request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        request.on('end', () => {
          const body = Buffer.concat(chunks);
          uploads.push({
            name: String(request.headers['x-filename'] ?? ''),
            sha256: createHash('sha256').update(body).digest('hex'),
          });
          response.writeHead(204).end();
        });
        return;
      }
      if (url.pathname === '/product-b') {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end('<!doctype html><title>Product B</title><main><h1>Product B</h1><p id="price">Price: INR 42</p></main>');
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(`<!doctype html><html><head><title>Browser Fixture</title></head><body>
        <main><h1>Deterministic Browser Fixture</h1>
          <a id="product-link" href="/product-b">Product B</a>
          <button id="spa" onclick="document.querySelector('#spa-state').textContent='Profile draft active'">Open Profile</button>
          <p id="spa-state">Settings</p>
          <form id="profile"><label>Name <input id="name" name="name" required></label>
            <label>Country <select id="country"><option>Estonia</option><option>India</option></select></label>
            <label><input id="subscribe" type="checkbox"> Subscribe</label>
            <input id="upload" type="file">
          </form>
          <a id="download" href="/download" download>Download fixture</a>
          <a id="popup" href="/product-b" target="_blank">Open details in new tab</a>
        </main>
        <script>
          document.querySelector('#upload').addEventListener('change', async (event) => {
            const file = event.target.files[0];
            if (file) await fetch('/upload-record', { method: 'POST', headers: { 'x-filename': file.name }, body: await file.arrayBuffer() });
          });
        </script></body></html>`);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fixture address');
    baseUrl = `http://127.0.0.1:${address.port}`;
  }, 30_000);

  afterAll(async () => {
    await pwClose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    await fs.rm(root, { recursive: true, force: true });
    delete process.env.AIDEN_BROWSER_PROFILE_DIR;
  }, 30_000);

  it('navigates, verifies SPA and form state, transfers files, and keeps tab ownership bounded', async () => {
    expect(await run(browserNavigateTool, { url: baseUrl })).toMatchObject({ success: true });
    const initial = await run(browserSnapshotTool, {});
    expect(initial).toMatchObject({ success: true });
    expect(initial.forms).toEqual(expect.arrayContaining([
      expect.objectContaining({ fields: expect.arrayContaining([expect.objectContaining({ label: 'Name' })]) }),
    ]));

    expect(await run(browserFillTool, { fields: { '#name': 'Browser Smoke' } }))
      .toMatchObject({ success: true, verified: true });
    expect(await run(browserControlTool, { selector: '#country', operation: 'select', value: 'India' }))
      .toMatchObject({ success: true, verified: true });
    expect(await run(browserControlTool, { selector: '#subscribe', operation: 'check' }))
      .toMatchObject({ success: true, verified: true, checked: true });
    expect(await run(browserClickTool, { selector: '#spa' }))
      .toMatchObject({ success: true });
    expect(await run(browserExtractTool, {})).toMatchObject({ success: true, text: expect.stringContaining('Profile draft active') });

    const uploadPath = path.join(root, 'browser-upload-smoke.txt');
    const uploadBody = 'AIDEN_BROWSER_UPLOAD_SMOKE';
    await fs.writeFile(uploadPath, uploadBody);
    expect(await run(browserUploadTool, { selector: '#upload', paths: [uploadPath] }))
      .toMatchObject({ success: true, verified: true, files: ['browser-upload-smoke.txt'] });
    await vi.waitFor(() => expect(uploads).toEqual([{
      name: 'browser-upload-smoke.txt',
      sha256: createHash('sha256').update(uploadBody).digest('hex'),
    }]));

    const downloaded = await run(browserDownloadTool, { selector: '#download' });
    expect(downloaded).toMatchObject({
      success: true, verified: true, filename: 'browser-download-smoke.txt',
      sha256: createHash('sha256').update(downloadBody).digest('hex'),
    });
    expect(await fs.readFile(downloaded.path, 'utf8')).toBe(downloadBody);

    expect(await run(browserClickTool, { selector: '#popup' })).toMatchObject({ success: true });
    const tabs = await runWithJobExecutionContext(jobContext, () =>
      runWithAuthorizedBrowserSession(undefined, () => pwListTabs()),
    );
    expect(tabs.ok).toBe(true);
    expect(tabs.tabs).toHaveLength(2);
    expect(tabs.tabs.every((tab) => tab.browserSessionId === engine.browser.getSessionForAttempt(
      jobContext.jobId, jobContext.attemptId, jobContext.generation,
    )?.browserSessionId)).toBe(true);

    const receipts = db.prepare('SELECT state FROM browser_action_receipts ORDER BY action_sequence').all() as Array<{ state: string }>;
    expect(receipts.length).toBeGreaterThanOrEqual(10);
    expect(receipts.every((receipt) => !['prepared', 'dispatched'].includes(receipt.state))).toBe(true);
    expect(engine.proof.listEvidence(jobContext.jobId).length).toBeGreaterThan(0);
  }, 60_000);
});
