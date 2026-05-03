/**
 * tools/v4/index.ts — Tool registration helper.
 *
 * `registerReadOnlyTools(registry)` wires every Phase 7 wrapper
 * into a `ToolRegistry` instance. Call once at boot, after the
 * registry is created and before `AidenAgent` is constructed.
 *
 * Phase 8 will add `registerWriteTools()` for file_write, terminal
 * exec, browser navigation, and code interpreter — gated behind the
 * approval engine.
 *
 * Status: PHASE 7.
 */

import type { ToolRegistry } from '../../core/v4/toolRegistry';

import { webSearchTool } from './web/webSearch';
import { webFetchTool } from './web/webFetch';
import { webPageTool } from './web/webPage';
import { deepResearchTool } from './web/deepResearch';

import { fileReadTool } from './files/fileRead';
import { fileListTool } from './files/fileList';

import { browserScreenshotTool } from './browser/browserScreenshot';
import { browserExtractTool } from './browser/browserExtract';
import { browserGetUrlTool } from './browser/browserGetUrl';

import { sessionSearchTool } from './sessions/sessionSearch';
import { sessionListTool } from './sessions/sessionList';

import { skillsListTool } from './skills/skillsList';
import { makeLookupToolSchema } from './skills/lookupToolSchema';

import { systemInfoTool } from './system/systemInfo';
import { nowPlayingTool } from './system/nowPlaying';
import { naturalEventsTool } from './system/naturalEvents';

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

  registry.register(fileReadTool);
  registry.register(fileListTool);

  registry.register(browserScreenshotTool);
  registry.register(browserExtractTool);
  registry.register(browserGetUrlTool);

  registry.register(sessionSearchTool);
  registry.register(sessionListTool);

  registry.register(skillsListTool);

  registry.register(systemInfoTool);
  registry.register(nowPlayingTool);
  registry.register(naturalEventsTool);

  registry.register(makeLookupToolSchema(registry));
}

export { webSearchTool } from './web/webSearch';
export { webFetchTool } from './web/webFetch';
export { webPageTool } from './web/webPage';
export { deepResearchTool } from './web/deepResearch';
export { fileReadTool } from './files/fileRead';
export { fileListTool } from './files/fileList';
export { browserScreenshotTool } from './browser/browserScreenshot';
export { browserExtractTool } from './browser/browserExtract';
export { browserGetUrlTool } from './browser/browserGetUrl';
export { sessionSearchTool } from './sessions/sessionSearch';
export { sessionListTool } from './sessions/sessionList';
export { skillsListTool } from './skills/skillsList';
export { makeLookupToolSchema } from './skills/lookupToolSchema';
export { systemInfoTool } from './system/systemInfo';
export { nowPlayingTool } from './system/nowPlaying';
export { naturalEventsTool } from './system/naturalEvents';
