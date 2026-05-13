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

import type { ToolRegistry } from '../../core/v4/toolRegistry';

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
import { fileCopyTool } from './files/fileCopy';

import { browserScreenshotTool } from './browser/browserScreenshot';
import { browserExtractTool } from './browser/browserExtract';
import { browserGetUrlTool } from './browser/browserGetUrl';
import { browserNavigateTool } from './browser/browserNavigate';
import { browserClickTool } from './browser/browserClick';
import { browserTypeTool } from './browser/browserType';
import { browserFillTool } from './browser/browserFill';
import { browserScrollTool } from './browser/browserScroll';
import { browserCloseTool } from './browser/browserClose';

import { sessionSearchTool } from './sessions/sessionSearch';
import { sessionListTool } from './sessions/sessionList';
import { recallSessionTool } from './sessions/recallSession';

import { skillsListTool } from './skills/skillsList';
import { skillViewTool } from './skills/skillView';
import { skillManageTool } from './skills/skillManage';
import { makeLookupToolSchema } from './skills/lookupToolSchema';

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

/**
 * Register every read-only tool into `registry`. The
 * `lookup_tool_schema` tool needs a registry reference, so it's
 * registered LAST (after every other tool, so it can introspect
 * the full set).
 */
export function registerReadOnlyTools(registry: ToolRegistry): void {
  registry.register(webSearchTool);
  registry.register(webFetchTool);
  registry.register(webPageTool);
  registry.register(deepResearchTool);
  // Phase 16f: open_url uses shell launch (start chrome / open / xdg-open)
  // for "open X in browser" requests — bypasses Playwright detection.
  registry.register(openUrlTool);
  // Phase 23.4a: youtube_search returns real /watch?v= URLs scraped
  // from youtube.com/results. media-search uses it before open_url so
  // the URL provenance gate has a candidate set to validate against —
  // closes the URL-hallucination failure mode where the model invented
  // 11-char IDs.
  registry.register(youtubeSearchTool);

  registry.register(fileReadTool);
  registry.register(fileListTool);

  registry.register(browserScreenshotTool);
  registry.register(browserExtractTool);
  registry.register(browserGetUrlTool);

  registry.register(sessionSearchTool);
  registry.register(sessionListTool);
  // Phase v4.1.2-memory-C: recall_session reads SessionDistillation
  // files written by Phase A+B. Sits alongside session_search — the
  // two have distinct purposes (FTS5-over-messages vs ranked
  // distillation summaries); descriptions force the right model
  // choice.
  registry.register(recallSessionTool);

  registry.register(skillsListTool);
  registry.register(skillViewTool);

  registry.register(systemInfoTool);
  registry.register(nowPlayingTool);
  registry.register(naturalEventsTool);

  // Phase v4.1.2-followup-3 — computer-control read-only tools.
  registry.register(screenshotTool);
  registry.register(osProcessListTool);
  registry.register(clipboardReadTool);

  registry.register(makeLookupToolSchema(registry));

  // Phase v4.1-subagent — register a stub for subagent_fanout so its
  // schema is visible to the agent loop, the MCP server, and the
  // /tools slash command BEFORE the runtime resolves provider /
  // adapter / agent dependencies. The full runtime calls
  // `registry.register(makeSubagentFanoutTool({...real opts}))` to
  // replace this stub once `buildAgentRuntime` has those handles.
  // Until then, calling the stub returns a clear "not wired" error
  // rather than crashing.
  registry.register(makeSubagentFanoutStub());
}

/** Stub used until the runtime wires real provider / adapter / agent
 *  dependencies. Returns the SAME schema as the real tool so MCP and
 *  /tools see a consistent surface. */
function makeSubagentFanoutStub() {
  return makeSubagentFanoutTool({
    resolveProviders:    () => [],
    resolveActiveModel:  () => ({ providerId: 'unset', modelId: 'unset' }),
    aggregatorAdapter:   {
      apiMode: 'chat_completions',
      async call() {
        throw new Error(
          'subagent_fanout: tool not wired — runtime did not replace the stub. ' +
          'Call registry.register(makeSubagentFanoutTool({...})) after buildAgentRuntime.',
        );
      },
    },
    runChild: async () => {
      throw new Error(
        'subagent_fanout: tool not wired — runtime did not replace the stub.',
      );
    },
  });
}

/**
 * Register every Phase 8 write/execute tool. Phase 9 will gate
 * every `mutates: true` handler in this set behind the approval
 * engine — the registration order doesn't matter for that.
 */
export function registerWriteTools(registry: ToolRegistry): void {
  registry.register(fileWriteTool);
  registry.register(filePatchTool);
  registry.register(fileDeleteTool);
  registry.register(fileMoveTool);
  registry.register(fileCopyTool);

  registry.register(shellExecTool);

  registry.register(browserNavigateTool);
  registry.register(browserClickTool);
  registry.register(browserTypeTool);
  registry.register(browserFillTool);
  registry.register(browserScrollTool);
  registry.register(browserCloseTool);

  registry.register(executeCodeTool);

  registry.register(processSpawnTool);
  registry.register(processListTool);
  registry.register(processLogReadTool);
  registry.register(processKillTool);
  registry.register(processWaitTool);

  // Phase 9: memory write tools (gated by MemoryGuard for read-back
  // verification, then by the approval engine like every other write).
  registry.register(memoryAddTool);
  registry.register(memoryReplaceTool);
  registry.register(memoryRemoveTool);
  // Phase v4.1.2 alive-core: cross-session continuity via /quit auto-summary.
  registry.register(sessionSummaryTool);

  // Phase 10: skill_manage — mutating, also goes through the approval
  // engine. skills_list / skill_view stay in registerReadOnlyTools.
  registry.register(skillManageTool);

  // Phase v4.1.2-update: natural-language entry to the same install
  // executor that /update install uses. Two-step confirmation gate
  // (confirm:false → status; confirm:true → install).
  registry.register(aidenSelfUpdateTool);

  // Phase v4.1.2-followup-3 — computer-control mutating tools. All
  // route through the approval engine like every other write.
  registry.register(mediaKeyTool);
  registry.register(volumeSetTool);
  registry.register(appLaunchTool);
  registry.register(appCloseTool);
  registry.register(clipboardWriteTool);
}

/** Register every v4 tool. Most callers want this. */
export function registerAllTools(registry: ToolRegistry): void {
  registerReadOnlyTools(registry);
  registerWriteTools(registry);
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
