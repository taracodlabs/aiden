/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/index.ts — Tool registration helper.
 *
 * `registerReadOnlyTools(registry)` wires every Phase 7 read-only
 * wrapper.
 * `registerWriteTools(registry)` wires every Phase 8 write/execute
 * wrapper.
 * `registerAllTools(registry)` does both — call once at boot, after
 * the registry is created and before `AidenAgent` is constructed.
 *
 * Phase 9 layers the approval engine on top: every wrapper with
 * `mutates: true` is gated before its `execute` runs.
 *
 * Status: PHASE 8.
 */

import type { ToolHandler, ToolRegistry } from '../../core/v4/toolRegistry';
import { withDryRun } from '../../core/v4/dryRun';

import { webSearchTool } from './web/webSearch';
import { webFetchTool } from './web/webFetch';
import { webPageTool } from './web/webPage';
import { deepResearchTool } from './web/deepResearch';
import { openUrlTool } from './web/openUrl';
import { youtubeSearchTool } from './web/youtubeSearch';

import { fileReadTool } from './files/fileRead';
import { fileListTool } from './files/fileList';
import { fileWriteTool } from './files/fileWrite';
import { filePatchTool } from './files/filePatch';
import { fileDeleteTool } from './files/fileDelete';
import { fileMoveTool } from './files/fileMove';
import { readPdfTool } from './files/readPdf';
import { planApprovalTool } from './approval/planApproval';
import { fileCopyTool } from './files/fileCopy';

import { browserScreenshotTool } from './browser/browserScreenshot';
import { browserSnapshotTool } from './browser/browserSnapshot';
import { browserSeeTool } from './browser/browserSee';
import { browserExtractTool } from './browser/browserExtract';
import { browserGetUrlTool } from './browser/browserGetUrl';
import { browserNavigateTool } from './browser/browserNavigate';
import { browserClickTool } from './browser/browserClick';
import { browserTypeTool } from './browser/browserType';
import { browserFillTool } from './browser/browserFill';
import { browserScrollTool } from './browser/browserScroll';
import { browserCloseTool } from './browser/browserClose';
import { browserDialogTool } from './browser/browserDialog';
import { browserUploadTool } from './browser/browserUpload';

import { sessionSearchTool } from './sessions/sessionSearch';
import { sessionListTool } from './sessions/sessionList';
import { recallSessionTool } from './sessions/recallSession';

import { skillsListTool } from './skills/skillsList';
import { skillViewTool } from './skills/skillView';
import { skillManageTool } from './skills/skillManage';
import { makeLookupToolSchema } from './skills/lookupToolSchema';
import { makeToolBridge } from './skills/toolBridge';

import { systemInfoTool } from './system/systemInfo';
import { nowPlayingTool } from './system/nowPlaying';
import { naturalEventsTool } from './system/naturalEvents';
// Phase v4.1.2-followup-3 computer-control bundle.
import { screenshotTool } from './system/screenshot';
import { osProcessListTool } from './system/osProcessList';
import { mediaKeyTool } from './system/mediaKey';
import { volumeSetTool } from './system/volumeSet';
import { appLaunchTool } from './system/appLaunch';
import { appCloseTool } from './system/appClose';
import { clipboardReadTool } from './system/clipboardRead';
import { clipboardWriteTool } from './system/clipboardWrite';
// v4.1.4-media — three-layer media-control bundle.
// Layer 2 (OS media session): mediaSessions (read) + mediaTransport (write).
// Layer 3 fallback (mediaKey, blind keystroke) remains unchanged.
// Layer 1 (semantic API) is per-app and out of this slice.
import { mediaSessionsTool } from './system/mediaSessions';
import { mediaTransportTool } from './system/mediaTransport';
import { appInputTool } from './system/appInput';
// Phase v4.1.2-update — natural-language self-update entry point.
// Routes through the same shared executeInstall executor as `/update install`.
import { aidenSelfUpdateTool } from './system/aidenSelfUpdate';

import { shellExecTool } from './terminal/shellExec';
import { executeCodeTool } from './executeCode';

import { processSpawnTool } from './process/processSpawn';
import { processListTool } from './process/processList';
import { processLogReadTool } from './process/processLogRead';
import { processKillTool } from './process/processKill';
import { processWaitTool } from './process/processWait';

import { memoryAddTool } from './memory/memoryAdd';
import { memoryReplaceTool } from './memory/memoryReplace';
import { memoryRemoveTool } from './memory/memoryRemove';
import { sessionSummaryTool } from './memory/sessionSummary';

import {
  makeSubagentFanoutTool,
  type SubagentFanoutFactoryOptions,
} from './subagent/subagentFanout';
// v4.6 Phase 1 — spawn_sub_agent stub registered alongside the
// fanout stub so the schema is visible at agent construction.
import { makeSpawnSubAgentStub } from './subagent/spawnSubAgentTool';
import { makeClarifyTool } from './clarify/clarifyTool';

/**
 * Register every read-only tool into `registry`. The
 * `lookup_tool_schema` tool needs a registry reference, so it's
 * registered LAST (after every other tool, so it can introspect
 * the full set).
 */
export function registerReadOnlyTools(registry: ToolRegistry): void {
  // v4.4 Phase 4 — every handler is funneled through withDryRun so
  // AIDEN_DRYRUN=1 short-circuits `execute` to a preview. Read-only
  // tools pass through unchanged (the HOC returns the handler as-is
  // when `mutates: false`); the wrapper is cheap (`if (!mutates)
  // return handler`) and keeps the registration call sites uniform
  // across read/write tool sets.
  const register = (h: ToolHandler): void => registry.register(withDryRun(h));
  register(webSearchTool);
  register(webFetchTool);
  register(webPageTool);
  register(deepResearchTool);
  // Phase 16f: open_url uses shell launch (start chrome / open / xdg-open)
  // for "open X in browser" requests — bypasses Playwright detection.
  register(openUrlTool);
  // Phase 23.4a: youtube_search returns real /watch?v= URLs scraped
  // from youtube.com/results. media-search uses it before open_url so
  // the URL provenance gate has a candidate set to validate against —
  // closes the URL-hallucination failure mode where the model invented
  // 11-char IDs.
  register(youtubeSearchTool);

  register(fileReadTool);
  register(fileListTool);

  register(browserScreenshotTool);
  register(browserSnapshotTool);
  register(browserSeeTool);
  register(browserExtractTool);
  register(browserGetUrlTool);

  register(sessionSearchTool);
  register(sessionListTool);
  // Phase v4.1.2-memory-C: recall_session reads SessionDistillation
  // files written by Phase A+B. Sits alongside session_search — the
  // two have distinct purposes (FTS5-over-messages vs ranked
  // distillation summaries); descriptions force the right model
  // choice.
  register(recallSessionTool);

  register(skillsListTool);
  register(skillViewTool);

  register(systemInfoTool);
  register(nowPlayingTool);
  register(naturalEventsTool);

  // Phase v4.1.2-followup-3 — computer-control read-only tools.
  register(screenshotTool);
  register(osProcessListTool);
  register(clipboardReadTool);
  // v4.1.4-media — GSMTC session enumeration (read). Pair with
  // mediaTransport (write) in the write-tools registration below.
  register(mediaSessionsTool);

  register(makeLookupToolSchema(registry));
  // v4.12 OM.2 — the deferred-tool search bridge (tool_search + tool_call).
  // toolset:'bridge' → excluded from normal assembly; injected only by
  // applyToolDeferral when mcp schema cost crosses the threshold.
  for (const h of makeToolBridge(registry)) register(h);

  // Phase v4.1-subagent — register a stub for subagent_fanout so its
  // schema is visible to the agent loop, the MCP server, and the
  // /tools slash command BEFORE the runtime resolves provider /
  // adapter / agent dependencies. The full runtime calls
  // `register(makeSubagentFanoutTool({...real opts}))` to
  // replace this stub once `buildAgentRuntime` has those handles.
  // Until then, calling the stub returns a clear "not wired" error
  // rather than crashing.
  register(makeSubagentFanoutStub());

  // v4.6 Phase 1 — register a stub for spawn_sub_agent. Same
  // rationale: agent construction at `cli/v4/aidenCLI.ts` snapshots
  // the tool array, so the schema must be in the registry by then.
  // The REPL wiring at `buildAgentRuntime` calls
  // `register(makeSpawnSubAgentTool({...real deps}))` to replace
  // this stub once `parentAgent`, `runStore`, etc. are available.
  // The stub carries `contexts: ['repl']` so it's excluded from the
  // daemon agent's tool catalog via `getSchemas(_, 'daemon')`.
  register(makeSpawnSubAgentStub());
}

/** Stub used until the runtime wires real provider / adapter / agent
 *  dependencies. Returns the SAME schema as the real tool so MCP and
 *  /tools see a consistent surface. */
function makeSubagentFanoutStub() {
  // v4.11 Slice 4 — the stub returns the "tool not wired" error on
  // every call because `resolveProviders: () => []` makes the
  // facade short-circuit before ever touching the coordinator. The
  // coordinator + turn context resolvers are minimal placeholders
  // — they never run since the providers check fires first.
  // Production wiring (`cli/v4/aidenCLI.ts` for REPL,
  // `cli/v4/commands/mcp.ts` for MCP serve) replaces this stub with
  // a fully-wired registration after `buildAgentRuntime` resolves
  // the real deps.
  return makeSubagentFanoutTool({
    resolveTurnContext: () => undefined,
    coordinator:        {
      // Bare-minimum shape — only the methods the facade's hot path
      // would touch. Since `resolveProviders` returns [] first, the
      // facade short-circuits before any coordinator method runs.
      // The cast is intentional: the stub IS unreachable scaffolding.
      spawnBatch:         async () => ({
        fanoutId:        'stub',
        status:          'failed',
        results:         [],
        aggregateUsage:  { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUSD: 0 },
        traceId:         'stub',
        startedAt:       Date.now(),
        endedAt:         Date.now(),
        durationMs:      0,
      }),
      cancelChild:        () => false,
      listActiveChildren: () => [],
    } as unknown as import('../../core/v4/subagent/coordinator').SubagentCoordinator,
    resolveProviders:    () => [],
    resolveActiveModel:  () => ({ providerId: 'unset', modelId: 'unset' }),
    aggregatorAdapter:   {
      apiMode: 'chat_completions',
      async call() {
        throw new Error(
          'subagent_fanout: tool not wired — runtime did not replace the stub. ' +
          'Call register(makeSubagentFanoutTool({...})) after buildAgentRuntime.',
        );
      },
    },
  });
}

/**
 * Register every Phase 8 write/execute tool. Phase 9 will gate
 * every `mutates: true` handler in this set behind the approval
 * engine — the registration order doesn't matter for that.
 */
export function registerWriteTools(registry: ToolRegistry): void {
  // v4.4 Phase 4 — same withDryRun wrap as registerReadOnlyTools.
  // Write tools are where the preview path is actually hot — when
  // AIDEN_DRYRUN=1, each handler's `buildPreview` is called instead
  // of `execute`.
  const register = (h: ToolHandler): void => registry.register(withDryRun(h));
  register(fileWriteTool);
  register(filePatchTool);
  register(fileDeleteTool);
  // v4.13 Phase D — Downloads-demo primitives.
  register(readPdfTool);
  register(planApprovalTool);
  register(fileMoveTool);
  register(fileCopyTool);

  register(shellExecTool);

  register(browserNavigateTool);
  register(browserClickTool);
  register(browserTypeTool);
  register(browserFillTool);
  register(browserScrollTool);
  register(browserCloseTool);
  register(browserDialogTool);
  register(browserUploadTool);

  register(executeCodeTool);

  register(processSpawnTool);
  register(processListTool);
  register(processLogReadTool);
  register(processKillTool);
  register(processWaitTool);

  // Phase 9: memory write tools (gated by MemoryGuard for read-back
  // verification, then by the approval engine like every other write).
  register(memoryAddTool);
  register(memoryReplaceTool);
  register(memoryRemoveTool);
  // Phase v4.1.2 alive-core: cross-session continuity via /quit auto-summary.
  register(sessionSummaryTool);

  // Phase 10: skill_manage — mutating, also goes through the approval
  // engine. skills_list / skill_view stay in registerReadOnlyTools.
  register(skillManageTool);

  // Phase v4.1.2-update: natural-language entry to the same install
  // executor that /update install uses. Two-step confirmation gate
  // (confirm:false → status; confirm:true → install).
  register(aidenSelfUpdateTool);

  // Phase v4.1.2-followup-3 — computer-control mutating tools. All
  // route through the approval engine like every other write.
  register(mediaKeyTool);
  register(volumeSetTool);
  register(appLaunchTool);
  register(appCloseTool);
  register(clipboardWriteTool);
  // v4.1.4-media — verified GSMTC transport (replaces mediaKey for
  // the "name an app, play/pause it" case) + focused-window SendKeys
  // (escape hatch when GSMTC doesn't enumerate the surface).
  register(mediaTransportTool);
  register(appInputTool);
}

/** Register every v4 tool. Most callers want this. */
export function registerAllTools(registry: ToolRegistry): void {
  registerReadOnlyTools(registry);
  registerWriteTools(registry);
  // v4.8.0 Phase 2.2 — register the 7 semantic ui_* event tools.
  // All uiOnly: true → the dispatch loop in core/v4/aidenAgent.ts
  // bypasses execute and fires onUiEvent on the caller. execute()
  // throws as a safety guard: if the uiOnly branch ever misfires
  // and an executor is reached, that's a wiring bug, not a render.
  // Renderer is a no-op stub in this phase; Phase 2.3 lands chrome.
  // v4.11 toolset grouping — every ui_* helper is tagged `toolset: 'ui'`
  // so profile-based tool selection (core/v4/toolProfiles.ts) can route
  // them as a single group. Pre-Phase-B these were the only untagged
  // tools in the catalog (~542 tokens / 7% of the budget) and the
  // profile resolver would silently drop them under any non-`full`
  // profile because `getSchemas(filterToolsets)` skips handlers with
  // no `toolset` field. Tagging closes that audit gap.
  const ui = (name: string, description: string, properties: Record<string, unknown>, required: string[]): ToolHandler => ({
    schema:   { name, description, inputSchema: { type: 'object', properties, required } },
    execute:  async () => { throw new Error(`${name} is uiOnly — dispatch branch should bypass execute`); },
    category: 'read', mutates: false, uiOnly: true,
    toolset:  'ui',
    // v4.11 — explicit risk tier. These are uiOnly signal channels: never
    // dispatched (execute throws by design), no system access, no side
    // effects. They already INFER to 'safe' via mutates:false; this makes
    // the labeling explicit so the riskTier coverage policy (every tool
    // EXPLICITLY annotated) is satisfied honestly, not via inference.
    riskTier: 'safe',
  });
  const str = { type: 'string' };
  const num = { type: 'number' };
  registry.register(ui('ui_task_update', 'Signal current task state for the live task panel. Append-only stream.',
    { task_id: str, label: { type: 'string', description: '≤80 chars' },
      status: { type: 'string', enum: ['running', 'blocked', 'paused'] },
      kind: { type: 'string', enum: ['task', 'subagent'] }, depth: num, parent_id: str },
    ['task_id', 'label', 'status']));
  registry.register(ui('ui_task_done', 'Signal a task is complete. Pairs with a prior ui_task_update.',
    { task_id: str, status: { type: 'string', enum: ['success', 'failure', 'blocked'] },
      summary: { type: 'string', description: 'Optional, ≤120 chars' } },
    ['task_id', 'status']));
  registry.register(ui('ui_command_result', 'Surface shell output as a formatted block.',
    { command: str, stdout: str, stderr: str, exit_code: num }, ['command']));
  registry.register(ui('ui_test_result', 'Pass/fail count after a test run.',
    { framework: { type: 'string', description: 'e.g. "vitest", "pytest"' },
      passed: num, failed: num, skipped: num, duration_ms: num },
    ['framework', 'passed', 'failed']));
  registry.register(ui('ui_approval_request', 'Structured approval prompt before a privileged action.',
    { prompt: { type: 'string', description: '≤160 chars' },
      risk_tier: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
      reason: { type: 'string', description: 'Optional, ≤200 chars' } },
    ['prompt', 'risk_tier']));
  registry.register(ui('ui_toast', 'Transient notice to surface without interrupting flow.',
    { message: { type: 'string', description: '≤120 chars' },
      kind: { type: 'string', enum: ['info', 'success', 'warning', 'error'] } },
    ['message', 'kind']));
  registry.register(ui('ui_artifact_created', 'Surface a file or skill created/modified this turn.',
    { path: str, kind: { type: 'string', enum: ['file', 'skill', 'directory'] },
      preview: { type: 'string', description: 'Optional, ≤200 chars' } },
    ['path', 'kind']));
  // v4.11 Slice 1 — clarify primitive (ask the user when blocked rather
  // than guess). REPL-only (contexts: ['repl']); blocked for subagents
  // (SUBAGENT_BLOCKED_TOOL_NAMES). Degrades to "unavailable, proceed"
  // when no interactive clarify callback is wired (headless/daemon).
  registry.register(makeClarifyTool());
  // v4.8.0 Phase 2.1 — env-gated uiOnly smoke stub. Never registers
  // in production. Set AIDEN_TEST_UI_STUB=1 to enable for the
  // dispatch-branch smoke harness. The execute() throws on purpose:
  // if the uiOnly branch is wired correctly the model can never
  // reach the executor.
  if (process.env.AIDEN_TEST_UI_STUB === '1') {
    registry.register({
      schema: {
        name:        '_test_ui_stub',
        description: 'Test-only uiOnly stub for v4.8.0 Phase 2.1 smoke. Set AIDEN_TEST_UI_STUB=1 to enable.',
        inputSchema: {
          type:       'object',
          properties: {
            message: { type: 'string', description: 'Arbitrary message to echo via onUiEvent' },
          },
          required: ['message'],
        },
      },
      execute: async () => {
        throw new Error('_test_ui_stub should never execute — uiOnly branch should bypass it');
      },
      category: 'read',
      mutates:  false,
      uiOnly:   true,
      toolset:  'ui',
    });
  }
}

export {
  makeSubagentFanoutTool,
  type SubagentFanoutFactoryOptions,
} from './subagent/subagentFanout';

export { webSearchTool } from './web/webSearch';
export { webFetchTool } from './web/webFetch';
export { webPageTool } from './web/webPage';
export { deepResearchTool } from './web/deepResearch';
export { fileReadTool } from './files/fileRead';
export { fileListTool } from './files/fileList';
export { fileWriteTool } from './files/fileWrite';
export { filePatchTool } from './files/filePatch';
export { fileDeleteTool } from './files/fileDelete';
export { readPdfTool } from './files/readPdf';
export { planApprovalTool } from './approval/planApproval';
export { fileMoveTool } from './files/fileMove';
export { fileCopyTool } from './files/fileCopy';
export { browserScreenshotTool } from './browser/browserScreenshot';
export { browserExtractTool } from './browser/browserExtract';
export { browserGetUrlTool } from './browser/browserGetUrl';
export { browserNavigateTool } from './browser/browserNavigate';
export { browserClickTool } from './browser/browserClick';
export { browserTypeTool } from './browser/browserType';
export { browserFillTool } from './browser/browserFill';
export { browserScrollTool } from './browser/browserScroll';
export { browserCloseTool } from './browser/browserClose';
export { sessionSearchTool } from './sessions/sessionSearch';
export { sessionListTool } from './sessions/sessionList';
export { skillsListTool } from './skills/skillsList';
export { skillViewTool } from './skills/skillView';
export { skillManageTool } from './skills/skillManage';
export { makeLookupToolSchema } from './skills/lookupToolSchema';
export { systemInfoTool } from './system/systemInfo';
export { nowPlayingTool } from './system/nowPlaying';
export { naturalEventsTool } from './system/naturalEvents';
// Phase v4.1.2-followup-3 computer-control bundle exports.
export { screenshotTool } from './system/screenshot';
export { osProcessListTool } from './system/osProcessList';
export { mediaKeyTool } from './system/mediaKey';
export { volumeSetTool } from './system/volumeSet';
export { appLaunchTool } from './system/appLaunch';
export { appCloseTool } from './system/appClose';
export { clipboardReadTool } from './system/clipboardRead';
export { clipboardWriteTool } from './system/clipboardWrite';
// v4.1.4-media exports — three-layer media-control bundle.
export { mediaSessionsTool } from './system/mediaSessions';
export { mediaTransportTool } from './system/mediaTransport';
export { appInputTool } from './system/appInput';
export { shellExecTool } from './terminal/shellExec';
export { executeCodeTool } from './executeCode';
export { processSpawnTool } from './process/processSpawn';
export { processListTool } from './process/processList';
export { processLogReadTool } from './process/processLogRead';
export { processKillTool } from './process/processKill';
export { processWaitTool } from './process/processWait';
export { memoryAddTool } from './memory/memoryAdd';
export { memoryReplaceTool } from './memory/memoryReplace';
export { memoryRemoveTool } from './memory/memoryRemove';
export { sessionSummaryTool } from './memory/sessionSummary';
