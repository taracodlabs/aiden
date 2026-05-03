# Graph Report - DevOS  (2026-05-03)

## Corpus Check
- 277 files · ~2,157,361 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1782 nodes · 3353 edges · 48 communities detected
- Extraction: 90% EXTRACTED · 10% INFERRED · 0% AMBIGUOUS · INFERRED: 352 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Community 0|Community 0]]
- [[_COMMUNITY_Community 1|Community 1]]
- [[_COMMUNITY_Community 2|Community 2]]
- [[_COMMUNITY_Community 3|Community 3]]
- [[_COMMUNITY_Community 4|Community 4]]
- [[_COMMUNITY_Community 5|Community 5]]
- [[_COMMUNITY_Community 6|Community 6]]
- [[_COMMUNITY_Community 7|Community 7]]
- [[_COMMUNITY_Community 8|Community 8]]
- [[_COMMUNITY_Community 9|Community 9]]
- [[_COMMUNITY_Community 10|Community 10]]
- [[_COMMUNITY_Community 11|Community 11]]
- [[_COMMUNITY_Community 12|Community 12]]
- [[_COMMUNITY_Community 13|Community 13]]
- [[_COMMUNITY_Community 14|Community 14]]
- [[_COMMUNITY_Community 15|Community 15]]
- [[_COMMUNITY_Community 16|Community 16]]
- [[_COMMUNITY_Community 17|Community 17]]
- [[_COMMUNITY_Community 18|Community 18]]
- [[_COMMUNITY_Community 19|Community 19]]
- [[_COMMUNITY_Community 20|Community 20]]
- [[_COMMUNITY_Community 21|Community 21]]
- [[_COMMUNITY_Community 22|Community 22]]
- [[_COMMUNITY_Community 23|Community 23]]
- [[_COMMUNITY_Community 24|Community 24]]
- [[_COMMUNITY_Community 25|Community 25]]
- [[_COMMUNITY_Community 26|Community 26]]
- [[_COMMUNITY_Community 27|Community 27]]
- [[_COMMUNITY_Community 28|Community 28]]
- [[_COMMUNITY_Community 29|Community 29]]
- [[_COMMUNITY_Community 30|Community 30]]
- [[_COMMUNITY_Community 31|Community 31]]
- [[_COMMUNITY_Community 32|Community 32]]
- [[_COMMUNITY_Community 33|Community 33]]
- [[_COMMUNITY_Community 34|Community 34]]
- [[_COMMUNITY_Community 35|Community 35]]
- [[_COMMUNITY_Community 36|Community 36]]
- [[_COMMUNITY_Community 38|Community 38]]
- [[_COMMUNITY_Community 40|Community 40]]
- [[_COMMUNITY_Community 41|Community 41]]
- [[_COMMUNITY_Community 42|Community 42]]
- [[_COMMUNITY_Community 46|Community 46]]
- [[_COMMUNITY_Community 48|Community 48]]
- [[_COMMUNITY_Community 50|Community 50]]
- [[_COMMUNITY_Community 51|Community 51]]
- [[_COMMUNITY_Community 55|Community 55]]
- [[_COMMUNITY_Community 58|Community 58]]
- [[_COMMUNITY_Community 66|Community 66]]

## God Nodes (most connected - your core abstractions)
1. `summarize()` - 77 edges
2. `handleCommand()` - 47 edges
3. `planWithLLM()` - 39 edges
4. `runTest()` - 34 edges
5. `printResult()` - 34 edges
6. `runPhase1()` - 32 edges
7. `runWarn()` - 32 edges
8. `ConversationMemory` - 27 edges
9. `log()` - 21 edges
10. `executeTool()` - 20 edges

## Surprising Connections (you probably didn't know these)
- `handleChatError()` --calls--> `markRateLimited()`  [INFERRED]
  api\server.ts → providers\router.ts
- `handleCommand()` --calls--> `clearHonchoProfile()`  [INFERRED]
  cli\aiden.ts → core\userProfile.ts
- `handleCommand()` --calls--> `getActiveSpawns()`  [INFERRED]
  cli\aiden.ts → core\spawnManager.ts
- `handleCommand()` --calls--> `killSpawn()`  [INFERRED]
  cli\aiden.ts → core\spawnManager.ts
- `startApiServer()` --calls--> `initReminderScheduler()`  [INFERRED]
  api\server.ts → core\scheduler.ts

## Communities (89 total, 14 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.03
Nodes (110): streamChat(), detectActionVerb(), extractMemoryFact(), isActionIntent(), isForgetIntent(), isMemoryIntent(), appendLesson(), buildDependencyGroups() (+102 more)

### Community 1 - "Community 1"
Cohesion: 0.03
Nodes (70): main(), LivePulse, getPid(), isServiceRunning(), startBackgroundService(), stopService(), buildCapabilityProfile(), detectOllamaLocalLLM() (+62 more)

### Community 2 - "Community 2"
Cohesion: 0.05
Nodes (79): run(), run(), run(), run(), getRecordsSnapshot(), run(), run(), run() (+71 more)

### Community 3 - "Community 3"
Cohesion: 0.03
Nodes (75): getDashboardHTML(), createApiServer(), extractChatMessageContent(), fetchProviderResponse(), handleChatError(), raceProviders(), start(), startApiServer() (+67 more)

### Community 4 - "Community 4"
Cohesion: 0.04
Nodes (76): apiDelete(), apiFetch(), apiPost(), applyTheme(), clearDropdown(), cols(), ctxBar(), ctxColor() (+68 more)

### Community 5 - "Community 5"
Cohesion: 0.02
Nodes (11): DiscordAdapter, EmailAdapter, IMessageAdapter, SignalAdapter, SlackAdapter, chunkSms(), TwilioAdapter, WebhookAdapter (+3 more)

### Community 6 - "Community 6"
Cohesion: 0.04
Nodes (63): runInSandbox(), clickMouse(), executePowerShell(), executeWithFallback(), executeWithVisionRetry(), focusWindow(), getScreenSize(), moveMouse() (+55 more)

### Community 7 - "Community 7"
Cohesion: 0.04
Nodes (24): APIRegistry, getNut(), ScreenAgent, callClaudeVision(), callOllamaVision(), VisionLoop, CommandGate, EvolutionAnalyzer (+16 more)

### Community 8 - "Community 8"
Cohesion: 0.05
Nodes (42): aidenToolToMCP(), buildInputSchema(), createJob(), deleteJob(), loadJobs(), parseSchedule(), pauseJob(), resumeJob() (+34 more)

### Community 9 - "Community 9"
Cohesion: 0.05
Nodes (42): certificateLookup(), getSkill(), hostLookup(), hostSearch(), ApiSkill, RateLimiter, requireApiKey(), formatSubdomains() (+34 more)

### Community 10 - "Community 10"
Cohesion: 0.13
Nodes (22): main(), main(), main(), htmlReport(), main(), pickSuites(), main(), callAiden() (+14 more)

### Community 11 - "Community 11"
Cohesion: 0.07
Nodes (15): ConversationMemory, getActiveGoalsSummary(), loadGoals(), buildGreetingPreamble(), extractLastSessionSummary(), readUserName(), buildPrompt(), createChildSession() (+7 more)

### Community 12 - "Community 12"
Cohesion: 0.06
Nodes (6): BM25, EntityGraph, LearningMemory, applyMMR(), applyTemporalDecay(), SemanticMemory

### Community 13 - "Community 13"
Cohesion: 0.1
Nodes (12): DeepKB, cleanText(), countWords(), extractEPUB(), extractFile(), extractPDF(), extractText(), chunkText() (+4 more)

### Community 14 - "Community 14"
Cohesion: 0.12
Nodes (24): assertHttps(), assertScriptExt(), assertSize(), extractSkillName(), fetchText(), importFromGitHub(), importFromLocal(), importFromUrl() (+16 more)

### Community 15 - "Community 15"
Cohesion: 0.1
Nodes (22): appendRecord(), assignId(), _autoSummary(), _ensureDir(), loadAllRecords(), loadRecordById(), nextId(), _readSeq() (+14 more)

### Community 16 - "Community 16"
Cohesion: 0.1
Nodes (11): AuxiliaryClient, callBgLLM(), getCerebrasKey(), getOllamaModel(), CostTracker, buildExtractionPrompt(), MemoryExtractor, memoryFilePath() (+3 more)

### Community 17 - "Community 17"
Cohesion: 0.09
Nodes (8): callMcpTool(), connectMcpServer(), disconnectMcpServer(), listMcpServers(), listMcpTools(), MCPClient, McpManager, runTool()

### Community 18 - "Community 18"
Cohesion: 0.12
Nodes (15): computeIdentity(), computeLevel(), computeProgress(), computeStreakDays(), computeTopStrength(), computeXP(), getIdentity(), loadIdentity() (+7 more)

### Community 19 - "Community 19"
Cohesion: 0.12
Nodes (12): icon(), main(), printResult(), printSummary(), run(), runPart1(), runPart2(), runPart3() (+4 more)

### Community 20 - "Community 20"
Cohesion: 0.13
Nodes (14): UserCognitionProfile, classifyQueryForProfile(), clearHonchoProfile(), createUserProfile(), detectTimezone(), emptyHonchoProfile(), formatForPrompt(), getProfile() (+6 more)

### Community 21 - "Community 21"
Cohesion: 0.17
Nodes (16): classifyIssues(), dryRun(), estimatedCost(), main(), overBudget(), printBanner(), printSummaryTable(), printTopIssues() (+8 more)

### Community 22 - "Community 22"
Cohesion: 0.17
Nodes (14): AuditTrail, acquireLock(), allGatesPass(), checkAndRunDream(), checkSessionGate(), checkTimeGate(), getLockMtime(), isPidAlive() (+6 more)

### Community 23 - "Community 23"
Cohesion: 0.25
Nodes (16): checkServer(), cleanupTestFiles(), fail(), httpGet(), main(), pass(), run(), runSection1() (+8 more)

### Community 26 - "Community 26"
Cohesion: 0.23
Nodes (10): hybridSearch(), normalise(), buildIndex(), getIndex(), getIndexSize(), getSessionDirs(), loadDocuments(), rebuildIndex() (+2 more)

### Community 27 - "Community 27"
Cohesion: 0.18
Nodes (5): Call-Aiden(), Log-TestResult(), Log-TestStart(), Invoke-Judge(), Run-QualityTest()

### Community 28 - "Community 28"
Cohesion: 0.22
Nodes (3): BrowserVaultManager, loadPersistedBVaults(), savePersistedBVaults()

### Community 29 - "Community 29"
Cohesion: 0.4
Nodes (4): diskHash(), ProtectedContextManager, readFirst(), sha1()

### Community 36 - "Community 36"
Cohesion: 0.39
Nodes (7): ensureWorkspace(), playAudio(), _playUnix(), _playWindows(), recordAudio(), _recordUnix(), _recordWindows()

### Community 38 - "Community 38"
Cohesion: 0.43
Nodes (6): ensureWorkspace(), resolveAudioPath(), transcribe(), transcribeGroq(), transcribeLocal(), transcribeOpenAI()

### Community 40 - "Community 40"
Cohesion: 0.47
Nodes (3): fetchJSON(), runAllTests(), test()

### Community 42 - "Community 42"
Cohesion: 0.7
Nodes (4): Draw-Dashboard(), Format-Cost(), Get-ApiData(), Write-Section()

### Community 46 - "Community 46"
Cohesion: 0.83
Nodes (3): fetchJson(), recencyWeight(), socialResearch()

### Community 48 - "Community 48"
Cohesion: 0.83
Nodes (3): readSSE(), runStressTest(), runTest()

## Knowledge Gaps
- **3 isolated node(s):** `DevOSEventBus`, `DevOS / Aiden — Quick Action Hotkey Widget =====================================`, `Point`
  These have ≤1 connection - possible missing edges or undocumented components.
- **14 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `startServer()` connect `Community 21` to `Community 0`?**
  _High betweenness centrality (0.134) - this node is a cross-community bridge._
- **Why does `handleCommand()` connect `Community 4` to `Community 0`, `Community 3`, `Community 38`, `Community 8`, `Community 20`, `Community 26`?**
  _High betweenness centrality (0.129) - this node is a cross-community bridge._
- **Why does `printResult()` connect `Community 2` to `Community 21`?**
  _High betweenness centrality (0.101) - this node is a cross-community bridge._
- **Are the 44 inferred relationships involving `summarize()` (e.g. with `groupA()` and `groupB()`) actually correct?**
  _`summarize()` has 44 INFERRED edges - model-reasoned connections that need verification._
- **Are the 27 inferred relationships involving `handleCommand()` (e.g. with `fg()` and `panel()`) actually correct?**
  _`handleCommand()` has 27 INFERRED edges - model-reasoned connections that need verification._
- **Are the 25 inferred relationships involving `planWithLLM()` (e.g. with `fireHook()` and `loadAllRecipes()`) actually correct?**
  _`planWithLLM()` has 25 INFERRED edges - model-reasoned connections that need verification._
- **What connects `DevOSEventBus`, `DevOS / Aiden — Quick Action Hotkey Widget =====================================`, `Point` to the rest of the system?**
  _3 weakly-connected nodes found - possible documentation gaps or missing edges._