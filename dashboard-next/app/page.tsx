"use client"
import {
  useState, useEffect, useRef, useMemo, useCallback,
  createContext, useContext, Fragment,
  type Dispatch, type SetStateAction, type CSSProperties,
  type ReactNode, type RefObject, type ChangeEvent, type FormEvent,
} from 'react'
import Onboarding from '../components/Onboarding'
import { OnboardingModal } from '../components/OnboardingModal'
import PricingModal from '../components/PricingModal'
import ChatHeader from '../components/ChatHeader'
import Sidebar from '../components/Sidebar'
import WorkflowView from '../components/WorkflowView'
import LiveExecutionTerminal from '../components/LiveExecutionTerminal'
import * as aiden from '../lib/aidenClient'
import { PUBLIC_SPONSORS, SPONSOR_URL } from '../lib/publicSponsors'
import {
  artifactPresentationForMime,
  codingReconciliationNeedsAttention,
  conversationForExactRun,
  mergeLiveActivity,
  pendingApprovalCards,
  pendingApprovalsForProjection,
  projectRecommendedApps,
  selectChatLiveActivity,
  shouldShowChatTelemetry,
  summarizeCompletedActivity,
  type LiveActivityItem,
} from '../lib/workbenchUx'
import {
  WorkbenchController,
  emptySelection,
  foregroundExecutionCount,
  isForegroundExecutionStatus,
  normalizeActiveJobStatus,
  shouldAttachAdmission,
  selectionFromSearch,
  selectionToSearch,
  type ActiveJobView,
  type WorkbenchSelection,
} from '../lib/workbenchController'
import {
  groupActiveWork,
  presentAssistantContent,
  presentApproval,
  presentResult,
  presentRuntimeDetail,
  presentRuntimeStatus,
  projectAttentionItems,
  projectSemanticProgress,
} from '../lib/workbenchPresentation'
import {
  chooseLiveExecutionSurface,
  liveExecutionAutoOpenKey,
  shouldAutoOpenLiveExecution,
  type LiveExecutionSelection,
} from '../lib/liveExecutionUx'

// ── Types ─────────────────────────────────────────────────────

type UIMode   = 'focus' | 'execution' | 'power' | 'watch'
type ExecMode = 'auto'  | 'plan'      | 'chat'  | 'react'
type MainView = 'chat' | 'activity' | 'artifacts' | 'apps' | 'automations' | 'sponsors'
type WorkbenchAppearance = 'dark' | 'system'

interface AutomationPattern {
  pattern:        string
  frequency:      number
  suggestion:     string
  automationGoal: string
}

interface Phase {
  name:   string
  index:  number
  total:  number
  steps:  { tool: string; status: 'pending' | 'running' | 'done' | 'failed'; duration?: number }[]
  status: 'pending' | 'running' | 'done'
}

interface Message {
  id:             string
  role:           'user' | 'assistant'
  content:        string
  provider?:      string
  timestamp:      number
  phases?:        Phase[]
  isStreaming?:   boolean
  isBriefing?:    boolean
  briefingLabel?: string
  attachments?:   aiden.WorkbenchAttachment[]
}

interface Conversation {
  id:        string
  title:     string
  timestamp: number
  messages:  Message[]
  channels?: string[]   // channels that participated (cross-channel sessions)
  depth?:    number     // compression lineage depth (0 = original)
  sessionId?: string
  jobId?: string
  attemptId?: string
  runId?: number
}

interface ActivityLog {
  time:      string
  icon:      string
  agent:     string
  message:   string
  style?:    'ok' | 'err' | 'active' | 'default'
  rawTool?:  string
  rawInput?: Record<string, any>
}

// ── Activity view ─────────────────────────────────────────────
// Tool calls + verified/unverified verdicts live here, OUT of the chat
// conversation. The chat shows the written reply; this shows what ran to
// produce it. Fed from the v4 event stream (see lib/aidenClient.ts).
function ActivityView({ logs, jobId, attemptId, runId, onContinued }: {
  logs: ActivityLog[]
  jobId: string | null
  attemptId: string | null
  runId: number | null
  onContinued?: (jobId: string, attemptId: string, runId: number) => void
}) {
  const {
    activeJobs, selectActiveJob, presence, presenceBriefing, refreshPresence, sessionId,
    setMainView, setSettingsOpen, setSettingsTab,
  } = useDevOS()
  const [projection, setProjection] = useState<aiden.WorkbenchRunProjection | null>(null)
  const [continuity, setContinuity] = useState<aiden.ContinuityCheckpointView | null>(null)
  const [continueResult, setContinueResult] = useState<{ pending: boolean; accepted?: boolean; reason?: string }>({ pending: false })
  const continueKeys = useRef<Record<string, string>>({})
  const [projectionRevision, setProjectionRevision] = useState(0)
  const [presenceReasons, setPresenceReasons] = useState<Record<string, string>>({})
  const [presenceProposals, setPresenceProposals] = useState<Record<string, aiden.WorkbenchProposedJob>>({})
  useEffect(() => {
    let current = true
    void aiden.loadPresenceProposals()
      .then((proposals) => {
        if (!current) return
        setPresenceProposals(Object.fromEntries(proposals.map((proposal) => [proposal.itemId, proposal])))
      })
      .catch(() => { /* keep Presence usable if proposal projection is temporarily unavailable */ })
    return () => { current = false }
  }, [presence])
  const pendingApprovals = pendingApprovalCards(projection?.approvals ?? [])
  const activeWorkItems = useMemo(() => {
    if (!projection?.receipt.terminal || !projection.identity.jobId) return activeJobs
    if (activeJobs.some((job) => job.jobId === projection.identity.jobId)) return activeJobs
    const completed: ActiveJobView = {
      sessionId: null,
      jobId: projection.identity.jobId,
      attemptId: projection.identity.attemptId,
      runId: projection.identity.runId,
      status: 'terminal',
      updatedAt: 0,
      title: projection.receipt.summary || 'Completed work',
      statusDetail: presentRuntimeStatus(projection.receipt.status).detail,
    }
    return [...activeJobs, completed]
  }, [activeJobs, projection])
  const workGroups = groupActiveWork(activeWorkItems)
  const fallbackAttention = projectAttentionItems({ jobs: activeJobs, approvals: pendingApprovals })
  const attentionItems = presence?.enabled ? presence.needsYou : fallbackAttention
  const presenceJobIds = new Set([
    ...(presence?.needsYou ?? []), ...(presence?.reviewWhenReady ?? []), ...(presence?.recentlyResolved ?? []),
  ].flatMap((item) => item.jobId ? [item.jobId] : []))
  const visibleWorkGroups = ([
    ['Needs you', presence?.enabled ? workGroups.needsYou.filter((job) => !presenceJobIds.has(job.jobId)) : workGroups.needsYou],
    ['Running', workGroups.running],
    ['Ready for review', presence?.enabled ? workGroups.readyForReview.filter((job) => !presenceJobIds.has(job.jobId)) : workGroups.readyForReview],
    ['Recently completed', presence?.enabled ? workGroups.recentlyCompleted.filter((job) => !presenceJobIds.has(job.jobId)) : workGroups.recentlyCompleted],
  ] as const).filter(([, jobs], index) => jobs.length > 0 || index === 1)
  const result = projection?.receipt.terminal ? presentResult({
    status: projection.receipt.status,
    summary: projection.receipt.summary,
    verdict: projection.receipt.verdict?.verdict,
    evidenceCount: projection.evidence?.length ?? 0,
  }) : null
  useEffect(() => {
    let current = true
    if (!jobId || !attemptId || runId === null) { setProjection(null); setContinuity(null); return () => { current = false } }
    const refresh = () => Promise.all([aiden.loadRunProjection(jobId, attemptId, runId), aiden.loadContinuity(jobId)])
      .then(([nextProjection, nextContinuity]) => {
        if (current) { setProjection(nextProjection); setContinuity(nextContinuity) }
      })
      .catch(() => { /* the event stream remains usable if projection refresh fails */ })
    void refresh()
    const poll = projection?.receipt.terminal ? null : window.setInterval(() => { void refresh() }, 1_000)
    return () => {
      current = false
      if (poll !== null) window.clearInterval(poll)
    }
  }, [jobId, attemptId, runId, logs.length, projectionRevision, projection?.receipt.terminal])
  const color = (s?: string) =>
    s === 'ok' ? 'var(--green)' : s === 'err' ? 'var(--red)' : s === 'active' ? 'var(--orange)' : 'var(--muted3)'
  return (
    <div className="active-work-view">
      <header className="active-work-header">
        <div><span className="eyebrow">Your work</span><h1>Active Work</h1><p>See what needs you, what is running, and what is ready to review.</p></div>
        {attentionItems.length > 0 && <span className="attention-count">{attentionItems.length} {attentionItems.length === 1 ? 'needs' : 'need'} you</span>}
      </header>
      {presence?.enabled && (
        <div className="presence-board" aria-label="Agentic Presence">
          {presenceBriefing && presenceBriefing.items.length > 0 && (
            <div className="presence-briefing">
              <span className="eyebrow">Since you were away</span>
              <strong>{presenceBriefing.items.length} meaningful {presenceBriefing.items.length === 1 ? 'change' : 'changes'}</strong>
              <span>Current durable state only; stale blockers are omitted.</span>
              <div className="presence-briefing-groups" aria-label="Briefing categories">
                {([['Changed', presenceBriefing.groups.changed], ['Resolved', presenceBriefing.groups.resolved],
                  ['Blocked', presenceBriefing.groups.blocked], ['Ready', presenceBriefing.groups.ready],
                  ['Next', presenceBriefing.groups.next]] as const).map(([label, items]) => items.length > 0 && (
                  <span key={label}><b>{label.toUpperCase()}</b>{items.length}</span>
                ))}
              </div>
            </div>
          )}
          {([
            ['Needs you', presence.needsYou],
            ['Review when ready', presence.reviewWhenReady],
            ['Recently resolved', presence.recentlyResolved],
          ] as const).map(([label, items]) => items.length > 0 && (
            <section className="presence-group" key={label}>
              <h2>{label}<span>{items.length}</span></h2>
              <div className="presence-list">
                {items.map((item) => {
                  const proposal = presenceProposals[item.id]
                  return (
                    <article className={`presence-item priority-${item.priority >= 90 ? 'critical' : item.priority >= 70 ? 'attention' : 'review'}`} key={item.id}>
                      <div className="presence-item-copy">
                        <strong>{item.title}</strong>
                        <p>{item.summary}</p>
                        <small>{item.reasonCode.replace(/_/g, ' ')} · updated {new Date(item.lastObservedAt).toLocaleString()}</small>
                        {presenceReasons[item.id] && <div className="presence-reason"><b>Why shown</b>{presenceReasons[item.id]}</div>}
                        {proposal && (
                          <div className="presence-proposal">
                            <b>Proposed task</b>
                            <span>{proposal.goal}</span>
                            <small>{proposal.state === 'proposed' ? 'No Job exists until you accept.' : proposal.state.replace(/_/g, ' ')}</small>
                          </div>
                        )}
                      </div>
                      {item.state === 'active' && (
                        <div className="presence-actions">
                          {item.jobId && activeJobs.some((job) => job.jobId === item.jobId) && (
                            <button type="button" onClick={() => selectActiveJob(activeJobs.find((job) => job.jobId === item.jobId)!)}>
                              {item.recommendedAction || 'Open source'}
                            </button>
                          )}
                          {!item.jobId && item.recommendedAction && (
                            <button type="button" onClick={() => {
                              if (item.sourceKind === 'connected_account') setMainView('apps')
                              else if (item.sourceKind === 'automation') setMainView('automations')
                              else {
                                setSettingsTab('readiness')
                                setSettingsOpen(true)
                              }
                            }}>{item.recommendedAction}</button>
                          )}
                          <button type="button" onClick={() => {
                            void aiden.explainPresenceItem(item.id)
                              .then((explanation) => setPresenceReasons((current) => ({ ...current, [item.id]: explanation.reason })))
                          }}>Why shown</button>
                          {item.category === 'next_action' && !proposal && (
                            <button type="button" onClick={() => {
                              void aiden.proposePresenceJob(item.id, item.summary, item.title)
                                .then((next) => setPresenceProposals((current) => ({ ...current, [item.id]: next })))
                            }}>Propose task</button>
                          )}
                          {proposal?.state === 'proposed' && (
                            <button type="button" className="is-primary" onClick={() => {
                              void aiden.acceptPresenceProposal(proposal.id, proposal.version, sessionId)
                                .then((next) => {
                                  setPresenceProposals((current) => ({ ...current, [item.id]: next }))
                                  return refreshPresence()
                                })
                            }}>Accept proposed task</button>
                          )}
                          <button type="button" onClick={() => {
                            void aiden.snoozePresenceItem(item.id, item.version, Date.now() + 3_600_000).then(refreshPresence)
                          }}>Snooze 1h</button>
                          <button type="button" onClick={() => {
                            void aiden.dismissPresenceItem(item.id, item.version).then(refreshPresence)
                          }}>Dismiss</button>
                        </div>
                      )}
                    </article>
                  )
                })}
              </div>
            </section>
          ))}
        </div>
      )}
      <div className="active-work-groups">
        {visibleWorkGroups.map(([label, jobs]) => (
          <section className="work-group" key={label}>
            <h2>{label}<span>{jobs.length}</span></h2>
            {jobs.length === 0 ? <p className="work-group-empty">Nothing here</p> : jobs.map((job) => {
              const state = presentRuntimeStatus(job.status)
              return (
                <button type="button" className={`work-item tone-${state.tone}`} key={job.jobId} onClick={() => selectActiveJob(job)}>
                  <span className="work-item-copy"><strong>{job.title || 'Untitled work'}</strong><small>{presentRuntimeDetail(job.statusDetail, job.status)}</small></span>
                  <span className="work-item-state">{state.label}</span>
                </button>
              )
            })}
          </section>
        ))}
      </div>
      {result && (
        <article className={`result-card tone-${result.tone}`}>
          <div><span className="eyebrow">Result</span><h2>{result.title}</h2></div>
          <p>{result.summary}</p>
          <details><summary>{result.proofLabel}</summary><p>Open durable details below to inspect the recorded Evidence, Verification, and exact execution identity.</p></details>
        </article>
      )}
      {projection && (
        <details className="work-details">
          <summary>Selected work details</summary>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, color: 'var(--text2)', fontSize: 13 }}>
            <strong>Durable details</strong>
            <span style={{ color: 'var(--muted2)' }}>{presentRuntimeStatus(projection.job?.status ?? projection.receipt.status).label}</span>
          </div>
          <div style={{ marginTop: 7, color: 'var(--muted3)', fontSize: 12, fontFamily: 'var(--mono)' }}>
            {projection.identity.jobId} · {projection.identity.attemptId} · generation {projection.identity.generation ?? 0} · run {projection.identity.runId}
          </div>
          <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 10, color: 'var(--muted3)', fontSize: 12 }}>
            <span>Timeline: {projection.timeline?.length ?? 0}</span>
            <span>Worker Tree: {projection.workers?.length ?? 0}</span>
            <span>Pending Approvals: {pendingApprovals.length}</span>
            <span>Evidence: {projection.evidence?.length ?? 0}</span>
          </div>
          {pendingApprovals.map((approval) => (
            <div key={approval.approvalId} style={{ marginTop: 8, color: 'var(--orange)', fontSize: 11, fontFamily: 'var(--mono)' }}>
              Approval pending · {approval.toolName} · {approval.approvalId}
            </div>
          ))}
          <div style={{ marginTop: 8, color: 'var(--muted3)', fontSize: 12 }}>
            <strong style={{ color: 'var(--text2)' }}>Verification / Proof</strong>
            {' · '}{projection.receipt.verdict?.verdict ?? 'not yet verified'}
          </div>
          {projection.receipt.terminal && (
            <div style={{ marginTop: 8, color: 'var(--text2)', fontSize: 12 }}>
              <strong>Canonical Result Receipt</strong> · {projection.receipt.summary ?? projection.receipt.status}
            </div>
          )}
          {continuity && (
            <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)', color: 'var(--text2)', fontSize: 12 }}>
              <strong>Continuity / Continue</strong> · Recovery Reason: {continuity.reason}
              {continuity.blockers.length > 0 && (
                <div style={{ marginTop: 5, color: 'var(--red)' }}>Blocked: {continuity.blockers.join(' · ')}</div>
              )}
              {continuity.proposedNext.length > 0 && (
                <div style={{ marginTop: 5, color: 'var(--muted3)' }}>Next: {continuity.proposedNext.join(' · ')}</div>
              )}
              {!projection.receipt.terminal && projection.receipt.status === 'paused' && (
                <button
                  type="button"
                  disabled={continueResult.pending || continuity.validity !== 'current' || continuity.blockers.length > 0}
                  onClick={() => {
                    const key = continueKeys.current[continuity.checkpointId]
                      ?? `workbench-continue:${continuity.checkpointId}:${Date.now()}`
                    continueKeys.current[continuity.checkpointId] = key
                    setContinueResult({ pending: true })
                    void aiden.continueTask(continuity.checkpointId, projection.identity.jobId, key)
                      .then((result) => {
                        setContinueResult({ pending: false, accepted: result.accepted, reason: result.reason ?? result.decision })
                        if (result.accepted && result.attemptId && result.runId !== undefined) {
                          aiden.persistRunHandle({
                            admission: {
                              accepted: true,
                              jobId: projection.identity.jobId,
                              attemptId: result.attemptId,
                              runId: result.runId,
                              duplicate: result.decision === 'already_applied',
                            },
                            lastEventId: 0,
                          })
                          onContinued?.(projection.identity.jobId, result.attemptId, result.runId)
                          setProjectionRevision((value) => value + 1)
                        }
                      })
                      .catch((error) => setContinueResult({ pending: false, accepted: false, reason: error instanceof Error ? error.message : String(error) }))
                  }}
                  style={{ marginTop: 8 }}
                >
                  {continueResult.pending ? 'Checking durable state…' : 'Continue safely'}
                </button>
              )}
              {continueResult.reason && (
                <div style={{ marginTop: 5, color: continueResult.accepted ? 'var(--green)' : 'var(--red)' }}>
                  {continueResult.reason}
                </div>
              )}
            </div>
          )}
        </details>
      )}
      {(logs.length > 0 || (projection?.timeline?.length ?? 0) > 0) && (
        <details className="work-details activity-details">
          <summary>Detailed activity</summary>
          {logs.length === 0 ? (
            <p>Durable timeline restored · {projection?.timeline?.length ?? 0} ordered events</p>
          ) : (
            <div className="activity-detail-list">
              {logs.map((l, i) => (
                <div key={i} className="activity-detail-row">
                  <span style={{ color: color(l.style), textAlign: 'center', fontWeight: 700 }}>{l.icon}</span>
                  <span>{l.message}</span>
                  <time>{l.time}</time>
                </div>
              ))}
            </div>
          )}
        </details>
      )}
    </div>
  )
}

interface MiniPromptConfig { type: 'websearch' | 'research' | 'stocks'; placeholder: string }

type MenuItem =
  | { id: string; icon: string; label: string; action: () => void; children?: never }
  | { id: string; icon: string; label: string; children: { id: string; icon: string; label: string; action: () => void }[]; action?: never }

// ── Provider metadata ─────────────────────────────────────────

const PROVIDER_INFO: Record<string, {
  label: string; color: string; freeUrl: string; defaultModel: string; models: string[]
}> = {
  groq:       { label: 'Groq',       color: '#f55036', freeUrl: 'https://console.groq.com',                   defaultModel: 'llama-3.3-70b-versatile',           models: ['llama-3.3-70b-versatile', 'llama-3.1-70b-versatile', 'mixtral-8x7b-32768', 'gemma2-9b-it'] },
  gemini:     { label: 'Gemini',     color: '#4285f4', freeUrl: 'https://aistudio.google.com/app/apikey',     defaultModel: 'gemini-1.5-flash',                  models: ['gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-2.0-flash-exp'] },
  openrouter: { label: 'OpenRouter', color: '#7c3aed', freeUrl: 'https://openrouter.ai/keys',                 defaultModel: 'meta-llama/llama-3.3-70b-instruct', models: ['meta-llama/llama-3.3-70b-instruct', 'google/gemini-flash-1.5', 'mistralai/mistral-7b-instruct:free'] },
  cerebras:   { label: 'Cerebras',   color: '#059669', freeUrl: 'https://cloud.cerebras.ai',                  defaultModel: 'llama3.1-8b',                       models: ['llama3.1-8b', 'llama3.3-70b'] },
  nvidia:     { label: 'NVIDIA NIM', color: '#76b900', freeUrl: 'https://build.nvidia.com/explore/discover',  defaultModel: 'meta/llama-3.3-70b-instruct',       models: ['meta/llama-3.3-70b-instruct', 'meta/llama-3.1-405b-instruct'] },
}

// ── Context ───────────────────────────────────────────────────

interface DevOSCtxType {
  // UI mode
  uiMode:         UIMode
  setUIMode:      (m: UIMode | ((prev: UIMode) => UIMode)) => void
  execMode:       ExecMode
  setExecMode:    (m: ExecMode) => void
  historyOpen:    boolean
  setHistoryOpen: (v: boolean | ((prev: boolean) => boolean)) => void
  liveViewOpen:   boolean
  setLiveViewOpen:(v: boolean | ((prev: boolean) => boolean)) => void
  collapseLiveExecution: () => void
  reopenLiveExecution: () => void
  activityOpen:   boolean
  setActivityOpen:(v: boolean | ((prev: boolean) => boolean)) => void
  settingsOpen:   boolean
  setSettingsOpen:(v: boolean) => void
  settingsTab:    string
  setSettingsTab: (v: string) => void
  mainView:       MainView
  setMainView:    Dispatch<SetStateAction<MainView>>
  appearance:     WorkbenchAppearance
  setAppearance:  Dispatch<SetStateAction<WorkbenchAppearance>>
  // Execution
  isExecuting:    boolean
  isStreaming:    boolean
  thinking:       { stage: string; message: string; tool?: string } | null
  budget:         { current: number; max: number; remaining: number } | null
  activeModel:    string
  activeProvider: string
  runtimeConnection: 'connected' | 'reconnecting' | 'unavailable'
  runtimeVersion: string
  runtimeEdition: 'community' | 'pro' | 'team' | 'enterprise'
  executionAvailable: boolean
  executionQueue: { pending: number; claimed: number; inflight: number; workerCount: number }
  workbenchReadOnly: boolean
  runProjection: aiden.WorkbenchRunProjection | null
  runArtifacts: aiden.WorkbenchArtifact[]
  capabilities: aiden.WorkbenchCapabilities | null
  browserSession: aiden.WorkbenchBrowserSession | null
  controlBrowser: (action: 'take' | 'return' | 'clear') => Promise<void>
  liveExecution: aiden.WorkbenchLiveExecutionProjection | null
  liveExecutionSelection: LiveExecutionSelection
  selectLiveExecutionSurface: (surfaceId: string) => void
  toggleLiveExecutionPin: () => void
  selectedContext: WorkbenchSelection
  activeJobs: ReturnType<WorkbenchController['active']>
  presence: aiden.WorkbenchPresenceSnapshot | null
  presenceBriefing: aiden.WorkbenchPresenceBriefing | null
  refreshPresence: () => Promise<void>
  controllerRevision: number
  // Messages / conversations
  messages:       Message[]
  setMessages:    Dispatch<SetStateAction<Message[]>>
  conversations:  Conversation[]
  setConversations: Dispatch<SetStateAction<Conversation[]>>
  currentConvId:  string
  input:          string
  setInput:       (v: string) => void
  // Activity
  activityLogs:    ActivityLog[]
  setActivityLogs: Dispatch<SetStateAction<ActivityLog[]>>
  liveActivity: LiveActivityItem[]
  // Screenshot
  screenshot:     string | null
  setScreenshot:  Dispatch<SetStateAction<string | null>>
  // Session
  sessionId:      string
  // Live view data
  systemStats:    any
  recentTasks:    any[]
  // Plus menu
  plusMenuOpen:    boolean
  setPlusMenuOpen: (v: boolean) => void
  activeSubmenu:   string | null
  setActiveSubmenu:(v: string | null) => void
  channelStatuses: Record<string, boolean>
  channelModal:    string | null
  setChannelModal: (v: string | null) => void
  miniPrompt:      MiniPromptConfig | null
  setMiniPrompt:   (v: MiniPromptConfig | null) => void
  miniPromptValue: string
  setMiniPromptValue:(v: string) => void
  // Voice
  voiceStatus:    { stt: boolean; tts: boolean }
  isRecording:    boolean
  ttsEnabled:     boolean
  setTtsEnabled:  (v: boolean) => void
  recordingTimer: number
  startRecording: () => void
  // Handlers
  sendMessage:     (text?: string) => void
  stopExecution:   () => void
  takeScreenshot:  () => void
  submitMiniPrompt:() => void
  startNewChat:   () => void
  loadConversation: (id: string) => void
  selectActiveJob: (job: ReturnType<WorkbenchController['active']>[number]) => void
  handleQuickUpload: (e: ChangeEvent<HTMLInputElement>) => void
  addAttachmentFiles: (files: readonly File[]) => Promise<void>
  attachments: aiden.WorkbenchAttachment[]
  removeAttachment: (id: string) => void
  refreshProjection: () => void
  clearCurrentView: () => void
  // Refs
  inputRef:       RefObject<HTMLTextAreaElement>
  kbInputRef:     RefObject<HTMLInputElement>
  messagesEndRef: RefObject<HTMLDivElement>
  logsEndRef:     RefObject<HTMLDivElement>
  // API Keys (settings)
  providers:      any[]
  routing:        any
  addingProvider: string | null
  setAddingProvider: (v: string | null) => void
  providerKeys:   Record<string, string>
  setProviderKeys:(v: SetStateAction<Record<string, string>>) => void
  providerModels: Record<string, string>
  setProviderModels:(v: SetStateAction<Record<string, string>>) => void
  savingKey:      boolean
  saveKey:        (providerID: string) => void
  toggleProvider: (name: string, enabled: boolean) => void
  deleteProvider: (name: string) => void
  resetLimits:    () => void
  // Knowledge base (settings)
  knowledgeFiles:    any[]
  knowledgeStats:    any
  uploadingFile:     boolean
  uploadCategory:    string
  setUploadCategory: (v: string) => void
  knowledgeInputRef: RefObject<HTMLInputElement>
  handleKnowledgeUpload: (e: ChangeEvent<HTMLInputElement>) => void
  handleKnowledgeDelete: (id: string) => void
  // License / Pro
  pricingOpen:    boolean
  setPricingOpen: (v: boolean) => void
  licenseStatus:  {
    active:    boolean
    isPro:     boolean
    plan:      string
    expiresAt: string
    features:  Record<string, boolean | number>
    tier:      string
    email:     string
    expiry:    number
  }
  licenseKey:     string
  setLicenseKey:  (v: string) => void
  activatingKey:  boolean
  licenseMsg:     { type: 'success' | 'error'; text: string } | null
  setLicenseMsg:  (v: { type: 'success' | 'error'; text: string } | null) => void
  validateKey:    (key: string) => Promise<{ success: boolean; error?: string }>
  clearProLicense:() => Promise<void>
  // Update banner
  updateBanner:    { version: string; url: string } | null
  setUpdateBanner: (v: { version: string; url: string } | null) => void
}

const DevOSCtx = createContext<DevOSCtxType>(null!)
function useDevOS() { return useContext(DevOSCtx) }

// ── Style constants ───────────────────────────────────────────

const codeStyle: CSSProperties = {
  background: 'var(--bg3)', border: '1px solid var(--border)',
  borderRadius: 3, padding: '1px 6px',
  fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text)',
}
const settingsTextStyle: CSSProperties = {
  fontSize: 12, color: 'var(--muted2)',
  fontFamily: 'var(--mono)', lineHeight: 1.7,
}

// ── UpgradeToast ─────────────────────────────────────────────
// Sprint 19: shown when a free tier limit is hit (403 + upgrade: true)

function UpgradeToast({
  message,
  action,
  onAction,
  onDismiss,
}: {
  message:   string
  action:    string
  onAction:  () => void
  onDismiss: () => void
}) {
  return (
    <div style={{
      position:    'fixed',
      bottom:      20,
      right:       20,
      zIndex:      9000,
      background:  'var(--bg2)',
      border:      '1px solid rgba(167,139,250,0.4)',
      borderRadius: 10,
      padding:     '12px 16px',
      display:     'flex',
      alignItems:  'center',
      gap:         12,
      maxWidth:    380,
      boxShadow:   '0 8px 32px rgba(0,0,0,0.5)',
      animation:   'fadeInUp 0.25s ease-out',
      fontFamily:  'var(--mono)',
    }}>
      <span style={{ fontSize: 18 }}>🔒</span>
      <span style={{ flex: 1, fontSize: 11, color: 'var(--text)', lineHeight: 1.5 }}>{message}</span>
      <button
        onClick={() => { onAction(); onDismiss() }}
        style={{
          background:   'linear-gradient(135deg,#7c3aed,#a855f7)',
          border:       'none',
          borderRadius:  6,
          color:        '#fff',
          fontSize:     10,
          fontWeight:   700,
          padding:      '5px 12px',
          cursor:       'pointer',
          whiteSpace:   'nowrap',
          fontFamily:   'var(--mono)',
        }}
      >{action}</button>
      <button
        onClick={onDismiss}
        style={{
          background: 'none', border: 'none',
          color: 'var(--muted)', cursor: 'pointer',
          fontSize: 14, padding: '0 2px', lineHeight: 1,
        }}
      >✕</button>
    </div>
  )
}

// ── PatternSuggestionBanner ───────────────────────────────────
// Shown when the cognition engine detects a repetitive pattern.
// Offers a one-click "Set it up" that creates a scheduled task.

function PatternSuggestionBanner({
  pattern,
  onDismiss,
  onSetup,
  onUpgrade,
}: {
  pattern:    AutomationPattern
  onDismiss:  () => void
  onSetup:    (goal: string) => void
  onUpgrade?: (message: string) => void
}) {
  const [setting, setSetting] = useState(false)
  const [done,    setDone]    = useState(false)

  const handleSetup = async () => {
    setSetting(true)
    try {
      const r = await fetch('http://localhost:4200/api/scheduler/tasks', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          description: `Auto: ${pattern.pattern.replace(/_/g, ' ')}`,
          schedule:    pattern.automationGoal.match(/every [^,]+/i)?.[0] ?? 'daily at 8am',
          goal:        pattern.automationGoal,
        }),
      })
      // Sprint 19: handle free tier limit
      if (r.status === 403) {
        const d = await r.json() as any
        if (d.upgrade && onUpgrade) { onUpgrade(d.message); onDismiss(); return }
      }
      setDone(true)
      setTimeout(onDismiss, 2000)
    } catch {
      setSetting(false)
    }
  }

  return (
    <div style={{
      position:       'fixed',
      bottom:         52,
      left:           '50%',
      transform:      'translateX(-50%)',
      zIndex:         200,
      background:     'var(--bg2)',
      border:         '1px solid rgba(249,115,22,0.35)',
      borderRadius:   8,
      padding:        '10px 14px',
      display:        'flex',
      alignItems:     'center',
      gap:            10,
      maxWidth:       560,
      width:          'calc(100vw - 40px)',
      boxShadow:      '0 4px 24px rgba(0,0,0,0.4)',
      animation:      'fadeInUp 0.3s ease-out',
      fontFamily:     'var(--mono)',
    }}>
      <span style={{ fontSize: 16 }}>{'⚡'}</span>
      <span style={{ flex: 1, fontSize: 11, color: 'var(--text)', lineHeight: 1.5 }}>
        {done ? '✓ Scheduled! Aiden will handle this automatically.' : pattern.suggestion}
      </span>
      {!done && (
        <>
          <button
            onClick={handleSetup}
            disabled={setting}
            style={{
              background:   'rgba(249,115,22,0.15)',
              border:       '1px solid rgba(249,115,22,0.4)',
              borderRadius:  4,
              color:        'var(--orange)',
              fontSize:     10,
              padding:      '4px 10px',
              cursor:       setting ? 'wait' : 'pointer',
              fontFamily:   'var(--mono)',
              whiteSpace:   'nowrap',
            }}
          >
            {setting ? 'Setting up…' : 'Set it up'}
          </button>
          <button
            onClick={onDismiss}
            style={{
              background: 'transparent',
              border:     'none',
              color:      'var(--muted)',
              cursor:     'pointer',
              fontSize:   14,
              padding:    '0 2px',
            }}
            title="Dismiss"
          >
            {'×'}
          </button>
        </>
      )}
    </div>
  )
}

// ── NavBtn ────────────────────────────────────────────────────

function NavBtn({
  children, active, onClick, title,
}: {
  children: ReactNode
  active?:  boolean
  onClick:  () => void
  title?:   string
}) {
  return (
    <button onClick={onClick} title={title} style={{
      width: 30, height: 30, borderRadius: 5,
      background: active ? 'rgba(249,115,22,0.12)' : 'transparent',
      border:     active ? '1px solid rgba(249,115,22,0.25)' : '1px solid transparent',
      color:      active ? 'var(--orange)' : 'var(--muted2)',
      cursor: 'pointer', fontSize: 13, transition: 'all 0.15s',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      {children}
    </button>
  )
}

// ── ExportButton ──────────────────────────────────────────────

function ExportButton() {
  const [open, setOpen] = useState(false)
  const { messages, currentConvId } = useDevOS()

  const exportCurrentConversation = (format: 'md' | 'json') => {
    const content = format === 'json'
      ? JSON.stringify({ id: currentConvId || null, exportedAt: new Date().toISOString(), messages }, null, 2)
      : messages.map((message) => {
          const attachments = message.attachments?.length
            ? `\n\nAttachments: ${message.attachments.map((item) => item.name).join(', ')}`
            : ''
          return `## ${message.role === 'user' ? 'You' : 'Aiden'}\n\n${message.content}${attachments}`
        }).join('\n\n')
    const blob = new Blob([content], { type: format === 'json' ? 'application/json' : 'text/markdown' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `aiden-conversation-${currentConvId || 'current'}.${format}`
    a.click()
    URL.revokeObjectURL(a.href)
    setOpen(false)
  }

  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(v => !v)}
        title="Export conversation"
        style={{
          width: 30, height: 30, borderRadius: 5,
          background: 'transparent', border: '1px solid transparent',
          color: 'var(--muted2)', cursor: 'pointer', fontSize: 13,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          transition: 'all 0.15s',
        }}
      >↓</button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 49 }} />
          <div style={{
            position: 'absolute', top: '100%', right: 0, zIndex: 50,
            background: '#1a1a1a', border: '1px solid #333', borderRadius: 6,
            padding: 4, minWidth: 160, marginTop: 4,
          }}>
            {(['md', 'json'] as const).map(fmt => (
              <button key={fmt} onClick={() => exportCurrentConversation(fmt)} style={{
                display: 'block', width: '100%', textAlign: 'left',
                padding: '8px 12px', background: 'none', border: 'none',
                borderRadius: 4, color: '#ccc', cursor: 'pointer', fontSize: 13,
                fontFamily: 'var(--mono)',
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = '#333'; (e.currentTarget as HTMLButtonElement).style.color = '#f97316' }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'none';  (e.currentTarget as HTMLButtonElement).style.color = '#ccc' }}
              >
                Export as {fmt === 'md' ? 'Markdown' : 'JSON'}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

// ── MarkdownContent ───────────────────────────────────────────

function MarkdownContent({ content }: { content: string }) {
  const parts = content.split(/(```[\s\S]*?```)/g)
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith('```')) {
          const lines = part.slice(3).split('\n')
          const lang  = lines[0]
          const code  = lines.slice(1, -1).join('\n')
          return (
            <div key={i} style={{
              background: 'var(--bg)', border: '1px solid var(--border)',
              borderRadius: 6, padding: '10px 14px', margin: '8px 0',
              overflow: 'auto',
            }}>
              {lang && (
                <div style={{ fontSize: 9, color: 'var(--muted)', marginBottom: 6, textTransform: 'uppercase' }}>
                  {lang}
                </div>
              )}
              <pre style={{ margin: 0, fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text)', whiteSpace: 'pre-wrap' }}>
                {code}
              </pre>
            </div>
          )
        }
        const formatted = part
          .replace(/\*\*(.*?)\*\*/g, '<strong style="color:var(--text);font-weight:600">$1</strong>')
          .replace(/`(.*?)`/g,       '<code style="background:var(--bg3);border:1px solid var(--border);border-radius:3px;padding:1px 5px;font-family:var(--mono);font-size:12px">$1</code>')
        return <span key={i} dangerouslySetInnerHTML={{ __html: formatted }} />
      })}
    </>
  )
}

// ── ChatMessage ───────────────────────────────────────────────

// ── Tool summary text generation ──────────────────────────────
type StepLike = { tool: string; status: string; duration?: number }

function getToolSummary(steps: StepLike[]): string {
  if (steps.length === 0) return 'Running…'
  if (steps.length === 1) {
    switch (steps[0].tool) {
      case 'web_search':      return 'Searched the web'
      case 'deep_research':   return 'Researched in depth'
      case 'run_python':      return 'Executed Python code'
      case 'run_node':        return 'Executed Node.js code'
      case 'shell_exec':      return 'Ran a command'
      case 'file_read':       return 'Read a file'
      case 'file_write':      return 'Created a file'
      case 'file_edit':       return 'Edited a file'
      case 'file_list':       return 'Listed files'
      case 'system_info':     return 'Checked system info'
      case 'screenshot':      return 'Took a screenshot'
      case 'screen_read':     return 'Read the screen'
      case 'open_browser':    return 'Opened browser'
      case 'get_market_data': return 'Fetched market data'
      case 'notify':          return 'Sent notification'
      case 'manage_goals':    return 'Updated goals'
      case 'memory_recall':   return 'Recalled memory'
      case 'memory_store':    return 'Stored to memory'
      case 'git_commit':      return 'Committed to git'
      case 'git_push':        return 'Pushed to git'
      case 'mouse_click':     return 'Clicked on screen'
      case 'keyboard_type':   return 'Typed on keyboard'
      case 'respond':         return 'Composed response'
      default:                return `Ran ${steps[0].tool}`
    }
  }
  // Multiple steps — group by action type
  const searched = steps.filter(s => ['web_search', 'deep_research'].includes(s.tool))
  const read     = steps.filter(s => s.tool === 'file_read')
  const wrote    = steps.filter(s => ['file_write', 'file_edit'].includes(s.tool))
  const ran      = steps.filter(s => ['run_python', 'run_node', 'shell_exec'].includes(s.tool))
  const screen   = steps.filter(s => ['screenshot', 'screen_read', 'mouse_click', 'keyboard_type'].includes(s.tool))
  const other    = steps.filter(s =>
    !['web_search','deep_research','file_read','file_write','file_edit',
      'run_python','run_node','shell_exec','screenshot','screen_read',
      'mouse_click','keyboard_type'].includes(s.tool)
  )
  const parts: string[] = []
  if (searched.length) parts.push(searched.length === 1 ? 'searched the web' : `ran ${searched.length} searches`)
  if (read.length)     parts.push(read.length === 1     ? 'read a file'      : `read ${read.length} files`)
  if (wrote.length)    parts.push(wrote.length === 1    ? 'wrote a file'     : `wrote ${wrote.length} files`)
  if (ran.length)      parts.push(ran.length === 1      ? 'ran a command'    : `ran ${ran.length} commands`)
  if (screen.length)   parts.push(screen.length === 1   ? 'controlled screen': `ran ${screen.length} screen actions`)
  if (other.length)    parts.push(other.length === 1    ? other[0].tool      : `${other.length} more actions`)
  return parts.length ? parts.join(', ') : `ran ${steps.length} steps`
}

// ── ToolExecutionCard — collapsible tool-execution card ────
function ToolExecutionCard({ phases }: { phases: Phase[] }) {
  const [open, setOpen] = useState(false)

  // Flatten all steps from all phases into one list
  const allSteps = phases.flatMap(p => p.steps)
  const totalSteps = allSteps.length
  if (totalSteps === 0) return null

  const anyRunning = allSteps.some(s => s.status === 'running' || s.status === 'pending')
  const anyFailed  = allSteps.some(s => s.status === 'failed')
  const allDone    = !anyRunning

  // Total time = sum of all step durations, or phase count hint
  const totalMs = allSteps.reduce((acc, s) => acc + (s.duration ?? 0), 0)
  const timeStr = totalMs > 0
    ? totalMs >= 1000 ? `${(totalMs / 1000).toFixed(1)}s` : `${totalMs}ms`
    : anyRunning ? '…' : ''

  const summary = getToolSummary(allSteps)
  const multiPhase = phases.length > 1

  return (
    <div style={{
      width: '100%', marginBottom: 8,
      background: '#161616',
      border: '1px solid #2a2a2a',
      borderRadius: 8, overflow: 'hidden',
      fontFamily: 'var(--mono)',
    }}>
      {/* Header row — always visible, click to toggle */}
      <div
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '7px 12px', cursor: 'pointer',
          userSelect: 'none',
        }}
      >
        {/* Chevron */}
        <span style={{
          fontSize: 9, color: '#555',
          transition: 'transform 0.15s',
          display: 'inline-block',
          transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
        }}>▶</span>

        {/* Summary */}
        <span style={{ flex: 1, fontSize: 11, color: '#888' }}>
          {multiPhase
            ? <><span style={{ color: '#666' }}>Plan · </span>{summary}</>
            : summary
          }
        </span>

        {/* Time */}
        {timeStr && (
          <span style={{ fontSize: 10, color: '#555' }}>{timeStr}</span>
        )}

        {/* Status dot */}
        <span style={{
          fontSize: 11,
          color: anyRunning ? '#f97316' : anyFailed ? '#ef4444' : '#4ade80',
        }}>
          {anyRunning ? (
            <span style={{ animation: 'pulse-dot 1s infinite' }}>●</span>
          ) : anyFailed ? '✗' : '✓'}
        </span>
      </div>

      {/* Expanded detail */}
      {open && (
        <div style={{
          borderTop: '1px solid #222',
          padding: '6px 0',
        }}>
          {phases.map((phase, pi) => (
            <div key={pi}>
              {/* Phase header — only when multiple phases */}
              {multiPhase && (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '4px 12px 2px',
                }}>
                  <span style={{ fontSize: 10, color: '#f97316' }}>📋</span>
                  <span style={{ fontSize: 10, color: '#666' }}>
                    Phase {phase.index}/{phase.total}: {phase.name}
                  </span>
                  <span style={{
                    fontSize: 9,
                    color: phase.status === 'done' ? '#4ade80' : phase.status === 'pending' ? '#555' : '#f97316',
                  }}>
                    {phase.status === 'done' ? '✓' : phase.status === 'pending' ? '○' : '●'}
                  </span>
                </div>
              )}

              {/* Steps */}
              {phase.steps.map((step, si) => {
                const statusColor =
                  step.status === 'done'    ? '#4ade80' :
                  step.status === 'failed'  ? '#ef4444' :
                  step.status === 'running' ? '#f97316' : '#444'
                const statusIcon =
                  step.status === 'done'    ? '✓' :
                  step.status === 'failed'  ? '✗' :
                  step.status === 'running' ? '●' : '○'
                const durStr = step.duration
                  ? step.duration >= 1000
                    ? ` ${(step.duration / 1000).toFixed(1)}s`
                    : ` ${step.duration}ms`
                  : ''

                return (
                  <div key={si} style={{
                    display: 'flex', alignItems: 'baseline', gap: 8,
                    padding: '3px 12px 3px 28px',
                  }}>
                    <span style={{ fontSize: 10, color: statusColor, flexShrink: 0 }}>{statusIcon}</span>
                    <span style={{ fontSize: 11, color: '#FF8C00', flexShrink: 0, fontWeight: 600 }}>
                      {step.tool}
                    </span>
                    {durStr && (
                      <span style={{ fontSize: 10, color: '#444', flexShrink: 0 }}>{durStr}</span>
                    )}
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── ChatMessage ───────────────────────────────────────────────

function ChatMessage({ message }: { message: Message }) {
  const [copied, setCopied] = useState(false)
  const isUser     = message.role === 'user'
  const isBriefing = !!message.isBriefing
  const presentedContent = isUser ? message.content : presentAssistantContent(message.content)

  const copyMessage = () => {
    navigator.clipboard.writeText(presentedContent).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div style={{
      marginBottom: 24,
      display: 'flex', flexDirection: 'column',
      alignItems: isUser ? 'flex-end' : 'flex-start',
      animation: 'fadeInUp 0.25s ease-out',
    }}>
      {/* Label — briefing gets an orange pill, normal messages get plain text */}
      {isBriefing ? (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, paddingLeft: 4,
        }}>
          <span style={{
            fontSize: 9, fontFamily: 'var(--mono)', textTransform: 'uppercase',
            letterSpacing: '0.12em', color: '#f97316',
            background: 'rgba(249,115,22,0.12)',
            border: '1px solid rgba(249,115,22,0.25)',
            borderRadius: 4, padding: '2px 6px',
          }}>
            {message.briefingLabel ?? 'Morning Briefing'}
          </span>
        </div>
      ) : (
        <div style={{
          fontSize: 9, color: 'var(--muted)', textTransform: 'uppercase',
          letterSpacing: '0.1em', marginBottom: 4,
          fontFamily: 'var(--mono)',
          paddingLeft: isUser ? 0 : 4,
          paddingRight: isUser ? 4 : 0,
        }}>
          {isUser ? 'You' : 'Aiden'}
        </div>
      )}

      {/* Tool execution card */}
      {!isUser && message.phases && message.phases.length > 0 && (
        <ToolExecutionCard phases={message.phases} />
      )}

      {isUser && message.attachments && message.attachments.length > 0 && (
        <div className="message-attachments">
          {message.attachments.map((attachment) => (
            <span key={attachment.id}>📎 {attachment.name} <small>{attachment.size} bytes</small></span>
          ))}
        </div>
      )}

      {/* Bubble */}
      <div className={`message-bubble ${isUser ? 'is-user' : 'is-assistant'}`} style={{
        position: 'relative', maxWidth: '85%',
        background: isUser ? 'var(--bg2)' : isBriefing ? 'rgba(249,115,22,0.04)' : 'transparent',
        border: `1px solid ${
          isUser
            ? 'var(--border2)'
            : isBriefing
              ? 'rgba(249,115,22,0.18)'
              : 'transparent'
        }`,
        borderRadius: isUser ? '15px 15px 4px 15px' : 0,
        padding: isUser ? '10px 14px' : '2px 4px',
      }}>
        {/* Thinking dots */}
        {message.isStreaming && !message.content && (
          <div style={{ display: 'flex', gap: 4, padding: '4px 0' }}>
            {[0, 1, 2].map(i => (
              <span key={i} style={{
                width: 6, height: 6, borderRadius: '50%',
                background: 'var(--orange)', display: 'inline-block',
                animation: `thinkingPulse 1.4s ${i * 0.2}s infinite ease-in-out`,
              }} />
            ))}
          </div>
        )}

        {/* Content */}
        {presentedContent && (
          <div style={{
            fontFamily: 'var(--sans)', fontSize: 15,
            color: isUser ? 'var(--text)' : 'var(--muted3)',
            lineHeight: 1.65, whiteSpace: 'pre-wrap',
          }}>
            <MarkdownContent content={presentedContent} />
          </div>
        )}

        {/* Copy button */}
        {presentedContent && !message.isStreaming && (
          <button onClick={copyMessage} className="copy-btn" style={{
            position: 'absolute', top: 8, right: 8,
            background: 'var(--bg3)', border: '1px solid var(--border2)',
            borderRadius: 4, padding: '2px 8px',
            fontFamily: 'var(--mono)', fontSize: 10,
            color: copied ? 'var(--green)' : 'var(--muted)',
            cursor: 'pointer',
          }}>
            {copied ? '✓ copied' : '⎘ copy'}
          </button>
        )}
      </div>

      {/* Provider badge */}
      {!isUser && message.provider && !message.isStreaming && (
        <div style={{
          fontSize: 9, color: 'var(--muted)', marginTop: 4,
          fontFamily: 'var(--mono)', paddingLeft: 4,
        }}>
          via {message.provider}
        </div>
      )}
    </div>
  )
}

// ── SettingsSection ───────────────────────────────────────────

function SettingsSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{
        fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase',
        letterSpacing: '0.12em', marginBottom: 10, fontFamily: 'var(--mono)',
      }}>
        {title}
      </div>
      {children}
    </div>
  )
}

// ── LocalAISection ────────────────────────────────────────────

interface OllamaDiscovery {
  available: boolean
  models:    { name: string; role: string }[]
  assigned?: { planner: string|null; responder: string|null; coder: string|null; fast: string|null }
}

function LocalAISection() {
  const [data,    setData]    = useState<OllamaDiscovery | null>(null)
  const [loading, setLoading] = useState(true)
  const [responder, setResponder] = useState('')
  const [coder,     setCoder]     = useState('')
  const [fast,      setFast]      = useState('')
  const [saving,    setSaving]    = useState(false)
  const [toast,     setToast]     = useState('')

  const fetchModels = async () => {
    setLoading(true)
    try {
      const r = await fetch('http://localhost:4200/api/ollama/models')
      const d = await r.json() as OllamaDiscovery
      setData(d)
      if (d.assigned) {
        setResponder(d.assigned.responder || '')
        setCoder(d.assigned.coder     || '')
        setFast(d.assigned.fast       || '')
      }
    } catch {
      setData({ available: false, models: [] })
    }
    setLoading(false)
  }

  useEffect(() => { fetchModels() }, [])

  const save = async () => {
    setSaving(true)
    try {
      await fetch('http://localhost:4200/api/ollama/config', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ responder, coder, fast }),
      })
      setToast('✅ Local AI models updated')
      setTimeout(() => setToast(''), 3000)
    } catch {}
    setSaving(false)
  }

  const allModels = data?.models?.map(m => m.name) || []

  return (
    <div style={{
      background: 'var(--bg2)', border: '1px solid var(--border)',
      borderRadius: 8, padding: '12px 14px', marginBottom: 16,
      borderLeft: `3px solid ${data?.available ? 'var(--green)' : 'var(--muted)'}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span style={{ fontSize: 12, fontFamily: 'var(--mono)', color: 'var(--text)', fontWeight: 600 }}>
          🖥 Local AI (Ollama)
        </span>
        <span style={{
          marginLeft: 'auto', fontSize: 9, fontFamily: 'var(--mono)',
          color: data?.available ? 'var(--green)' : 'var(--muted)',
          background: data?.available ? 'rgba(34,197,94,0.1)' : 'var(--bg3)',
          padding: '2px 7px', borderRadius: 10,
        }}>
          {loading ? 'detecting...' : data?.available
            ? `✓ running — ${data.models.length} model${data.models.length !== 1 ? 's' : ''}`
            : '● not running'}
        </span>
        <button onClick={fetchModels} title="Refresh" style={{
          fontSize: 11, background: 'transparent', border: 'none',
          color: 'var(--muted2)', cursor: 'pointer', padding: '0 4px',
        }}>↺</button>
      </div>

      {data?.available && allModels.length > 0 ? (
        <>
          {[
            { label: 'Chat / Responder', val: responder, set: setResponder },
            { label: 'Code tasks',       val: coder,     set: setCoder     },
            { label: 'Fast / Executor',  val: fast,      set: setFast      },
          ].map(row => (
            <div key={row.label} style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 9, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 3, fontFamily: 'var(--mono)' }}>
                {row.label}
              </div>
              <select
                value={row.val}
                onChange={e => row.set(e.target.value)}
                style={{
                  width: '100%', background: 'var(--bg3)',
                  border: '1px solid var(--border2)', borderRadius: 5,
                  padding: '6px 10px', fontFamily: 'var(--mono)', fontSize: 11,
                  color: 'var(--text)', outline: 'none',
                }}
              >
                <option value="">— auto (best available) —</option>
                {allModels.map(m => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </div>
          ))}
          <button onClick={save} disabled={saving} style={{
            width: '100%', marginTop: 6, padding: '7px', borderRadius: 5,
            background: 'var(--orange)', border: 'none', color: '#000',
            fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600,
            cursor: saving ? 'default' : 'pointer', opacity: saving ? 0.7 : 1,
          }}>
            {saving ? 'Saving...' : 'Save Local AI Settings'}
          </button>
          {toast && (
            <div style={{ fontSize: 10, color: 'var(--green)', fontFamily: 'var(--mono)', marginTop: 6, textAlign: 'center' }}>
              {toast}
            </div>
          )}
        </>
      ) : !loading ? (
        <div>
          <div style={{ fontSize: 11, color: 'var(--muted2)', fontFamily: 'var(--mono)', marginBottom: 8 }}>
            Run Aiden completely offline with free local AI models.
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <a href="https://ollama.com" target="_blank" rel="noopener noreferrer" style={{
              flex: 1, padding: '6px', borderRadius: 5, textAlign: 'center',
              background: 'var(--orange)', color: '#000', textDecoration: 'none',
              fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600,
            }}>
              Download Ollama →
            </a>
            <button onClick={fetchModels} style={{
              padding: '6px 12px', borderRadius: 5, background: 'transparent',
              border: '1px solid var(--border2)', color: 'var(--muted2)',
              fontFamily: 'var(--mono)', fontSize: 11, cursor: 'pointer',
            }}>
              Refresh ↺
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

// ── ApiKeysTab ────────────────────────────────────────────────

function ApiKeysTab() {
  const {
    providers, routing, addingProvider, setAddingProvider,
    providerKeys, setProviderKeys, providerModels, setProviderModels,
    savingKey, saveKey, toggleProvider, deleteProvider, resetLimits,
  } = useDevOS()

  // ── Inline key validation ────────────────────────────────────
  const [keyValidation, setKeyValidation] = useState<Record<string, 'valid' | 'invalid' | 'checking' | null>>({})

  const validateApiKey = async (provider: string, key: string): Promise<boolean> => {
    if (!key.trim()) return false
    try {
      const r = await fetch('http://localhost:4200/api/providers/validate', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ provider, key }),
      })
      const data = await r.json() as any
      return data.valid === true
    } catch {
      return false
    }
  }

  return (
    <div>
      {/* Local AI section — shown above cloud providers */}
      <LocalAISection />

      {/* Reset limits */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--mono)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
          Configured APIs
        </div>
        <button onClick={resetLimits} style={{
          fontSize: 10, padding: '3px 10px', borderRadius: 4,
          background: 'transparent', border: '1px solid var(--border2)',
          color: 'var(--muted2)', fontFamily: 'var(--mono)', cursor: 'pointer',
        }}>
          Reset Rate Limits
        </button>
      </div>

      {/* Existing providers */}
      {providers.map((p: any) => (
        <div key={p.name} style={{
          background: 'var(--bg2)', border: '1px solid var(--border)',
          borderRadius: 8, padding: '10px 14px', marginBottom: 8,
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <div style={{
            width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
            background: p.rateLimited ? 'var(--red)' : p.enabled ? 'var(--green)' : 'var(--muted)',
          }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, color: 'var(--text)', fontFamily: 'var(--mono)' }}>
              {p.name}
              {p.rateLimited && <span style={{ color: 'var(--red)', marginLeft: 8, fontSize: 10 }}>rate limited</span>}
            </div>
            <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--mono)', marginTop: 2 }}>
              {p.provider} · {p.model} · {p.usageCount || 0} calls
            </div>
          </div>
          <button onClick={() => toggleProvider(p.name, !p.enabled)} style={{
            fontSize: 10, padding: '2px 8px', borderRadius: 4,
            background: 'transparent', border: '1px solid var(--border2)',
            color: p.enabled ? 'var(--green)' : 'var(--muted)', fontFamily: 'var(--mono)', cursor: 'pointer',
          }}>
            {p.enabled ? 'on' : 'off'}
          </button>
          <button onClick={() => deleteProvider(p.name)} style={{
            fontSize: 10, padding: '2px 8px', borderRadius: 4,
            background: 'transparent', border: '1px solid rgba(239,68,68,0.3)',
            color: 'var(--red)', fontFamily: 'var(--mono)', cursor: 'pointer',
          }}>
            ✕
          </button>
        </div>
      ))}

      {/* Add new provider */}
      <div style={{ marginTop: 16 }}>
        <div style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 10, fontFamily: 'var(--mono)' }}>
          Add Provider
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
          {Object.entries(PROVIDER_INFO).map(([id, info]) => (
            <button key={id} onClick={() => setAddingProvider(addingProvider === id ? null : id)} style={{
              padding: '4px 12px', borderRadius: 6,
              background: addingProvider === id ? 'rgba(249,115,22,0.12)' : 'var(--bg2)',
              border: `1px solid ${addingProvider === id ? 'rgba(249,115,22,0.3)' : 'var(--border2)'}`,
              color: addingProvider === id ? 'var(--orange)' : 'var(--muted2)',
              fontFamily: 'var(--mono)', fontSize: 11, cursor: 'pointer',
            }}>
              {info.label}
            </button>
          ))}
        </div>

        {addingProvider && (
          <div style={{
            background: 'var(--bg2)', border: '1px solid var(--border)',
            borderRadius: 8, padding: 14, marginBottom: 8,
          }}>
            <div style={{ fontSize: 11, color: 'var(--muted2)', fontFamily: 'var(--mono)', marginBottom: 10 }}>
              Get free key:{' '}
              <a href={PROVIDER_INFO[addingProvider]?.freeUrl} target="_blank" rel="noopener"
                style={{ color: 'var(--orange)', textDecoration: 'none' }}>
                {PROVIDER_INFO[addingProvider]?.freeUrl}
              </a>
            </div>
            <div style={{ position: 'relative', marginBottom: 8 }}>
              <input
                placeholder="Paste API key..."
                value={providerKeys[addingProvider] || ''}
                onChange={e => {
                  const val = e.target.value
                  setProviderKeys(prev => ({ ...prev, [addingProvider]: val }))
                  // Reset validation status when user edits
                  setKeyValidation(prev => ({ ...prev, [addingProvider]: null }))
                }}
                onBlur={async (e) => {
                  const key = e.target.value.trim()
                  if (!key || !addingProvider) return
                  setKeyValidation(prev => ({ ...prev, [addingProvider]: 'checking' }))
                  const valid = await validateApiKey(addingProvider, key)
                  setKeyValidation(prev => ({ ...prev, [addingProvider]: valid ? 'valid' : 'invalid' }))
                }}
                style={{
                  width: '100%', background: 'var(--bg3)',
                  border: `1px solid ${
                    addingProvider && keyValidation[addingProvider] === 'valid'   ? 'rgba(34,197,94,0.5)'  :
                    addingProvider && keyValidation[addingProvider] === 'invalid' ? 'rgba(239,68,68,0.5)'  :
                    'var(--border2)'
                  }`,
                  borderRadius: 6,
                  padding: '8px 12px', fontFamily: 'var(--mono)', fontSize: 12,
                  color: 'var(--text)', outline: 'none', boxSizing: 'border-box',
                  transition: 'border-color 0.2s',
                }}
              />
              {/* Inline validation badge */}
              {addingProvider && keyValidation[addingProvider] === 'checking' && (
                <span style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', fontFamily: 'var(--mono)', fontSize: 10, color: '#888' }}>
                  checking...
                </span>
              )}
              {addingProvider && keyValidation[addingProvider] === 'valid' && (
                <span style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', fontFamily: 'var(--mono)', fontSize: 10, color: '#22c55e' }}>
                  ✓ valid
                </span>
              )}
              {addingProvider && keyValidation[addingProvider] === 'invalid' && (
                <span style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', fontFamily: 'var(--mono)', fontSize: 10, color: '#ef4444' }}>
                  ✗ invalid
                </span>
              )}
            </div>
            <select
              value={providerModels[addingProvider] || ''}
              onChange={e => setProviderModels(prev => ({ ...prev, [addingProvider]: e.target.value }))}
              style={{
                width: '100%', background: 'var(--bg3)',
                border: '1px solid var(--border2)', borderRadius: 6,
                padding: '8px 12px', fontFamily: 'var(--mono)', fontSize: 12,
                color: 'var(--text)', outline: 'none', marginBottom: 10,
              }}
            >
              <option value="">Default model</option>
              {PROVIDER_INFO[addingProvider]?.models.map((m: string) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
            <button
              onClick={() => saveKey(addingProvider)}
              disabled={!(providerKeys[addingProvider] || '').trim() || savingKey}
              style={{
                width: '100%', padding: '8px', borderRadius: 6,
                background: 'var(--orange)', border: 'none',
                color: '#000', fontFamily: 'var(--mono)', fontSize: 12,
                fontWeight: 600, cursor: 'pointer',
                opacity: !(providerKeys[addingProvider] || '').trim() || savingKey ? 0.5 : 1,
              }}
            >
              {savingKey ? 'Saving...' : 'Save API Key'}
            </button>
          </div>
        )}
      </div>

      {/* Routing info */}
      <div style={{ marginTop: 16, padding: 12, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8 }}>
        <div style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 6, fontFamily: 'var(--mono)' }}>
          Routing
        </div>
        <div style={{ fontSize: 11, color: 'var(--muted2)', fontFamily: 'var(--mono)' }}>
          Mode: {routing?.mode || 'auto'} · Ollama fallback: {routing?.fallbackToOllama ? 'on' : 'off'}
        </div>
      </div>
    </div>
  )
}

// ── CustomProvidersTab ────────────────────────────────────────

const CUSTOM_TEMPLATES: {
  id: string; label: string; baseUrl: string; defaultModel: string; keyRequired: boolean; docsUrl: string
}[] = [
  { id: 'together',  label: 'Together AI',   baseUrl: 'https://api.together.xyz/v1/chat/completions',            defaultModel: 'meta-llama/Llama-3-70b-chat-hf',   keyRequired: true,  docsUrl: 'https://api.together.ai' },
  { id: 'fireworks', label: 'Fireworks AI',  baseUrl: 'https://api.fireworks.ai/inference/v1/chat/completions',  defaultModel: 'accounts/fireworks/models/llama-v3p1-70b-instruct', keyRequired: true, docsUrl: 'https://fireworks.ai' },
  { id: 'deepinfra', label: 'DeepInfra',     baseUrl: 'https://api.deepinfra.com/v1/openai/chat/completions',   defaultModel: 'meta-llama/Llama-3.3-70B-Instruct', keyRequired: true,  docsUrl: 'https://deepinfra.com/dash' },
  { id: 'perplexity',label: 'Perplexity',    baseUrl: 'https://api.perplexity.ai/chat/completions',             defaultModel: 'llama-3.1-sonar-large-128k-online', keyRequired: true,  docsUrl: 'https://docs.perplexity.ai' },
  { id: 'lmstudio',  label: 'LM Studio',     baseUrl: 'http://localhost:1234/v1/chat/completions',              defaultModel: 'local-model',                       keyRequired: false, docsUrl: 'https://lmstudio.ai' },
  { id: 'ollama-oc', label: 'Ollama (OpenAI compat)', baseUrl: 'http://localhost:11434/v1/chat/completions',    defaultModel: 'llama3.2',                          keyRequired: false, docsUrl: 'https://ollama.com' },
  { id: 'vllm',      label: 'vLLM / TabbyAPI', baseUrl: 'http://localhost:8000/v1/chat/completions',           defaultModel: 'your-model-name',                   keyRequired: false, docsUrl: 'https://docs.vllm.ai' },
  { id: 'custom',    label: 'Custom Endpoint', baseUrl: '',                                                     defaultModel: '',                                  keyRequired: false, docsUrl: '' },
]

function CustomProvidersTab() {
  const [customProviders, setCustomProviders]   = useState<any[]>([])
  const [loading, setLoading]                   = useState(true)
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null)
  const [form, setForm]                         = useState({ displayName: '', baseUrl: '', apiKey: '', model: '', tier: 5 })
  const [saving, setSaving]                     = useState(false)
  const [testing, setTesting]                   = useState<string | null>(null)
  const [testResult, setTestResult]             = useState<Record<string, { ok: boolean; msg: string }>>({})

  const fetchList = async () => {
    try {
      const r    = await fetch('http://localhost:4200/api/providers/custom')
      const data = await r.json() as any
      setCustomProviders(data.customProviders || [])
    } catch { /* server may be starting */ }
    setLoading(false)
  }

  useEffect(() => { fetchList() }, [])

  const pickTemplate = (tid: string) => {
    const t = CUSTOM_TEMPLATES.find(t => t.id === tid)
    if (!t) return
    setSelectedTemplate(tid)
    setForm({ displayName: t.label, baseUrl: t.baseUrl, apiKey: '', model: t.defaultModel, tier: 5 })
  }

  const handleSave = async () => {
    if (!form.displayName || !form.baseUrl || !form.model) return
    setSaving(true)
    try {
      await fetch('http://localhost:4200/api/providers/custom', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(form),
      })
      setSelectedTemplate(null)
      setForm({ displayName: '', baseUrl: '', apiKey: '', model: '', tier: 5 })
      await fetchList()
    } catch { /* noop */ }
    setSaving(false)
  }

  const handleDelete = async (id: string) => {
    await fetch(`http://localhost:4200/api/providers/custom/${id}`, { method: 'DELETE' })
    await fetchList()
  }

  const handleTest = async (id: string) => {
    setTesting(id)
    try {
      const r    = await fetch(`http://localhost:4200/api/providers/custom/${id}/test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      const data = await r.json() as any
      setTestResult(prev => ({ ...prev, [id]: { ok: data.valid, msg: data.valid ? `✓ ${data.reply || 'ok'}` : `✗ ${data.error || 'failed'}` } }))
    } catch (e: any) {
      setTestResult(prev => ({ ...prev, [id]: { ok: false, msg: `✗ ${e.message}` } }))
    }
    setTesting(null)
  }

  const inputStyle: CSSProperties = {
    width: '100%', background: 'var(--bg3)', border: '1px solid var(--border2)',
    borderRadius: 6, padding: '7px 10px', fontFamily: 'var(--mono)', fontSize: 11,
    color: 'var(--text)', outline: 'none', boxSizing: 'border-box', marginBottom: 6,
  }

  return (
    <div>
      <div style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 12, fontFamily: 'var(--mono)' }}>
        Any OpenAI-Compatible Endpoint
      </div>

      {/* Existing custom providers */}
      {!loading && customProviders.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--mono)', marginBottom: 8 }}>Configured</div>
          {customProviders.map((cp: any) => (
            <div key={cp.id} style={{
              background: 'var(--bg2)', border: '1px solid var(--border)',
              borderRadius: 8, padding: '10px 14px', marginBottom: 6,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ width: 7, height: 7, borderRadius: '50%', background: cp.enabled ? 'var(--green)' : 'var(--muted)', flexShrink: 0 }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 12, color: 'var(--text)', fontFamily: 'var(--mono)' }}>{cp.displayName}</div>
                  <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--mono)', marginTop: 2 }}>{cp.baseUrl} · {cp.model}</div>
                  {testResult[cp.id] && (
                    <div style={{ fontSize: 10, fontFamily: 'var(--mono)', marginTop: 3, color: testResult[cp.id].ok ? 'var(--green)' : 'var(--red)' }}>
                      {testResult[cp.id].msg}
                    </div>
                  )}
                </div>
                <button onClick={() => handleTest(cp.id)} disabled={testing === cp.id} style={{
                  fontSize: 10, padding: '2px 8px', borderRadius: 4, cursor: 'pointer',
                  background: 'transparent', border: '1px solid var(--border2)', color: 'var(--muted2)', fontFamily: 'var(--mono)',
                }}>
                  {testing === cp.id ? '...' : 'test'}
                </button>
                <button onClick={() => handleDelete(cp.id)} style={{
                  fontSize: 10, padding: '2px 8px', borderRadius: 4, cursor: 'pointer',
                  background: 'transparent', border: '1px solid rgba(239,68,68,0.3)', color: 'var(--red)', fontFamily: 'var(--mono)',
                }}>✕</button>
              </div>
            </div>
          ))}
        </div>
      )}
      {loading && <div style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--mono)', marginBottom: 12 }}>Loading...</div>}

      {/* Template picker */}
      <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--mono)', marginBottom: 8 }}>Add Provider</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 12 }}>
        {CUSTOM_TEMPLATES.map(t => (
          <button key={t.id} onClick={() => pickTemplate(t.id)} style={{
            padding: '3px 10px', borderRadius: 5, fontSize: 10, cursor: 'pointer',
            background: selectedTemplate === t.id ? 'rgba(249,115,22,0.12)' : 'var(--bg2)',
            border: `1px solid ${selectedTemplate === t.id ? 'rgba(249,115,22,0.3)' : 'var(--border2)'}`,
            color: selectedTemplate === t.id ? 'var(--orange)' : 'var(--muted2)',
            fontFamily: 'var(--mono)',
          }}>{t.label}</button>
        ))}
      </div>

      {/* Add form */}
      {selectedTemplate !== null && (
        <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8, padding: 14, marginBottom: 8 }}>
          {CUSTOM_TEMPLATES.find(t => t.id === selectedTemplate)?.docsUrl && (
            <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--mono)', marginBottom: 8 }}>
              Docs:{' '}
              <a href={CUSTOM_TEMPLATES.find(t => t.id === selectedTemplate)?.docsUrl} target="_blank" rel="noopener" style={{ color: 'var(--orange)', textDecoration: 'none' }}>
                {CUSTOM_TEMPLATES.find(t => t.id === selectedTemplate)?.docsUrl}
              </a>
            </div>
          )}
          <input placeholder="Display name *" value={form.displayName} onChange={e => setForm(f => ({ ...f, displayName: e.target.value }))} style={inputStyle} />
          <input placeholder="Base URL (full chat/completions endpoint) *" value={form.baseUrl} onChange={e => setForm(f => ({ ...f, baseUrl: e.target.value }))} style={inputStyle} />
          <input placeholder="API key (leave empty for local)" value={form.apiKey} onChange={e => setForm(f => ({ ...f, apiKey: e.target.value }))} style={{ ...inputStyle, fontFamily: 'monospace' }} type="password" />
          <input placeholder="Model name *" value={form.model} onChange={e => setForm(f => ({ ...f, model: e.target.value }))} style={inputStyle} />
          <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
            <button
              onClick={handleSave}
              disabled={!form.displayName || !form.baseUrl || !form.model || saving}
              style={{
                flex: 1, padding: '7px', borderRadius: 6, cursor: 'pointer',
                background: 'var(--orange)', border: 'none',
                color: '#000', fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600,
                opacity: (!form.displayName || !form.baseUrl || !form.model || saving) ? 0.5 : 1,
              }}
            >
              {saving ? 'Saving...' : 'Save Provider'}
            </button>
            <button onClick={() => setSelectedTemplate(null)} style={{
              padding: '7px 14px', borderRadius: 6, cursor: 'pointer',
              background: 'transparent', border: '1px solid var(--border2)',
              color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 11,
            }}>Cancel</button>
          </div>
        </div>
      )}

      <div style={{ marginTop: 12, padding: 10, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 6 }}>
        <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--mono)', lineHeight: 1.7 }}>
          Custom providers use the OpenAI chat/completions wire format.<br />
          They join the routing chain before Ollama fallback (tier 5).<br />
          Leave API key empty for local endpoints (LM Studio, vLLM, Ollama).
        </div>
      </div>
    </div>
  )
}

// ── KnowledgeBaseTab ──────────────────────────────────────────

// Format badge colours: PDF=red, EPUB=purple, TXT=blue, MD=green
const FORMAT_COLORS: Record<string, { bg: string; text: string; label: string }> = {
  pdf:      { bg: 'rgba(239,68,68,0.15)',   text: '#ef4444', label: 'PDF'  },
  epub:     { bg: 'rgba(168,85,247,0.15)',  text: '#a855f7', label: 'EPUB' },
  txt:      { bg: 'rgba(59,130,246,0.15)',  text: '#3b82f6', label: 'TXT'  },
  md:       { bg: 'rgba(34,197,94,0.15)',   text: '#22c55e', label: 'MD'   },
  markdown: { bg: 'rgba(34,197,94,0.15)',   text: '#22c55e', label: 'MD'   },
}

function KnowledgeBaseTab() {
  const {
    knowledgeFiles, knowledgeStats, uploadingFile,
    uploadCategory, setUploadCategory,
    knowledgeInputRef, handleKnowledgeUpload, handleKnowledgeDelete,
  } = useDevOS()

  return (
    <div>
      <SettingsSection title="Knowledge Base">
        {knowledgeStats && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 16 }}>
            {[
              { label: 'Files',  value: knowledgeStats.files  || 0 },
              { label: 'Chunks', value: knowledgeStats.chunks || 0 },
            ].map(s => (
              <div key={s.label} style={{
                background: 'var(--bg2)', border: '1px solid var(--border)',
                borderRadius: 6, padding: '10px 12px',
              }}>
                <div style={{ fontSize: 9, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 4, fontFamily: 'var(--mono)' }}>{s.label}</div>
                <div style={{ fontSize: 18, color: 'var(--text)', fontFamily: 'var(--mono)', fontWeight: 600 }}>{s.value}</div>
              </div>
            ))}
          </div>
        )}

        {/* Upload row */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <select
            value={uploadCategory}
            onChange={e => setUploadCategory(e.target.value)}
            style={{
              flex: 1, background: 'var(--bg2)', border: '1px solid var(--border2)',
              borderRadius: 6, padding: '8px 10px', fontFamily: 'var(--mono)',
              fontSize: 12, color: 'var(--muted2)', outline: 'none',
            }}
          >
            {['general', 'work', 'personal', 'research', 'code'].map(c => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <button
            onClick={() => knowledgeInputRef.current?.click()}
            disabled={uploadingFile}
            style={{
              padding: '8px 16px', borderRadius: 6,
              background: 'var(--orange)', border: 'none',
              color: '#000', fontFamily: 'var(--mono)', fontSize: 12,
              fontWeight: 600, cursor: 'pointer',
              opacity: uploadingFile ? 0.5 : 1,
            }}
          >
            {uploadingFile ? 'Processing…' : '+ Upload File'}
          </button>
          <input
            ref={knowledgeInputRef}
            type="file" accept=".txt,.md,.pdf,.epub,.markdown"
            style={{ display: 'none' }}
            onChange={handleKnowledgeUpload}
          />
        </div>
        <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--mono)', marginBottom: 12 }}>
          Supports PDF, EPUB, TXT, MD · max 50 MB · processed locally
        </div>

        {/* File list */}
        {knowledgeFiles.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '24px 0', color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 11 }}>
            No files in knowledge base yet
          </div>
        ) : (
          knowledgeFiles.map((f: any) => {
            const fmt      = FORMAT_COLORS[f.format] || FORMAT_COLORS['txt']
            const sizePart = f.fileSizeMB  ? `${f.fileSizeMB} MB` : null
            const wordPart = f.wordCount   ? `${f.wordCount.toLocaleString()} words` : null
            const pagePart = f.pageCount   ? `${f.pageCount} pp` : null
            const meta     = [f.category, f.chunkCount + ' chunks', wordPart, pagePart, sizePart].filter(Boolean).join(' · ')

            return (
              <div key={f.id} style={{
                background: 'var(--bg2)', border: '1px solid var(--border)',
                borderRadius: 6, padding: '8px 12px', marginBottom: 6,
                display: 'flex', alignItems: 'center', gap: 10,
              }}>
                {/* Format badge */}
                <div style={{
                  background: fmt.bg, color: fmt.text,
                  borderRadius: 4, padding: '2px 6px',
                  fontFamily: 'var(--mono)', fontSize: 9,
                  fontWeight: 700, letterSpacing: '0.05em', flexShrink: 0,
                }}>
                  {fmt.label}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 11, color: 'var(--text)', fontFamily: 'var(--mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {f.originalName || f.filename}
                  </div>
                  <div style={{ fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--mono)', marginTop: 2 }}>
                    {meta}
                  </div>
                </div>
                <button onClick={() => handleKnowledgeDelete(f.id)} style={{
                  background: 'transparent', border: '1px solid rgba(239,68,68,0.3)',
                  borderRadius: 4, padding: '2px 8px',
                  color: 'var(--red)', fontFamily: 'var(--mono)', fontSize: 10, cursor: 'pointer',
                }}>
                  ✕
                </button>
              </div>
            )
          })
        )}
      </SettingsSection>

      <SettingsSection title="Import Data">
        {/* ChatGPT import */}
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 11, color: 'var(--text)', fontFamily: 'var(--mono)', fontWeight: 600, marginBottom: 4 }}>
            Import from ChatGPT
          </div>
          <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--mono)', marginBottom: 8, lineHeight: 1.6 }}>
            ChatGPT → Settings → Data Controls → Export Data. Download the ZIP, extract it,
            then paste the path to conversations.json below.
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              type="text"
              id="chatgpt-import-path"
              placeholder="C:\Users\you\Downloads\chatgpt-export\conversations.json"
              style={{
                flex: 1, background: 'var(--bg2)', border: '1px solid var(--border2)',
                borderRadius: 6, padding: '8px 10px', fontFamily: 'var(--mono)',
                fontSize: 11, color: 'var(--text)', outline: 'none',
              }}
            />
            <button
              onClick={async () => {
                const el = document.getElementById('chatgpt-import-path') as HTMLInputElement
                const filePath = el?.value?.trim()
                if (!filePath) return
                try {
                  const res = await fetch('http://localhost:4200/api/import/chatgpt', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ filePath }),
                  })
                  const r = await res.json()
                  if (!res.ok) { alert(`Error: ${r.error || 'Import failed'}`); return }
                  alert(`Imported ${r.conversationsImported} conversations${r.errors?.length > 0 ? `\n${r.errors.length} error(s)` : ''}`)
                } catch { alert('Import failed — check the server is running') }
              }}
              style={{
                padding: '8px 14px', borderRadius: 6, background: 'var(--orange)',
                border: 'none', color: '#000', fontFamily: 'var(--mono)',
                fontSize: 11, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
              }}
            >
              Import ChatGPT
            </button>
          </div>
        </div>

        {/* OpenClaw import */}
        <div>
          <div style={{ fontSize: 11, color: 'var(--text)', fontFamily: 'var(--mono)', fontWeight: 600, marginBottom: 4 }}>
            Import from OpenClaw
          </div>
          <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--mono)', marginBottom: 8, lineHeight: 1.6 }}>
            Paste the path to your OpenClaw workspace directory (usually ~/.openclaw/).
            All .md files are ingested; memory and lesson files are also written to Aiden&apos;s memory.
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              type="text"
              id="openclaw-import-path"
              placeholder="C:\Users\you\.openclaw"
              style={{
                flex: 1, background: 'var(--bg2)', border: '1px solid var(--border2)',
                borderRadius: 6, padding: '8px 10px', fontFamily: 'var(--mono)',
                fontSize: 11, color: 'var(--text)', outline: 'none',
              }}
            />
            <button
              onClick={async () => {
                const el = document.getElementById('openclaw-import-path') as HTMLInputElement
                const directoryPath = el?.value?.trim()
                if (!directoryPath) return
                try {
                  const res = await fetch('http://localhost:4200/api/import/openclaw', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ directoryPath }),
                  })
                  const r = await res.json()
                  if (!res.ok) { alert(`Error: ${r.error || 'Import failed'}`); return }
                  alert(`Imported ${r.conversationsImported} files, ${r.memoriesExtracted} memories${r.errors?.length > 0 ? `\n${r.errors.length} error(s)` : ''}`)
                } catch { alert('Import failed — check the server is running') }
              }}
              style={{
                padding: '8px 14px', borderRadius: 6, background: 'var(--orange)',
                border: 'none', color: '#000', fontFamily: 'var(--mono)',
                fontSize: 11, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
              }}
            >
              Import OpenClaw
            </button>
          </div>
        </div>
      </SettingsSection>
    </div>
  )
}

// ── NavBar ────────────────────────────────────────────────────

function ModelControl() {
  const {
    activeModel, activeProvider, runtimeConnection,
    setSettingsOpen, setSettingsTab, capabilities,
  } = useDevOS()
  const available = capabilities?.modelSwitch.available === true
  return (
    <button
      type="button"
      className="model-control"
      aria-label={`Model: ${activeModel || 'not configured'}`}
      title={available ? 'Open model controls' : (capabilities?.modelSwitch.reason || 'Managed by the Aiden runtime')}
      onClick={() => { setSettingsTab('model'); setSettingsOpen(true) }}
    >
      <span className={`connection-dot is-${runtimeConnection}`} aria-hidden="true" />
      <span className="model-control-copy">
        <strong>{activeModel || 'No model'}</strong>
        <small>{activeProvider || 'No provider'}</small>
      </span>
      <span aria-hidden="true">⌄</span>
    </button>
  )
}

function NavBar() {
  const {
    isExecuting,
    setSettingsOpen, historyOpen, setHistoryOpen, startNewChat, clearCurrentView,
    runtimeConnection, executionQueue, activeJobs, presence, setMainView,
  } = useDevOS()
  const runningCount = foregroundExecutionCount(activeJobs)
  const attentionCount = presence?.enabled
    ? presence.needsYou.length
    : activeJobs.filter((job) => ['approval_required', 'blocked', 'paused', 'state_unknown'].includes(job.status)).length

  return (
    <nav style={{
      height: 48, display: 'flex', alignItems: 'center',
      justifyContent: 'space-between', padding: '0 16px',
      background: 'var(--topbar)', backdropFilter: 'blur(12px)',
      borderBottom: '1px solid var(--border)', flexShrink: 0, zIndex: 100,
    }}>
      {/* Brand */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button
          type="button"
          className="nav-btn"
          aria-label={historyOpen ? 'Collapse sidebar' : 'Expand sidebar'}
          title={historyOpen ? 'Collapse sidebar' : 'Expand sidebar'}
          onClick={() => setHistoryOpen((open) => !open)}
          style={{ width: 28, height: 28, border: '1px solid var(--border)', borderRadius: 7, background: 'transparent', color: 'var(--muted3)', cursor: 'pointer' }}
        >{historyOpen ? '‹' : '›'}</button>
        <div style={{
          width: 24, height: 24, borderRadius: 5,
          background: 'var(--orange)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 10, fontWeight: 800, color: '#000', flexShrink: 0,
          animation: isExecuting ? 'pulse-orange 1s infinite' : 'none',
        }}>A</div>
        <span style={{ fontSize: 14, color: 'var(--text)', fontWeight: 650, fontFamily: 'var(--sans)' }}>
          Aiden
        </span>
        <span style={{ color: 'var(--muted)', fontSize: 13 }}>·</span>
        <span className="workbench-brand-suffix" style={{ fontSize: 12, color: 'var(--muted2)' }}>Workbench</span>
        <div className="topbar-connection" style={{ display: 'flex', alignItems: 'center', gap: 5, marginLeft: 4 }}>
          <span style={{
            width: 6, height: 6, borderRadius: '50%',
             background: runtimeConnection === 'connected' ? (isExecuting ? 'var(--orange)' : 'var(--green)') : 'var(--red)',
            display: 'inline-block', animation: 'pulse-dot 2s infinite',
          }} />
          <span style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>{runtimeConnection}</span>
        </div>
      </div>

      {attentionCount > 0 ? (
        <button
          type="button"
          className="topbar-work-state is-actionable"
          aria-label="Open work that needs attention"
          onClick={() => setMainView('activity')}
        >
          {attentionCount} {attentionCount === 1 ? 'needs' : 'need'} you
          {executionQueue.pending > 0 ? ` · ${executionQueue.pending} queued` : ''}
        </button>
      ) : (
        <div className="topbar-work-state" style={{ color: runningCount > 0 ? 'var(--blue)' : 'var(--muted3)' }}>
          {runningCount > 0 ? `In progress · ${runningCount}` : 'Ready'}
          {executionQueue.pending > 0 ? ` · ${executionQueue.pending} queued` : ''}
        </div>
      )}

      {/* Controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <ModelControl />
        <button type="button" className="nav-btn" onClick={startNewChat} title="New Chat (Ctrl+K)" style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: 7, color: 'var(--muted3)', padding: '6px 9px', cursor: 'pointer' }}>New Chat</button>
        <button type="button" className="nav-btn" onClick={clearCurrentView} title="Clear only the current browser view" style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: 7, color: 'var(--muted3)', padding: '6px 9px', cursor: 'pointer' }}>Clear view</button>
        <ExportButton />
        <ChatHeader />
        <div style={{ width: 1, height: 20, background: 'var(--border2)', margin: '0 4px' }} />
        <NavBtn onClick={() => setSettingsOpen(true)} title="Settings">⚙</NavBtn>
      </div>
    </nav>
  )
}

// ── HistorySidebar ────────────────────────────────────────────

function HistorySidebar() {
  const {
    conversations, currentConvId, startNewChat, loadConversation, selectActiveJob,
    runtimeVersion, runtimeEdition, activeJobs, historyOpen, setHistoryOpen, mainView, setMainView,
    setSettingsOpen, setSettingsTab,
  } = useDevOS()

  const grouped = useMemo(() => {
    const now       = Date.now()
    const today     = conversations.filter(c => now - c.timestamp < 86400000)
    const yesterday = conversations.filter(c => now - c.timestamp >= 86400000 && now - c.timestamp < 172800000)
    const earlier   = conversations.filter(c => now - c.timestamp >= 172800000)
    return { today, yesterday, earlier }
  }, [conversations])

  const openSettings = (tab: string) => {
    setSettingsTab(tab)
    setSettingsOpen(true)
    if (window.matchMedia('(max-width: 620px)').matches) setHistoryOpen(false)
  }

  const openView = (view: MainView) => {
    setMainView(view)
    if (window.matchMedia('(max-width: 620px)').matches) setHistoryOpen(false)
  }

  if (!historyOpen) return (
    <aside className="history-sidebar sidebar-rail" aria-label="Collapsed navigation">
      <button type="button" className="rail-brand" title="Aiden Workbench" aria-label="Aiden Workbench">A</button>
      <button type="button" className="rail-action is-primary" title="New Chat" aria-label="New Chat" onClick={startNewChat}>+</button>
      <button type="button" className={mainView === 'chat' ? 'rail-action is-active' : 'rail-action'} title="Home" aria-label="Home" onClick={() => openView('chat')}>⌂</button>
      <button type="button" className={mainView === 'activity' ? 'rail-action is-active' : 'rail-action'} title={`Active Work (${activeJobs.length})`} aria-label="Active Work" onClick={() => openView('activity')}>◉</button>
      <button type="button" className={mainView === 'apps' ? 'rail-action is-active' : 'rail-action'} title="Apps" aria-label="Apps" onClick={() => openView('apps')}>+</button>
      <button type="button" className={mainView === 'automations' ? 'rail-action is-active' : 'rail-action'} title="Automations" aria-label="Automations" onClick={() => openView('automations')}>↻</button>
      <button type="button" className={mainView === 'artifacts' ? 'rail-action is-active' : 'rail-action'} title="Artifacts" aria-label="Artifacts" onClick={() => openView('artifacts')}>◇</button>
      <span className="rail-spacer" />
      <button type="button" className="rail-action" title="Settings" aria-label="Settings" onClick={() => openSettings('runtime')}>⚙</button>
    </aside>
  )

  return (
    <aside className="history-sidebar" style={{
      overflow: 'hidden', borderRight: '1px solid var(--border)',
      background: 'var(--bg1)', display: 'flex', flexDirection: 'column',
    }}>
      <button onClick={startNewChat} style={{
        margin: 12, padding: '8px 14px', borderRadius: 6,
        background: 'transparent', border: '1px solid var(--border2)',
        color: 'var(--muted2)', fontFamily: 'var(--mono)', fontSize: 12,
        cursor: 'pointer', textAlign: 'left', transition: 'all 0.15s',
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        + New Chat
        <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--muted)' }}>Ctrl+K</span>
      </button>

      <nav className="sidebar-nav" aria-label="Workbench surfaces">
        <button type="button" className={mainView === 'chat' ? 'is-active' : ''} onClick={() => openView('chat')}><span>⌂</span>Home</button>
        <button type="button" className={mainView === 'activity' ? 'is-active' : ''} onClick={() => openView('activity')}><span>◉</span>Active Work{activeJobs.length > 0 && <small>{activeJobs.length}</small>}</button>
        <button type="button" className={mainView === 'apps' ? 'is-active' : ''} onClick={() => openView('apps')}><span>+</span>Apps</button>
        <button type="button" className={mainView === 'automations' ? 'is-active' : ''} onClick={() => openView('automations')}><span>↻</span>Automations</button>
        <button type="button" className={mainView === 'artifacts' ? 'is-active' : ''} onClick={() => openView('artifacts')}><span>◇</span>Artifacts</button>
      </nav>

      <div style={{ flex: 1, overflowY: 'auto', padding: '0 8px' }}>
        {activeJobs.length > 0 && (
          <div style={{ margin: '4px 0 8px', padding: '8px', border: '1px solid var(--border)', borderRadius: 5 }}>
            <div style={{ padding: '0 4px 5px', fontSize: 9, color: 'var(--orange)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Active Work</div>
            {activeJobs.map((job) => (
              <button key={job.jobId} onClick={() => selectActiveJob(job)} style={{
                display: 'block', width: '100%', padding: '4px', border: 'none', background: 'transparent',
                color: 'var(--muted2)', fontFamily: 'var(--mono)', fontSize: 10, textAlign: 'left', cursor: 'pointer',
              }}>
                <span style={{ color: job.status === 'approval_required' ? 'var(--orange)' : job.status === 'blocked' ? 'var(--red)' : 'var(--blue)' }}>●</span>{' '}
                <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {job.title || job.jobId.slice(0, 18)}
                </span>
                <span style={{ display: 'block', color: 'var(--muted)', marginTop: 2 }}>
                  {presentRuntimeDetail(job.statusDetail, job.status)}
                </span>
              </button>
            ))}
          </div>
        )}
        {(Object.entries(grouped) as [string, Conversation[]][]).map(([group, convs]) => convs.length > 0 && (
          <div key={group}>
            <div style={{
              padding: '8px 8px 4px', fontSize: 9,
              color: 'var(--muted)', textTransform: 'uppercase',
              letterSpacing: '0.1em', fontFamily: 'var(--mono)',
            }}>
              {group === 'today' ? 'Today' : group === 'yesterday' ? 'Yesterday' : 'Earlier'}
            </div>
            {convs.map(conv => (
              <button key={conv.id} onClick={() => loadConversation(conv.id)} style={{
                display: 'flex', alignItems: 'center', gap: 4,
                width: '100%', textAlign: 'left',
                padding: '7px 10px', borderRadius: 5, marginBottom: 2,
                background: currentConvId === conv.id ? 'var(--bg2)' : 'transparent',
                border: 'none',
                borderLeft: `2px solid ${currentConvId === conv.id ? 'var(--orange)' : 'transparent'}`,
                color: currentConvId === conv.id ? 'var(--text)' : 'var(--muted2)',
                fontFamily: 'var(--mono)', fontSize: 11, cursor: 'pointer',
                transition: 'all 0.15s', overflow: 'hidden',
              }}>
                <span style={{ overflow: 'hidden', minWidth: 0, flex: 1 }}>
                  <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{conv.title.slice(0, 32)}{conv.title.length > 32 ? '...' : ''}</span>
                  <small style={{ display: 'block', marginTop: 2, color: 'var(--muted)' }}>{new Date(conv.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small>
                </span>
                {conv.channels && conv.channels.length > 1 && (
                  <span className="cross-channel-badge" title={`Started on ${conv.channels[0]}`}>
                    📱→🖥️
                  </span>
                )}
                {typeof conv.depth === 'number' && conv.depth > 0 && (
                  <span className="lineage-badge" title={`Compression depth ${conv.depth}`} style={{
                    fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--mono)',
                  }}>
                    ↳ {conv.depth}
                  </span>
                )}
              </button>
            ))}
          </div>
        ))}
        {conversations.length === 0 && (
          <div style={{ padding: 16, fontSize: 11, color: 'var(--muted)', textAlign: 'center', fontFamily: 'var(--mono)' }}>
            No conversations yet
          </div>
        )}
      </div>

      <div style={{ padding: '0 8px 8px' }}>
        <Sidebar />
      </div>

      <div className="sidebar-secondary-nav">
        <button type="button" onClick={() => openSettings('runtime')}><span>⚙</span>Settings</button>
      </div>

      <div style={{
        padding: '12px 16px', borderTop: '1px solid var(--border)',
        fontSize: 10, color: 'var(--muted)',
        display: 'flex', alignItems: 'center', gap: 6,
        fontFamily: 'var(--mono)',
      }}>
        <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--green)', display: 'inline-block' }} />
        Aiden v{runtimeVersion} · {runtimeEdition === 'community' ? 'Community' : runtimeEdition[0].toUpperCase() + runtimeEdition.slice(1)}
      </div>
    </aside>
  )
}

// ── EmptyState ────────────────────────────────────────────────

function EmptyState() {
  const { setInput } = useDevOS()
  const suggestions = [
    'Work on a codebase',
    'Research and deliver',
    'Use my browser',
    'Work with my Apps',
  ]
  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      padding: 40, gap: 22,
    }}>
      <div style={{
        width: 48, height: 48, borderRadius: 10,
        background: 'var(--orange)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 20, fontWeight: 800, color: '#000',
        fontFamily: 'var(--sans)',
      }}>A</div>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 30, fontFamily: 'var(--sans)', fontWeight: 650, color: 'var(--text)', letterSpacing: '-0.02em' }}>What should Aiden take care of?</div>
        <div style={{ marginTop: 8, fontSize: 15, color: 'var(--muted3)' }}>Private computer work, with proof.</div>
      </div>
      <div className="starter-workflows">
        {suggestions.map(s => (
          <button key={s} onClick={() => setInput(s)}>{s}<span>→</span></button>
        ))}
      </div>
    </div>
  )
}

// ── PlusMenu ──────────────────────────────────────────────────

function PlusMenu() {
  const {
    plusMenuOpen, setPlusMenuOpen,
    activeSubmenu, setActiveSubmenu,
    miniPrompt, setMiniPrompt,
    miniPromptValue, setMiniPromptValue, submitMiniPrompt,
    kbInputRef,
  } = useDevOS()

  if (!plusMenuOpen) return null

  const PLUS_MENU: MenuItem[] = [
    {
      id: 'upload',
      icon: '📎',
      label: 'Attach files',
      action: () => { kbInputRef.current?.click(); setPlusMenuOpen(false) },
    },
    {
      id: 'research',
      icon: '🔍',
      label: 'Research',
      children: [
        { id: 'websearch',    icon: '🌐', label: 'Web Search',    action: () => { setMiniPrompt({ type: 'websearch',  placeholder: 'Search for...' }) } },
        { id: 'deepresearch', icon: '🔬', label: 'Deep Research', action: () => { setMiniPrompt({ type: 'research',   placeholder: 'Research topic...' }) } },
        { id: 'stocks',       icon: '📊', label: 'Stock Data',    action: () => { setMiniPrompt({ type: 'stocks',     placeholder: 'e.g. NSE top gainers...' }) } },
      ],
    },
  ]

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={() => { setPlusMenuOpen(false); setActiveSubmenu(null); setMiniPrompt(null) }}
        style={{ position: 'fixed', inset: 0, zIndex: 90 }}
      />

      {/* Main menu */}
      <div style={{
        position: 'absolute', bottom: 52, left: 0,
        background: 'var(--bg2)', border: '1px solid var(--border2)',
        borderRadius: 10, padding: '6px 0', minWidth: 220,
        zIndex: 91, boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
        animation: 'slideUpFade 0.15s ease-out',
      }}>
        {PLUS_MENU.map((item) => (
          <div key={item.id} style={{ position: 'relative' }}>
            {/* Divider before Research */}
            {item.id === 'research' && (
              <div style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />
            )}

            {/* Menu row */}
            <button
              onMouseEnter={() => setActiveSubmenu('children' in item && item.children ? item.id : null)}
              onClick={() => {
                if ('action' in item && item.action) {
                  item.action()
                } else {
                  setActiveSubmenu(activeSubmenu === item.id ? null : item.id)
                }
              }}
              style={{
                display: 'flex', alignItems: 'center', gap: 10,
                width: '100%', padding: '8px 14px',
                background: activeSubmenu === item.id ? 'var(--bg3)' : 'transparent',
                border: 'none', color: 'var(--muted2)',
                fontFamily: 'var(--mono)', fontSize: 12,
                cursor: 'pointer', textAlign: 'left', transition: 'all 0.1s',
              }}
            >
              <span style={{ fontSize: 14, minWidth: 20 }}>{item.icon}</span>
              <span style={{ flex: 1 }}>{item.label}</span>
              {'children' in item && item.children && (
                <span style={{ fontSize: 10, color: 'var(--muted)', marginLeft: 4 }}>›</span>
              )}
            </button>

            {/* Submenu */}
            {'children' in item && item.children && activeSubmenu === item.id && (
              <div style={{
                position: 'absolute', left: '100%', top: 0,
                marginLeft: 4, background: 'var(--bg2)',
                border: '1px solid var(--border2)', borderRadius: 10,
                padding: '6px 0', minWidth: 200, zIndex: 92,
                boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
                animation: 'slideUpFade 0.12s ease-out',
              }}>
                {item.children.map(child => (
                  <button
                    key={child.id}
                    onClick={() => {
                      child.action()
                      if (!['websearch', 'deepresearch', 'stocks'].includes(child.id)) {
                        setPlusMenuOpen(false)
                        setActiveSubmenu(null)
                      }
                    }}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10,
                      width: '100%', padding: '8px 14px',
                      background: 'transparent', border: 'none',
                      color: 'var(--muted2)', fontFamily: 'var(--mono)',
                      fontSize: 12, cursor: 'pointer', textAlign: 'left',
                      transition: 'all 0.1s',
                    }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg3)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    <span style={{ fontSize: 14, minWidth: 20 }}>{child.icon}</span>
                    <span style={{ flex: 1 }}>{child.label}</span>
                  </button>
                ))}

                {/* Inline mini-prompt for Research submenu */}
                {item.id === 'research' && miniPrompt && (
                  <div style={{ padding: '8px 10px', borderTop: '1px solid var(--border)' }}>
                    <input
                      autoFocus
                      value={miniPromptValue}
                      onChange={e => setMiniPromptValue(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') { submitMiniPrompt() }
                        if (e.key === 'Escape') { setMiniPrompt(null); setMiniPromptValue('') }
                      }}
                      placeholder={miniPrompt.placeholder}
                      style={{
                        width: '100%', background: 'var(--bg)',
                        border: '1px solid var(--border2)', borderRadius: 5,
                        padding: '7px 10px', fontFamily: 'var(--mono)',
                        fontSize: 12, color: 'var(--text)', outline: 'none',
                      }}
                    />
                    <div style={{ fontSize: 9, color: 'var(--muted)', marginTop: 4, fontFamily: 'var(--mono)' }}>
                      Enter to run · Esc to cancel
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  )
}

// ── ChatPanel ─────────────────────────────────────────────────

function ArtifactCard({ artifact }: { artifact: aiden.WorkbenchArtifact }) {
  const [preview, setPreview] = useState<{
    url?: string; svg?: string; text?: string; truncated?: boolean; download?: boolean; error?: string
  } | null>(null)
  const [opening, setOpening] = useState(false)

  useEffect(() => () => { if (preview?.url) URL.revokeObjectURL(preview.url) }, [preview?.url])

  const open = async () => {
    if (preview) { setPreview(null); return }
    if (opening) return
    setOpening(true)
    try {
      const content = await aiden.loadArtifactContent(artifact.id)
      const presentation = artifactPresentationForMime(content.mime)
      if (presentation === 'svg') setPreview({ svg: await content.blob.text() })
      else if (presentation === 'image') setPreview({ url: URL.createObjectURL(content.blob) })
      else if (presentation === 'text') {
        const value = await content.blob.text()
        const previewLimit = 200_000
        setPreview({ text: value.slice(0, previewLimit), truncated: value.length > previewLimit })
      } else setPreview({ url: URL.createObjectURL(content.blob), download: true })
    } catch (error) {
      setPreview({ error: error instanceof Error ? error.message : String(error) })
    } finally {
      setOpening(false)
    }
  }

  return (
    <div className="artifact-card">
      <button type="button" onClick={() => { void open() }} className="artifact-card-button" aria-expanded={preview !== null} aria-busy={opening} disabled={opening}>
        <span aria-hidden="true">◇</span>
        <span style={{ minWidth: 0, flex: 1 }}>
          <strong>{artifact.name}</strong>
          <small>{artifact.kind} · {artifact.tool} · {artifact.bytes === null ? 'size unknown' : `${artifact.bytes} bytes`}</small>
        </span>
        <span>{opening ? 'Opening…' : preview ? 'Close' : 'Open'}</span>
      </button>
      {preview?.url && !preview.download && <img className="artifact-preview" src={preview.url} alt={artifact.name} />}
      {preview?.svg && <iframe className="artifact-preview" title={`${artifact.name} preview`} sandbox="" srcDoc={preview.svg} />}
      {preview?.text !== undefined && <pre className="artifact-text-preview"><code>{preview.text}</code>{preview.truncated ? '\n… preview truncated' : ''}</pre>}
      {preview?.download && preview.url && <a className="artifact-download" href={preview.url} download={artifact.name}>Download {artifact.name}</a>}
      {preview?.error && <div className="artifact-preview-error">{preview.error}</div>}
    </div>
  )
}

function ArtifactsView() {
  const [artifacts, setArtifacts] = useState<aiden.WorkbenchArtifact[]>([])
  const [view, setView] = useState<'recent' | 'job' | 'type'>('recent')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const rows = await aiden.listArtifacts()
      setArtifacts([...rows].sort((left, right) => right.createdAt - left.createdAt))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Artifacts are unavailable')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

  const grouped = useMemo(() => {
    const group = (keyOf: (artifact: aiden.WorkbenchArtifact) => string) => {
      const result = new Map<string, aiden.WorkbenchArtifact[]>()
      for (const artifact of artifacts) {
        const key = keyOf(artifact)
        result.set(key, [...(result.get(key) ?? []), artifact])
      }
      return Array.from(result.entries())
    }
    return {
      job: group((artifact) => artifact.runId === null ? `session:${artifact.sessionId}` : `run:${artifact.runId}`),
      type: group((artifact) => artifact.kind || 'file'),
    }
  }, [artifacts])

  const renderGroups = (groups: Array<[string, aiden.WorkbenchArtifact[]]>, label: (key: string, index: number) => string) => (
    <div className="artifact-group-list">
      {groups.map(([key, rows], index) => (
        <section className="artifact-group" key={key}>
          <h3>{label(key, index)} <span>{rows.length}</span></h3>
          <div className="artifact-gallery">
            {rows.map((artifact) => <ArtifactCard key={artifact.id} artifact={artifact} />)}
          </div>
        </section>
      ))}
    </div>
  )

  return (
    <section className="workspace-surface" aria-labelledby="artifacts-title">
      <header className="workspace-surface-header">
        <div>
          <span className="eyebrow">Durable results</span>
          <h2 id="artifacts-title">Artifacts</h2>
          <p>Review files Aiden produced, grouped without losing their source work.</p>
        </div>
        <button type="button" className="nav-btn" onClick={() => { void reload() }} disabled={loading}>Refresh</button>
      </header>

      <div className="artifact-view-tabs" role="tablist" aria-label="Group artifacts">
        {([['recent', 'Recent'], ['job', 'By Job'], ['type', 'Type']] as const).map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={view === key} className={view === key ? 'is-active' : ''} onClick={() => setView(key)}>{label}</button>
        ))}
        <span>{artifacts.length}</span>
      </div>

      {error ? (
        <div className="workspace-empty-state" role="alert"><strong>Artifacts need attention</strong><span>{error}</span></div>
      ) : loading ? (
        <div className="workspace-empty-state"><strong>Loading artifacts</strong><span>Reading the durable artifact index.</span></div>
      ) : artifacts.length === 0 ? (
        <div className="workspace-empty-state">
          <strong>No artifacts yet</strong>
          <span>Files produced by completed work will appear here after durable verification.</span>
        </div>
      ) : view === 'recent' ? (
        <div className="artifact-gallery">
          {artifacts.slice(0, 24).map((artifact) => <ArtifactCard key={artifact.id} artifact={artifact} />)}
        </div>
      ) : view === 'job' ? (
        renderGroups(grouped.job, (_key, index) => `Work ${index + 1}`)
      ) : (
        renderGroups(grouped.type, (key) => key.replace(/_/g, ' '))
      )}
    </section>
  )
}

function AppsView() {
  const [snapshot, setSnapshot] = useState<aiden.WorkbenchAppsSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [pending, setPending] = useState<aiden.WorkbenchAppConnection | null>(null)
  const [disconnecting, setDisconnecting] = useState<aiden.WorkbenchConnectedAccount | null>(null)
  const [setupTarget, setSetupTarget] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try {
      setError(null)
      setSnapshot(await aiden.loadApps())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Apps are unavailable')
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

  const connect = async (toolkit: aiden.WorkbenchAppToolkit) => {
    setBusy(`connect:${toolkit.providerId}:${toolkit.toolkitId}`)
    setError(null)
    try {
      const connection = await aiden.connectApp({
        providerId: toolkit.providerId,
        toolkitId: toolkit.toolkitId,
      })
      setPending(connection)
      if (connection.authorizationUrl) window.open(connection.authorizationUrl, '_blank', 'noopener,noreferrer')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Connection could not start')
    } finally { setBusy(null) }
  }

  const complete = async () => {
    if (!pending) return
    setBusy(`complete:${pending.connectionId}`)
    setError(null)
    try {
      await aiden.completeAppConnection(pending.connectionId)
      setPending(null)
      await reload()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Connection is not ready')
    } finally { setBusy(null) }
  }

  const accountAction = async (
    account: aiden.WorkbenchConnectedAccount,
    action: 'refresh' | 'reconnect' | 'disconnect',
  ) => {
    setBusy(`${action}:${account.accountId}`)
    setError(null)
    try {
      if (action === 'refresh') await aiden.refreshAppAccount(account.accountId)
      else if (action === 'disconnect') await aiden.disconnectAppAccount(account.accountId)
      else {
        const connection = await aiden.reconnectAppAccount(account.accountId)
        setPending(connection)
        if (connection.authorizationUrl) window.open(connection.authorizationUrl, '_blank', 'noopener,noreferrer')
      }
      setDisconnecting(null)
      await reload()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Account action failed')
    } finally { setBusy(null) }
  }

  const configureProvider = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    const providerId = String(data.get('providerId') ?? '').trim()
    const credential = String(data.get('credential') ?? '').trim()
    if (!providerId || !credential) { setError('Provider and credential are required'); return }
    setBusy(`configure:${providerId}`); setError(null)
    try {
      await aiden.configureAppsProvider({ providerId, credential })
      form.reset()
      await reload()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Apps provider setup failed')
    } finally { setBusy(null) }
  }

  const healthLabel = (health: string) => ({
    healthy: 'Healthy', degraded: 'Needs attention', expired: 'Reconnect required',
    insufficient_scope: 'Insufficient access',
    revoked: 'Disconnected', unknown: 'Not checked', not_configured: 'Not configured',
    unavailable: 'Unavailable',
  }[health] ?? health.replace(/_/g, ' '))
  const recommendedApps = useMemo(
    () => snapshot ? projectRecommendedApps(snapshot) : [],
    [snapshot],
  )

  return (
    <section className="workspace-surface" aria-labelledby="apps-title">
      <header className="workspace-surface-header">
        <div>
          <span className="eyebrow">Connected accounts</span>
          <h2 id="apps-title">Apps</h2>
          <p>Choose the exact account Aiden may use. External changes still require Aiden approval.</p>
        </div>
        <button type="button" className="nav-btn" onClick={() => { void reload() }} disabled={busy !== null}>Refresh</button>
      </header>

      {error && <div className="workspace-empty-state" role="alert"><strong>Apps need attention</strong><span>{error}</span></div>}

      {pending && (
        <article className="surface-card" style={{ padding: 18, marginBottom: 18 }}>
          <span className="eyebrow">Authorization in progress</span>
          <h3 style={{ margin: '6px 0' }}>Finish connecting your account</h3>
          <p style={{ color: 'var(--muted2)' }}>Complete authorization in the provider window, then confirm here.</p>
          {pending.userCode && <code>{pending.userCode}</code>}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {pending.authorizationUrl && <a className="sponsor-button" href={pending.authorizationUrl} target="_blank" rel="noopener noreferrer">Open authorization</a>}
            <button type="button" className="nav-btn" onClick={() => { void complete() }} disabled={busy !== null}>Complete connection</button>
            <button type="button" className="nav-btn" onClick={() => setPending(null)} disabled={busy !== null}>Cancel</button>
          </div>
        </article>
      )}

      {!snapshot && !error ? <div className="workspace-empty-state"><strong>Loading Apps</strong><span>Checking local connected-account authority.</span></div> : null}

      {snapshot && (
        <>
          <div className="artifact-gallery apps-card-grid" aria-label="Connected accounts">
            {snapshot.accounts.length === 0 ? (
              <div className="workspace-empty-state">
                <strong>No connected accounts</strong>
                <span>Connect your first account below. Aiden will always use an explicitly selected account.</span>
              </div>
            ) : snapshot.accounts.map((account) => (
              <article className="surface-card" key={account.accountId} style={{ padding: 18 }}>
                <span className="eyebrow">{account.toolkitId}</span>
                <h3 style={{ margin: '6px 0' }}>{account.label}</h3>
                <p style={{ color: account.health === 'healthy' ? 'var(--green)' : account.health === 'revoked' ? 'var(--red)' : 'var(--orange)' }}>
                  {healthLabel(account.health)}
                </p>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {account.status !== 'revoked' && <button type="button" className="nav-btn" disabled={busy !== null} onClick={() => { void accountAction(account, 'refresh') }}>Check health</button>}
                  {(account.status === 'revoked' || account.health === 'expired' || account.health === 'degraded') && <button type="button" className="nav-btn" disabled={busy !== null} onClick={() => { void accountAction(account, 'reconnect') }}>Reconnect</button>}
                  {account.status !== 'revoked' && <button type="button" className="nav-btn" disabled={busy !== null} onClick={() => setDisconnecting(account)}>Disconnect</button>}
                </div>
              </article>
            ))}
          </div>

          <header className="workspace-surface-header" style={{ marginTop: 24 }}>
            <div><span className="eyebrow">Available apps</span><h3>Connect an app</h3></div>
          </header>
          <div className="artifact-gallery apps-card-grid" aria-label="Available apps">
            {recommendedApps.map((card) => {
              const toolkit = card.toolkit
              return (
                <article className="surface-card" key={card.id} style={{ padding: 18 }}>
                  <span className="eyebrow">{card.accounts.length > 0 ? `${card.accounts.length} connected` : 'Available'}</span>
                  <h3 style={{ margin: '6px 0' }}>{card.label}</h3>
                  <p style={{ color: 'var(--muted2)', minHeight: 36 }}>{card.description}</p>
                  {card.accounts.map((account) => (
                    <div key={account.accountId} className="app-account-row">
                      <span><strong>{account.label}</strong><small>{healthLabel(account.health)}</small></span>
                      {account.needsReconnect && (
                        <button type="button" className="nav-btn" disabled={busy !== null} onClick={() => { void accountAction(account, 'reconnect') }}>Reconnect</button>
                      )}
                    </div>
                  ))}
                  <button
                    type="button"
                    className="nav-btn"
                    disabled={busy !== null}
                    onClick={() => toolkit ? void connect(toolkit) : setSetupTarget(card.label)}
                  >{card.id === 'github'
                      ? (card.accounts.length > 0 ? 'Add another account' : toolkit ? 'Connect GitHub' : 'Set up GitHub')
                      : card.id === 'gmail'
                        ? (card.accounts.length > 0 ? 'Add another account' : toolkit ? 'Connect Gmail' : 'Set up Gmail')
                        : 'Browse apps'}</button>
                </article>
              )
            })}
          </div>

          {setupTarget && (
            <article className="surface-card app-setup-state" role="status">
              <span className="eyebrow">Provider status</span>
              <h3>{setupTarget === 'More apps' ? 'Available Apps provider' : `${setupTarget} connection requires the Apps provider`}</h3>
              <p>{snapshot.providers.length === 0
                ? 'Not configured. Configure the local Apps provider, then refresh this page.'
                : snapshot.providers.map((provider) => `${provider.label}: ${healthLabel(provider.health)}`).join(' · ')}</p>
              {snapshot.toolkits.filter((toolkit) => !['github', 'gmail'].includes(toolkit.toolkitId.toLowerCase())).length > 0 && setupTarget === 'More apps' && (
                <p>{snapshot.toolkits.filter((toolkit) => !['github', 'gmail'].includes(toolkit.toolkitId.toLowerCase())).map((toolkit) => toolkit.label).join(' · ')}</p>
              )}
              {snapshot.configuration.workbench ? (
                <form onSubmit={(event) => { void configureProvider(event) }} style={{ display: 'grid', gap: 8, marginTop: 12 }}>
                  <label style={{ color: 'var(--muted2)', fontSize: 12 }}>Apps provider
                    <select name="providerId" required defaultValue={snapshot.providers[0]?.id ?? 'composio'} style={{ width: '100%', marginTop: 5, padding: 9, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg2)', color: 'var(--text)' }}>
                      {snapshot.providers.length > 0
                        ? snapshot.providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)
                        : <option value="composio">Composio</option>}
                    </select>
                  </label>
                  <input name="credential" type="password" autoComplete="off" required placeholder="Provider API key" style={{ padding: 9, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg2)', color: 'var(--text)' }} />
                  <button type="submit" className="nav-btn" disabled={busy !== null}>{busy?.startsWith('configure:') ? 'Securing and testing…' : 'Save securely and test'}</button>
                  <p style={{ color: 'var(--muted2)', margin: 0 }}>The credential is sent once to the local backend secret authority and is never retained by the browser.</p>
                </form>
              ) : snapshot.configuration.command ? (
                <><code>{snapshot.configuration.command}</code><p style={{ color: 'var(--muted2)' }}>Complete provider setup in a private terminal.</p></>
              ) : null}
              <button type="button" className="nav-btn" onClick={() => setSetupTarget(null)}>Close setup</button>
            </article>
          )}

          <details className="apps-provider-diagnostics">
            <summary>Provider diagnostics</summary>
            {snapshot.providers.length === 0
              ? <p>Apps provider is not configured.</p>
              : snapshot.providers.map((provider) => <p key={provider.id}>{provider.label} · {healthLabel(provider.health)}{provider.detail ? ` · ${provider.detail}` : ''}</p>)}
          </details>
        </>
      )}

      {disconnecting && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="disconnect-app-title">
          <div className="surface-card" style={{ maxWidth: 460, padding: 22 }}>
            <h3 id="disconnect-app-title">Disconnect {disconnecting.label}?</h3>
            <p style={{ color: 'var(--muted2)' }}>Future actions will be blocked. Durable Evidence and history remain.</p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" className="nav-btn" onClick={() => setDisconnecting(null)} disabled={busy !== null}>Keep connected</button>
              <button type="button" className="nav-btn" onClick={() => { void accountAction(disconnecting, 'disconnect') }} disabled={busy !== null}>Disconnect</button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

function describeAutomationSchedule(expression: string): string {
  if (expression === '0 9 * * 1-5') return 'Every weekday at 9:00 AM'
  if (expression === '0 9 * * *') return 'Every day at 9:00 AM'
  if (expression === '0 * * * *') return 'Every hour'
  return `Advanced schedule · ${expression}`
}

function AutomationsView() {
  const [snapshot, setSnapshot] = useState<aiden.WorkbenchAutomationSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [preview, setPreview] = useState<string[]>([])

  const reload = useCallback(async () => {
    try { setError(null); setSnapshot(await aiden.loadAutomations()) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Automations are unavailable') }
  }, [])
  useEffect(() => { void reload() }, [reload])

  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    const input = {
      name: String(data.get('name') ?? '').trim(),
      prompt: String(data.get('prompt') ?? '').trim(),
      expression: String(data.get('expression') ?? '').trim() || String(data.get('schedulePreset') ?? '').trim(),
      timezone: String(data.get('timezone') ?? '').trim(),
      overlap: String(data.get('overlap') ?? 'queue') as 'queue' | 'skip' | 'cancel_previous',
      misfire: String(data.get('misfire') ?? 'run_once') as 'run_once' | 'skip' | 'catch_up',
      allowWrite: data.get('allowWrite') === 'on',
    }
    if (!input.name || !input.prompt || !input.expression || !input.timezone) { setError('Every automation field is required'); return }
    setBusy('create'); setError(null)
    try { await aiden.createAutomation(input); form.reset(); setPreview([]); await reload() }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Automation could not be created') }
    finally { setBusy(null) }
  }

  const previewSchedule = async (form: HTMLFormElement) => {
    const data = new FormData(form)
    const expression = String(data.get('expression') ?? '').trim() || String(data.get('schedulePreset') ?? '').trim()
    const timezone = String(data.get('timezone') ?? '').trim()
    if (!expression || !timezone) { setError('Schedule and timezone are required for preview'); return }
    setBusy('preview'); setError(null)
    try { setPreview((await aiden.previewAutomationSchedule({ expression, timezone })).instants) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Schedule preview failed') }
    finally { setBusy(null) }
  }

  const action = async (automation: aiden.WorkbenchAutomationSummary, kind: 'run' | 'toggle' | 'replay') => {
    setBusy(`${kind}:${automation.automationId}`); setError(null)
    try {
      if (kind === 'run') await aiden.runAutomationNow(automation.automationId)
      else if (kind === 'replay' && automation.lastOccurrence) await aiden.replayAutomationOccurrence(automation.lastOccurrence.occurrenceId)
      else await aiden.setAutomationEnabled(automation.automationId, !automation.enabled)
      await reload()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Automation action failed') }
    finally { setBusy(null) }
  }

  return (
    <section className="workspace-surface automation-surface" aria-labelledby="automations-title">
      <header className="workspace-surface-header">
        <div><span className="eyebrow">Reliable schedules</span><h2 id="automations-title">Automations</h2><p>Each logical occurrence creates one durable Job with normal approval and Evidence.</p></div>
        <button type="button" className="nav-btn" onClick={() => { void reload() }} disabled={busy !== null}>Refresh</button>
      </header>
      {error && <div className="workspace-empty-state" role="alert"><strong>Automations need attention</strong><span>{error}</span></div>}
      {snapshot && !snapshot.capability.available && <div className="workspace-empty-state"><strong>Pro capability required</strong><span>{snapshot.capability.reason}</span></div>}
      {snapshot?.capability.available && (
        <>
          <form className="surface-card automation-create" onSubmit={(event) => { void create(event) }}>
            <span className="eyebrow">Create automation</span>
            <input name="name" required placeholder="Daily repository summary" />
            <textarea name="prompt" required placeholder="What should Aiden do?" rows={3} />
            <div className="automation-schedule-fields">
              <label><span>When</span><select name="schedulePreset" defaultValue="0 9 * * 1-5"><option value="0 9 * * 1-5">Every weekday at 9:00 AM</option><option value="0 9 * * *">Every day at 9:00 AM</option><option value="0 * * * *">Every hour</option></select></label>
              <input name="timezone" required defaultValue="Asia/Kolkata" aria-label="IANA timezone" />
            </div>
            <details className="automation-advanced"><summary>Advanced schedule</summary><input name="expression" placeholder="Cron expression, for example 0 9 * * 1-5" aria-label="Advanced cron schedule" /></details>
            <div className="automation-safety-fields">
              <label><span>If a previous run is working</span><select name="overlap" defaultValue="queue"><option value="queue">Wait for it to finish</option><option value="skip">Skip the new run</option><option value="cancel_previous">Stop it, then start the new run</option></select></label>
              <label><span>If Aiden was offline</span><select name="misfire" defaultValue="run_once"><option value="run_once">Run once when Aiden returns</option><option value="skip">Skip missed runs</option><option value="catch_up">Catch up at most 3 runs</option></select></label>
            </div>
            <label className="automation-write-option"><input type="checkbox" name="allowWrite" /><span>Allow workspace changes. Consequential actions still require normal Aiden approval.</span></label>
            <p className="automation-meta">Scheduling never bypasses approvals. This automation is bound to the workspace where Workbench is running.</p>
            <div className="automation-actions">
              <button type="button" className="nav-btn" disabled={busy !== null} onClick={(event) => { void previewSchedule(event.currentTarget.form!) }}>Preview next 5</button>
              <button type="submit" className="nav-btn" disabled={busy !== null}>{busy === 'create' ? 'Creating…' : 'Create'}</button>
            </div>
            {preview.length > 0 && <ol className="automation-preview">{preview.map((instant) => <li key={instant}>{new Date(instant).toLocaleString()} <code>{instant}</code></li>)}</ol>}
          </form>
          <div className="artifact-gallery automation-grid" aria-label="Automations">
            {snapshot.automations.length === 0 ? <div className="workspace-empty-state"><strong>No automations yet</strong><span>Create a safe schedule above.</span></div> : snapshot.automations.map((automation) => (
              <article className="surface-card automation-card" key={automation.automationId}>
                <span className="eyebrow">Revision {automation.revisionNumber} · {automation.enabled ? 'Active' : 'Paused'}</span>
                <h3>{automation.name}</h3>
                <p>{automation.trigger.kind === 'schedule' ? `${describeAutomationSchedule(automation.trigger.expression)} · ${automation.trigger.timezone}` : automation.trigger.kind}</p>
                <p className="automation-meta">Next: {automation.nextFireAt ? new Date(automation.nextFireAt).toLocaleString() : 'Not scheduled'}</p>
                {automation.lastOccurrence && <p className="automation-meta">Last: {automation.lastOccurrence.state} · {automation.lastOccurrence.occurrenceId}</p>}
                <div className="automation-actions">
                  <button type="button" className="nav-btn" disabled={busy !== null} onClick={() => { void action(automation, 'run') }}>Run now</button>
                  <button type="button" className="nav-btn" disabled={busy !== null} onClick={() => { void action(automation, 'toggle') }}>{automation.enabled ? 'Pause' : 'Resume'}</button>
                  {automation.lastOccurrence && automation.lastOccurrence.state !== 'unknown' && <button type="button" className="nav-btn" disabled={busy !== null} onClick={() => { void action(automation, 'replay') }}>Replay</button>}
                </div>
              </article>
            ))}
          </div>
          <section className="surface-card automation-history" aria-labelledby="automation-history-title">
            <div><span className="eyebrow">Durable history</span><h3 id="automation-history-title">Occurrences</h3></div>
            {snapshot.history.length === 0 ? <p className="automation-meta">No occurrences yet.</p> : (
              <div className="automation-history-list">
                {snapshot.history.map((occurrence) => (
                  <article key={occurrence.occurrenceId} className="automation-history-row">
                    <strong>{occurrence.state}</strong>
                    <span>{occurrence.triggerKind} · {new Date(occurrence.triggeredAt).toLocaleString()}</span>
                    <code>{occurrence.occurrenceId}</code>
                    {occurrence.jobId && <code>Job {occurrence.jobId}</code>}
                    {occurrence.replayOfOccurrenceId && <span>Replay of {occurrence.replayOfOccurrenceId}</span>}
                    {occurrence.detail.delivery && <span>Work {occurrence.state === 'completed' ? 'completed' : occurrence.state} · Delivery {occurrence.detail.delivery.state}</span>}
                  </article>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </section>
  )
}

function SponsorsView() {
  return (
    <section className="workspace-surface sponsor-surface" aria-labelledby="sponsors-title">
      <header className="workspace-surface-header">
        <div>
          <span className="eyebrow">Independent and local-first</span>
          <h2 id="sponsors-title">Sponsors</h2>
          <p>Aiden is built independently. Support helps fund development, testing and infrastructure.</p>
        </div>
        <a className="sponsor-button" href={SPONSOR_URL} target="_blank" rel="noopener noreferrer">Sponsor Aiden</a>
      </header>
      <div className="sponsor-list" aria-label="Top Sponsors">
        <h3>Top Sponsors</h3>
        {PUBLIC_SPONSORS.length === 0 ? (
          <div className="workspace-empty-state">
            <strong>No public sponsors yet</strong>
            <span>Become the first supporter. Recognition is always opt-in.</span>
            <a href={SPONSOR_URL} target="_blank" rel="noopener noreferrer">Sponsor Aiden</a>
          </div>
        ) : PUBLIC_SPONSORS.map((sponsor) => (
          <article className="sponsor-card" key={sponsor.displayName}>
            <span className="sponsor-avatar" aria-hidden="true">{sponsor.displayName.slice(0, 1).toUpperCase()}</span>
            <div>
              {sponsor.profileUrl
                ? <a href={sponsor.profileUrl} target="_blank" rel="noopener noreferrer"><strong>{sponsor.displayName}</strong></a>
                : <strong>{sponsor.displayName}</strong>}
              {sponsor.tier && <small>{sponsor.tier}</small>}
              {sponsor.message && <p>{sponsor.message}</p>}
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}

function LiveExecutionPane() {
  const {
    liveExecution, liveExecutionSelection, selectLiveExecutionSurface,
    toggleLiveExecutionPin, liveViewOpen, collapseLiveExecution,
  } = useDevOS()
  if (!liveExecution || !liveViewOpen || liveExecution.surfaces.length === 0) return null
  const selected = liveExecution.surfaces.find(
    (surface) => surface.surfaceId === liveExecutionSelection.selectedSurfaceId,
  ) ?? liveExecution.activeSurface ?? liveExecution.surfaces[0]
  const isPinned = liveExecutionSelection.pinnedSurfaceId === selected.surfaceId
  const statusLabel = selected.status.replace(/_/g, ' ')
  const terminalText = selected.terminal?.chunks.map((chunk) => chunk.data).join('') ?? ''
  return (
    <aside className="live-execution-pane" aria-label="Live Execution">
      <header className="live-execution-header">
        <div>
          <strong>Live Execution</strong>
          <span>{selected.title} · {statusLabel}</span>
        </div>
        <div className="live-execution-actions">
          <button type="button" aria-pressed={isPinned} onClick={toggleLiveExecutionPin}>{isPinned ? 'Following is off' : 'Keep this open'}</button>
          <button type="button" onClick={collapseLiveExecution}>Collapse</button>
        </div>
      </header>
      {liveExecutionSelection.attentionSurfaceId && liveExecutionSelection.attentionSurfaceId !== selected.surfaceId && (
        <button type="button" className="live-execution-attention" onClick={() => selectLiveExecutionSurface(liveExecutionSelection.attentionSurfaceId!)}>
          Another execution view needs attention
        </button>
      )}
      {liveExecution.surfaces.length > 1 && (
        <nav className="live-execution-tray" aria-label="Execution views">
          {liveExecution.surfaces.slice(0, 4).map((surface) => (
            <button
              key={surface.surfaceId}
              type="button"
              className={surface.surfaceId === selected.surfaceId ? 'is-active' : ''}
              onClick={() => selectLiveExecutionSurface(surface.surfaceId)}
            >{surface.title}<small>{surface.status}</small></button>
          ))}
        </nav>
      )}
      <div className="live-execution-body">
        {selected.kind === 'terminal' && selected.terminal && (
          <div className="live-terminal-surface">
            <LiveExecutionTerminal surface={selected} />
            {selected.terminal.truncated && <small>Recent output shown · older output remains outside the browser projection.</small>}
            {selected.status === 'disconnected' && <p className="live-execution-notice">Terminal stream disconnected. The Job may still be running.</p>}
            <span className="sr-only">{terminalText}</span>
          </div>
        )}
        {selected.kind === 'browser' && selected.browser && (
          <section className="live-browser-surface">
            <div className="live-browser-address"><span>{selected.browser.navigationStatus}</span><strong>{selected.browser.title || 'Untitled page'}</strong></div>
            <p>{selected.browser.url || 'No current URL'}</p>
            {selected.browser.frame ? (
              <div className="live-browser-frame-placeholder has-frame">
                <img src={`/api/artifacts/${encodeURIComponent(selected.browser.frame.artifactId)}/content`} alt={`Latest browser view of ${selected.browser.title || selected.browser.url || 'current page'}`} />
                <small>{selected.browser.stale ? `May be stale · ${Math.round((selected.browser.captureAgeMs ?? 0) / 1000)}s old` : 'Current captured state'}</small>
              </div>
            ) : selected.browser.snapshotId ? (
              <div className="live-browser-frame-placeholder">
                <strong>Latest structured browser state</strong>
                <span>Snapshot {selected.browser.snapshotId}</span>
                <small>{selected.browser.stale ? `May be stale · ${Math.round((selected.browser.captureAgeMs ?? 0) / 1000)}s old` : 'Current observation'}</small>
              </div>
            ) : <div className="live-execution-empty">No visual frame has been captured. Structured browser state remains available.</div>}
          </section>
        )}
        {selected.kind === 'changes' && selected.changes && (
          <section className="live-execution-list"><h3>{selected.changes.count} {selected.changes.count === 1 ? 'file' : 'files'} changed</h3>{selected.changes.paths.map((item) => <div key={item}>◇ {item}</div>)}</section>
        )}
        {selected.kind === 'validation' && selected.validation && (
          <section className="live-execution-list"><h3>Validation</h3>{selected.validation.refs.map((item) => <div key={item}>{selected.validation?.verified ? '✓' : '●'} {item}</div>)}</section>
        )}
        {selected.kind === 'workspace' && selected.workspace && (
          <section className="live-execution-list"><h3>Workspace</h3><div>{selected.workspace.state}</div><div>Base {selected.workspace.baseHead}</div>{selected.workspace.baseBranch && <div>Branch {selected.workspace.baseBranch}</div>}</section>
        )}
        {selected.kind === 'artifact' && selected.artifact && (
          <section className="live-execution-list"><h3>Artifacts</h3>{selected.artifact.names.map((item, index) => <div key={selected.artifact!.ids[index]}>◇ {item}</div>)}</section>
        )}
        {selected.kind === 'app_action' && selected.appAction && (
          <section className="live-app-action"><span>{selected.appAction.provider}</span><h3>{selected.appAction.action}</h3><p>{selected.appAction.state.replace(/_/g, ' ')}</p></section>
        )}
      </div>
      <footer className="live-execution-footer">
        <span>{liveExecution.job.status}</span>
        <span>Job {liveExecution.job.jobId.slice(0, 12)} · Attempt {liveExecution.job.attemptId.slice(0, 12)}</span>
      </footer>
    </aside>
  )
}

function LiveActivitySurface() {
  const {
    liveActivity, runProjection, runArtifacts, selectedContext,
    isStreaming, thinking, refreshProjection, browserSession, controlBrowser,
  } = useDevOS()
  const [expanded, setExpanded] = useState(false)
  const [decisionPending, setDecisionPending] = useState<string | null>(null)
  const [decisionError, setDecisionError] = useState<string | null>(null)
  const [telemetryVisible, setTelemetryVisible] = useState(false)
  const [telemetryLeaving, setTelemetryLeaving] = useState(false)
  const [codingSessions, setCodingSessions] = useState<aiden.WorkbenchCodingSession[]>([])
  const [codingPending, setCodingPending] = useState<'apply' | 'discard' | 'discard-unknown' | null>(null)
  const [codingReview, setCodingReview] = useState<aiden.WorkbenchCodingReview | null>(null)
  const [codingReviewError, setCodingReviewError] = useState<string | null>(null)
  const summary = summarizeCompletedActivity(liveActivity)
  const approvals = runProjection?.receipt.terminal ? [] : pendingApprovalsForProjection(
    runProjection?.approvals ?? [],
    runProjection?.identity,
  )
  const running = isStreaming || summary.running > 0 || Boolean(thinking)
  const showTelemetry = shouldShowChatTelemetry({
    running,
    pendingApprovalCount: approvals.length,
    terminal: runProjection?.receipt.terminal,
  })
  const visibleActivity = selectChatLiveActivity(liveActivity)
  const semanticProgress = projectSemanticProgress(liveActivity)
  const currentActivity = visibleActivity.at(-1)
  const currentDuration = currentActivity?.durationMs == null
    ? null
    : currentActivity.durationMs < 1_000
      ? `${currentActivity.durationMs}ms`
      : `${(currentActivity.durationMs / 1_000).toFixed(1)}s`
  const currentLabel = approvals.length > 0 && !running
    ? 'Approval required'
    : runProjection?.receipt.terminal
      ? 'Completed'
      : currentActivity
        ? `${currentActivity.label}${currentActivity.detail ? ` · ${currentActivity.detail}` : ''}`
        : (thinking?.message || 'Aiden is working')

  useEffect(() => {
    let active = true
    const jobId = selectedContext.jobId
    if (!jobId) {
      setCodingSessions([])
      setCodingReview(null)
      return () => { active = false }
    }
    void aiden.loadCodingSessions(jobId)
      .then((sessions) => { if (active) setCodingSessions(sessions) })
      .catch(() => { if (active) setCodingSessions([]) })
    return () => { active = false }
  }, [selectedContext.jobId, runProjection])

  useEffect(() => {
    if (showTelemetry) {
      setTelemetryVisible(true)
      setTelemetryLeaving(false)
      if (approvals.length > 0) setExpanded(true)
      return
    }
    setExpanded(false)
    if (!telemetryVisible) return
    const fadeTimer = window.setTimeout(() => setTelemetryLeaving(true), 1_000)
    const removeTimer = window.setTimeout(() => {
      setTelemetryVisible(false)
      setTelemetryLeaving(false)
    }, 1_180)
    return () => {
      window.clearTimeout(fadeTimer)
      window.clearTimeout(removeTimer)
    }
  }, [showTelemetry, telemetryVisible, approvals.length])
  const codingSession = codingSessions.at(-1)
  if (!telemetryVisible && runArtifacts.length === 0 && !codingSession) return null

  const decide = async (approvalId: string, decision: 'approved' | 'denied') => {
    setDecisionPending(approvalId)
    setDecisionError(null)
    try {
      await aiden.decideApproval(approvalId, decision)
      refreshProjection()
    } catch (error) {
      setDecisionError(error instanceof Error ? error.message : 'Approval is no longer actionable')
      refreshProjection()
    } finally {
      setDecisionPending(null)
    }
  }

  const decideCoding = async (decision: 'apply' | 'discard') => {
    if (!codingSession?.promotion) return
    setCodingPending(decision)
    try {
      await aiden.decideCodingPromotion(codingSession.promotion.promotionId, decision)
      if (selectedContext.jobId) setCodingSessions(await aiden.loadCodingSessions(selectedContext.jobId))
      refreshProjection()
    } finally {
      setCodingPending(null)
    }
  }


  const reviewCoding = async () => {
    if (!codingSession?.promotion) return
    setCodingReviewError(null)
    try {
      setCodingReview(await aiden.loadCodingReview(codingSession.promotion.promotionId))
    } catch (error) {
      setCodingReviewError(error instanceof Error ? error.message : String(error))
    }
  }

  const discardUnknownCoding = async () => {
    if (!codingSession) return
    setCodingPending('discard-unknown')
    setCodingReviewError(null)
    try {
      await aiden.discardUnknownCodingSession(codingSession.codingSessionId)
      if (selectedContext.jobId) setCodingSessions(await aiden.loadCodingSessions(selectedContext.jobId))
      refreshProjection()
    } catch (error) {
      setCodingReviewError(error instanceof Error ? error.message : String(error))
    } finally {
      setCodingPending(null)
    }
  }

  return (
    <section className={`live-activity-surface ${telemetryVisible ? 'has-telemetry' : 'is-artifact-only'}`} aria-label="Current activity and artifacts">
      {telemetryVisible && (
        <div className={`live-telemetry ${telemetryLeaving ? 'is-leaving' : ''}`}>
          <button type="button" className="live-activity-summary" onClick={() => setExpanded((open) => !open)}>
            <span className={running ? 'activity-pulse' : ''}>{approvals.length > 0 && !running ? '!' : '◐'}</span>
            <span className="live-activity-current">{currentLabel}</span>
            <span className="live-activity-count">{currentDuration ? `${currentDuration} · ` : ''}{expanded ? '−' : '+'}</span>
          </button>
          {expanded && (
            <div className="live-activity-details">
              {semanticProgress.slice(-3).map((phase) => (
                <div key={phase.id} className={`live-activity-row status-${phase.status}`} data-progress-id={phase.id}>
                  <span>{phase.status === 'running' ? '●' : phase.status === 'complete' ? '✓' : phase.status === 'failed' ? '×' : '!'}</span>
                  <span className="live-activity-label"><strong>{phase.label}</strong>{phase.detail && phase.detail !== phase.label ? <small> · {phase.detail}</small> : null}</span>
                </div>
              ))}
              </div>
          )}
          {approvals.map((approval) => (
            <div key={approval.approvalId} className="approval-card">
              {(() => {
                const presentation = presentApproval(approval)
                return <>
              <div><strong>{approval.externalCoding ? 'External Coding Agent' : 'Your approval is needed'}</strong><span>{presentation.risk}</span></div>
              <dl className="approval-details approval-summary">
                <dt>What</dt><dd>{presentation.what}</dd>
                <dt>Where</dt><dd>{presentation.where}</dd>
                <dt>Why</dt><dd>{presentation.why}</dd>
                <dt>Impact</dt><dd>{presentation.impact}</dd>
                <dt>Risk</dt><dd>{presentation.risk}</dd>
                <dt>After approval</dt><dd>{presentation.afterApproval}</dd>
              </dl>
              {approval.externalCoding && (
                <dl className="approval-details">
                  <dt>Repository</dt><dd>{approval.externalCoding.repository}</dd>
                  <dt>Requested scope</dt><dd>{approval.externalCoding.requestedScope.join(', ') || 'No writable paths declared'}</dd>
                  <dt>Protected</dt><dd>{approval.externalCoding.protectedPaths.join(', ') || 'No additional paths declared'}</dd>
                  <dt>Network</dt><dd>Disabled</dd>
                  <dt>Package installation</dt><dd>Not allowed</dd>
                  <dt>Git write operations</dt><dd>Commit / Push / Tag / Merge disabled</dd>
                  <dt>Changes</dt><dd>Isolated until you review and apply them</dd>
                </dl>
              )}
              {approval.target && <code className="approval-target">{approval.target}</code>}
              <small>{approval.approvalId} · generation {approval.generation}</small>
              <div className="approval-actions">
                <button disabled={decisionPending === approval.approvalId} onClick={() => { void decide(approval.approvalId, 'approved') }}>Approve once</button>
                <button disabled={decisionPending === approval.approvalId} onClick={() => { void decide(approval.approvalId, 'denied') }}>Deny</button>
              </div>
                </>
              })()}
            </div>
          ))}
          {decisionError && <div className="approval-decision-error" role="alert">{decisionError}</div>}
        </div>
      )}
      {runArtifacts.length > 0 && (
        <div className="artifact-list">
          <h4>Artifacts</h4>
          {runArtifacts.map((artifact) => <ArtifactCard key={artifact.id} artifact={artifact} />)}
        </div>
      )}
      {codingSession && (
        <div className={`coding-result-card state-${codingSession.state}`} aria-label="External coding session">
          <div className="coding-result-heading">
            <strong>{codingSession.state === 'ready_for_review' ? 'Coding changes ready for review' : 'Coding session'}</strong>
            <span>{codingSession.state.replace(/_/g, ' ')}</span>
          </div>
          <p>
            {codingSession.changedPaths.length} {codingSession.changedPaths.length === 1 ? 'file' : 'files'} changed
            {' · '}{codingSession.validationRefs.length} validation {codingSession.validationRefs.length === 1 ? 'run' : 'runs'}
          </p>
          <small>
            {codingSession.provider.id} {codingSession.provider.version}
            {' · '}{codingSession.codingSessionId}
            {' · '}generation {codingSession.generation}
          </small>
          {codingReconciliationNeedsAttention(codingSession.reconciliationState) && (
            <div className="coding-reconciliation">
              <p>Previous isolated coding work requires reconciliation. No changes were applied to your workspace.</p>
              <details>
                <summary>Inspect retained attempt</summary>
                <p>{codingSession.changedPaths.length > 0
                  ? `Observed isolated paths: ${codingSession.changedPaths.join(', ')}`
                  : 'No isolated file changes were observed.'}</p>
                <small>
                  Workspace {codingSession.workspace?.state || 'unavailable'}
                  {' · '}process {codingSession.process?.treeDeadVerified ? 'stopped' : 'outcome unknown'}
                </small>
              </details>
              {!codingSession.promotion && (
                <div className="approval-actions">
                  <button type="button" disabled={codingPending !== null} onClick={() => { void discardUnknownCoding() }}>
                    Discard isolated attempt
                  </button>
                </div>
              )}
            </div>
          )}
          {codingSession.reconciliationState === 'reconciled' && codingSession.state === 'failed' && (
            <div className="coding-reconciliation">Previous isolated coding attempt was reconciled and closed. A new attempt may start.</div>
          )}
          {codingSession.reconciliation?.providerReportMatches === false
            && codingSession.reconciliation.actualOutcomeKnown && (
            <div className="coding-reconciliation">
              Provider-reported changes differed from the observed repository state.
              {codingSession.validationRefs.length > 0
                ? ' Aiden used the observed diff and independent validation.'
                : ' The observed diff remains authoritative.'}
            </div>
          )}
          {codingSession.changedPaths.length > 0 && (
            <details onToggle={(event) => {
              if (event.currentTarget.open && !codingReview) void reviewCoding()
            }}>
              <summary>Review changes</summary>
              {codingReviewError && <p className="coding-reconciliation">{codingReviewError}</p>}
              {!codingReview && !codingReviewError && <p>Loading exact candidate changesâ€¦</p>}
              {codingReview?.files.map((file) => (
                <section className="coding-review-file" key={file.path}>
                  <strong>{file.operation} <code>{file.path}</code></strong>
                  {file.before !== null && <pre><code>{file.before}</code></pre>}
                  {file.after !== null && <pre><code>{file.after}</code></pre>}
                  {file.truncated && <small>Preview truncated. The durable snapshot remains authoritative.</small>}
                </section>
              ))}
            </details>
          )}
          {codingSession.promotion && ['prepared', 'approval_required'].includes(codingSession.promotion.state) && (
            <div className="approval-actions">
              <button type="button" disabled={codingPending !== null} onClick={() => { void decideCoding('apply') }}>Apply changes</button>
              <button type="button" disabled={codingPending !== null} onClick={() => { void decideCoding('discard') }}>Discard</button>
            </div>
          )}
          {codingSession.promotion?.state === 'blocked_drift' && (
            <div className="coding-reconciliation">
              <p>Target workspace changed. Review the conflict before applying.</p>
              <div className="approval-actions">
                <button type="button" disabled={codingPending !== null} onClick={() => { void decideCoding('discard') }}>
                  Discard candidate
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      {browserSession && (
        <div className="browser-control-surface" aria-label="Browser control">
          <div>
            <strong>Browser</strong>
            <span>{browserSession.mode} · {browserSession.state.replace(/_/g, ' ')}</span>
          </div>
          <small>{browserSession.browserSessionId} · generation {browserSession.generation}</small>
          <div className="approval-actions">
            {browserSession.state === 'user_control'
              ? <button type="button" onClick={() => { void controlBrowser('return') }}>Return control</button>
              : ['ready', 'user_control_required'].includes(browserSession.state)
                ? <button type="button" onClick={() => { void controlBrowser('take') }}>Take control</button>
                : null}
            {['closed', 'cancelled', 'lost', 'failed'].includes(browserSession.state)
              ? <button type="button" onClick={() => { void controlBrowser('clear') }}>Clear stale session</button>
              : null}
          </div>
        </div>
      )}
    </section>
  )
}

function ChatPanel() {
  const {
    messages, input, setInput, isStreaming, execMode, setExecMode,
    thinking, budget,
    sendMessage, stopExecution, handleQuickUpload, addAttachmentFiles,
    attachments, removeAttachment, selectedContext,
    inputRef, kbInputRef, messagesEndRef,
    plusMenuOpen, setPlusMenuOpen,
    voiceStatus, isRecording, ttsEnabled, setTtsEnabled, recordingTimer, startRecording,
    uiMode, executionAvailable, workbenchReadOnly,
  } = useDevOS()

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, messagesEndRef])

  useEffect(() => {
    inputRef.current?.focus()
  }, [inputRef])

  const handleInputChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value)
    e.target.style.height = 'auto'
    e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px'
  }
  const activityAnchor = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === 'assistant') return index
    }
    return messages.length
  }, [messages])
  const hasSelectedWork = selectedContext.jobId !== null

  return (
    <section style={{
      display: 'flex', flexDirection: 'column',
      flex: 1, minHeight: 0,
      overflow: 'hidden', background: 'var(--bg)', minWidth: 0,
      position: 'relative',
    }}>
      {uiMode === 'watch' && <WorkflowView />}
      {/* Messages */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '24px 0', display: 'flex', flexDirection: 'column' }}>
        {messages.length === 0 ? (
          hasSelectedWork ? (
            <div className="conversation-column">
              <LiveActivitySurface />
              <div ref={messagesEndRef} />
            </div>
          ) : <EmptyState />
        ) : (
          <div className="conversation-column">
            {messages.map((msg, index) => (
              <Fragment key={msg.id}>
                {index === activityAnchor && hasSelectedWork && <LiveActivitySurface />}
                <ChatMessage message={msg} />
              </Fragment>
            ))}
            {activityAnchor === messages.length && hasSelectedWork && <LiveActivitySurface />}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Thinking indicator */}
      {thinking && !hasSelectedWork && (
        <div style={{
          maxWidth: 800, width: '100%', margin: '0 auto', padding: '4px 24px 2px',
          display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0,
          color: 'var(--muted)', fontSize: 13,
        }}>
          <div style={{ display: 'flex', gap: 4 }}>
            {[0, 1, 2].map(i => (
              <span key={i} style={{
                width: 6, height: 6, borderRadius: '50%',
                background: 'var(--orange)', display: 'inline-block',
                animation: `thinkingPulse 1.4s ${i * 0.2}s infinite ease-in-out`,
              }} />
            ))}
          </div>
          <span style={{ opacity: 0.7 }}>{thinking.message}</span>
          {budget && (
            <span style={{
              marginLeft: 'auto', fontSize: 11, opacity: 0.5,
              fontVariantNumeric: 'tabular-nums',
            }}>
              {budget.current}/{budget.max}
            </span>
          )}
        </div>
      )}

      {/* Input area */}
      <div className="workbench-composer" style={{
        borderTop: '1px solid var(--border)',
        padding: '12px 24px',
        background: 'var(--bg1)', flexShrink: 0,
      }} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' }} onDrop={(event) => {
        event.preventDefault()
        void addAttachmentFiles(Array.from(event.dataTransfer.files))
      }}>
        {attachments.length > 0 && (
          <div className="attachment-tray">
            {attachments.map((attachment) => (
              <span key={attachment.id} className="attachment-chip">
                <span>📎 {attachment.name}</span>
                <button type="button" aria-label={`Remove ${attachment.name}`} onClick={() => removeAttachment(attachment.id)}>×</button>
              </span>
            ))}
          </div>
        )}
        <div className="composer-row">
          {/* Plus menu trigger */}
          <div style={{ position: 'relative', flexShrink: 0 }}>
            <PlusMenu />
            <button
              onClick={() => setPlusMenuOpen(!plusMenuOpen)}
              title="Actions"
              style={{
                width: 36, height: 36, borderRadius: 6,
                background: plusMenuOpen ? 'rgba(249,115,22,0.12)' : 'var(--bg2)',
                border: plusMenuOpen ? '1px solid rgba(249,115,22,0.35)' : '1px solid var(--border2)',
                color: plusMenuOpen ? 'var(--orange)' : 'var(--muted2)',
                cursor: 'pointer', fontSize: 18,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                transition: 'all 0.15s',
              }}
            >+</button>
          </div>
          <input
            ref={kbInputRef} type="file" multiple accept=".txt,.md,.markdown,.json,.yaml,.yml,.csv,.ts,.tsx,.js,.jsx,.py,.rs,.go,.java,.c,.cpp,.h,.hpp,.html,.css,.svg,.png,.jpg,.jpeg,.webp,.gif,.pdf"
            style={{ display: 'none' }} onChange={handleQuickUpload}
          />

          {/* Textarea */}
          <textarea
            ref={inputRef}
            value={input}
            onChange={handleInputChange}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() } }}
            placeholder={hasSelectedWork ? 'Add an instruction…' : 'What should Aiden take care of?'}
            rows={1}
            disabled={isStreaming && hasSelectedWork}
            style={{
              flex: 1, resize: 'none',
              background: 'var(--bg2)', border: '1px solid var(--border2)',
              borderRadius: 8, padding: '9px 14px',
              fontFamily: 'var(--sans)', fontSize: 15,
              color: 'var(--text)', outline: 'none',
              minHeight: 38, maxHeight: 120,
              transition: 'border-color 0.2s', lineHeight: 1.6,
            }}
          />

          {/* Voice input button — shown only when STT available */}
          {voiceStatus.stt && (
            <button
              onClick={startRecording}
              disabled={isStreaming}
              title={isRecording ? `Recording... ${recordingTimer}s` : 'Voice input (5s)'}
              style={{
                width: 36, height: 36, borderRadius: '50%', flexShrink: 0,
                background: isRecording ? 'rgba(239,68,68,0.15)' : 'var(--bg2)',
                border: `1px solid ${isRecording ? 'rgba(239,68,68,0.4)' : 'var(--border2)'}`,
                color: isRecording ? '#ef4444' : 'var(--muted2)',
                cursor: isStreaming ? 'not-allowed' : 'pointer',
                fontSize: isRecording ? 13 : 14,
                fontFamily: isRecording ? 'var(--mono)' : 'inherit',
                transition: 'all 0.2s',
                animation: isRecording ? 'pulse-dot 0.8s infinite' : 'none',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
            >
              {isRecording ? `${recordingTimer}` : '🎤'}
            </button>
          )}

          {/* TTS toggle button — shown only when TTS available */}
          {voiceStatus.tts && (
            <button
              onClick={() => setTtsEnabled(!ttsEnabled)}
              title={ttsEnabled ? 'Disable voice responses' : 'Enable voice responses (Aiden speaks)'}
              style={{
                width: 36, height: 36, borderRadius: '50%', flexShrink: 0,
                background: ttsEnabled ? 'rgba(249,115,22,0.15)' : 'var(--bg2)',
                border: `1px solid ${ttsEnabled ? 'rgba(249,115,22,0.4)' : 'var(--border2)'}`,
                color: ttsEnabled ? 'var(--orange)' : 'var(--muted2)',
                cursor: 'pointer', fontSize: 14, transition: 'all 0.2s',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>
            </button>
          )}

          {/* Stop / Send */}
          {thinking ? (
            <button
              onClick={stopExecution}
              title="Stop"
              style={{
                width: 36, height: 36, borderRadius: '50%', flexShrink: 0,
                background: 'rgba(239,68,68,0.12)',
                border: '1px solid rgba(239,68,68,0.4)',
                color: '#ef4444',
                cursor: 'pointer', fontSize: 14, transition: 'all 0.2s',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
            </button>
          ) : (
            <button
              onClick={() => sendMessage()}
              disabled={(!input.trim() && attachments.length === 0) || (isStreaming && hasSelectedWork) || !executionAvailable || workbenchReadOnly}
              style={{
                width: 36, height: 36, borderRadius: '50%', flexShrink: 0,
                background: (input.trim() || attachments.length > 0) && !(isStreaming && hasSelectedWork) && executionAvailable && !workbenchReadOnly ? 'var(--orange)' : 'var(--bg3)',
                border: 'none',
                color: (input.trim() || attachments.length > 0) && !(isStreaming && hasSelectedWork) && executionAvailable && !workbenchReadOnly ? '#000' : 'var(--muted)',
                cursor: (input.trim() || attachments.length > 0) && !(isStreaming && hasSelectedWork) && executionAvailable && !workbenchReadOnly ? 'pointer' : 'not-allowed',
                fontSize: 14, transition: 'all 0.2s',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
            </button>
          )}
        </div>
        {(!executionAvailable || workbenchReadOnly) && (
          <div style={{ maxWidth: 800, margin: '6px auto 0', color: 'var(--muted)', fontSize: 10 }}>
            {workbenchReadOnly
              ? 'This Workbench is read-only.'
              : 'Task execution is unavailable. Configure a provider with the Aiden CLI, then restart Workbench.'}
          </div>
        )}
      </div>
    </section>
  )
}

// ── GrowthCard ────────────────────────────────────────────────
// Sprint 27: shows GrowthEngine stats + UserCognition profile

function GrowthCard() {
  const [data,     setData]     = useState<any>(null)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    fetch('http://localhost:4200/api/growth')
      .then(r => r.json())
      .then(d => setData(d))
      .catch(() => {})

    // Refresh every 2 minutes
    const id = setInterval(() => {
      fetch('http://localhost:4200/api/growth')
        .then(r => r.json())
        .then(d => setData(d))
        .catch(() => {})
    }, 120_000)
    return () => clearInterval(id)
  }, [])

  if (!data || data.error) return null

  return (
    <div style={{
      background: 'var(--bg1)', border: '1px solid var(--border)',
      borderRadius: 10, padding: '12px 14px', margin: '8px 14px 0',
      fontFamily: 'var(--mono)', flexShrink: 0,
    }}>
      {/* Header */}
      <div
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', marginBottom: expanded ? 12 : 0 }}
        onClick={() => setExpanded(e => !e)}
      >
        <span style={{ fontSize: 10, color: 'var(--orange)', fontWeight: 600, letterSpacing: '.08em', textTransform: 'uppercase' }}>
          ⚡ Aiden is growing
        </span>
        <span style={{ fontSize: 9, color: 'var(--muted)', marginLeft: 8 }}>
          {expanded ? '▲ collapse' : '▼ expand'}
        </span>
      </div>

      {expanded && (
        <>
          {/* Key stats row */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6, marginBottom: 10 }}>
            {[
              { value: data.skillsLearned,       label: 'skills' },
              { value: `${data.successRate}%`,   label: 'success' },
              { value: data.totalActions,        label: 'actions' },
            ].map((stat, i) => (
              <div key={i} style={{ textAlign: 'center', background: 'var(--bg2)', borderRadius: 6, padding: '7px 4px' }}>
                <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--orange)' }}>{stat.value}</div>
                <div style={{ fontSize: 9, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.06em' }}>{stat.label}</div>
              </div>
            ))}
          </div>

          {/* Today sub-row */}
          <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
            <div style={{ fontSize: 9, color: 'var(--muted)' }}>
              Today: <span style={{ color: 'var(--muted2)' }}>{data.todaySuccess}/{data.todayActions} tasks succeeded</span>
            </div>
          </div>

          {/* UserCognition profile */}
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 8, marginBottom: 8 }}>
            <div style={{ fontSize: 9, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 6 }}>
              Aiden thinks you prefer
            </div>
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' as const }}>
              {[
                data.profile?.verbosity,
                (data.profile?.technicalLevel || '') + ' technical',
                data.profile?.decisionStyle,
              ].filter(Boolean).map((tag: string, i: number) => (
                <span key={i} style={{
                  fontSize: 10, padding: '2px 7px', borderRadius: 4,
                  background: 'var(--odim)',
                  border: '1px solid rgba(249,115,22,.2)',
                  color: 'var(--orange)',
                }}>{tag}</span>
              ))}
            </div>
          </div>

          {/* Proactive pattern suggestion */}
          {data.patterns?.length > 0 && (
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: 8 }}>
              <div style={{ fontSize: 10, color: 'var(--muted2)', lineHeight: 1.5 }}>
                {data.patterns[0].suggestion}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ── NasaLiveEventsCard ────────────────────────────────────────

interface NasaEvent {
  id:         string
  title:      string
  categories: { id: string; title: string }[]
  geometry:   { date: string }[]
}

function NasaLiveEventsCard() {
  const [events,    setEvents]    = useState<NasaEvent[]>([])
  const [summary,   setSummary]   = useState('')
  const [loading,   setLoading]   = useState(true)
  const [fetchedAt, setFetchedAt] = useState(0)

  const load = useCallback(async () => {
    try {
      const res  = await fetch('http://localhost:4200/api/natural-events', {
        signal: AbortSignal.timeout(8000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json() as { events: NasaEvent[]; summary: string; fetchedAt: number }
      setEvents(data.events ?? [])
      setSummary(data.summary ?? '')
      setFetchedAt(data.fetchedAt ?? Date.now())
    } catch {
      setEvents([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    const id = setInterval(load, 30 * 60 * 1000)
    return () => clearInterval(id)
  }, [load])

  if (!loading && events.length === 0) return null

  const top3 = events.slice(0, 3)

  const catEmoji = (id: string) =>
    id === 'wildfires'    ? '🔥' :
    id === 'severeStorms' ? '🌪️' :
    id === 'volcanoes'    ? '🌋' :
    id === 'floods'       ? '🌊' :
    id === 'earthquakes'  ? '🫨' : '⚠️'

  return (
    <div style={{
      margin: '0 10px 10px',
      background: 'var(--bg2)',
      border: '1px solid rgba(249,115,22,0.2)',
      borderRadius: 8,
      padding: '10px 12px',
      flexShrink: 0,
      fontFamily: 'var(--mono)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--orange)', fontWeight: 700 }}>
          <span>🌍</span>
          <span>NASA Live Events</span>
          {events.length > 0 && (
            <span style={{
              background: 'rgba(249,115,22,0.15)', color: 'var(--orange)',
              borderRadius: 10, padding: '1px 7px', fontSize: 9, fontWeight: 700,
            }}>{events.length}</span>
          )}
        </div>
        {fetchedAt > 0 && (
          <span style={{ fontSize: 9, color: 'var(--muted)' }}>
            {new Date(fetchedAt).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hour12: false })}
          </span>
        )}
      </div>

      {loading ? (
        <div style={{ fontSize: 10, color: 'var(--muted)', textAlign: 'center', padding: '4px 0' }}>fetching…</div>
      ) : top3.length === 0 ? (
        <div style={{ fontSize: 10, color: 'var(--muted)' }}>No active high-impact events</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {top3.map(ev => {
            const catId  = ev.categories?.[0]?.id ?? ''
            const emoji  = catEmoji(catId)
            const latest = ev.geometry?.[ev.geometry.length - 1]
            const date   = latest?.date
              ? new Date(latest.date).toLocaleDateString('en-IN', { month: 'short', day: 'numeric' })
              : ''
            return (
              <div key={ev.id} style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                <span style={{ fontSize: 13, flexShrink: 0, lineHeight: '16px' }}>{emoji}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 10, color: 'var(--text)', lineHeight: 1.4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {ev.title}
                  </div>
                  <div style={{ fontSize: 9, color: 'var(--muted)', marginTop: 1 }}>
                    {ev.categories?.[0]?.title ?? catId}{date ? ` · ${date}` : ''}
                  </div>
                </div>
              </div>
            )
          })}
          {events.length > 3 && (
            <div style={{ fontSize: 9, color: 'var(--muted)', marginTop: 2 }}>
              +{events.length - 3} more active events
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── LiveViewPanel ─────────────────────────────────────────────

interface PulseEntry {
  type: string
  agent: string
  message: string
  timestamp: number
  tool?: string
}

// Legacy market/news briefing content remains a chat output, not an attention
// authority. Agentic Presence owns startup and operational attention above.
function LiveViewPanel() {
  const { setActivityLogs, setMessages } = useDevOS()

  // WebSocket connection to LivePulse bridge
  useEffect(() => {
    const ws = new WebSocket('ws://localhost:4200')
    ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data)
        if (data.type === 'briefing' && data.content) {
          const timestamp = Number.isFinite(Number(data.timestamp)) ? Number(data.timestamp) : 0
          const label = (data.label as string) ?? 'Morning Briefing'
          const id = `market_briefing_${timestamp}_${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`
          setMessages((prev: Message[]) => prev.some((message) => message.id === id) ? prev : [...prev, {
            id,
            role:           'assistant' as const,
            content:        data.content as string,
            timestamp,
            isBriefing:     true,
            briefingLabel:  label,
            isStreaming:    false,
          }])
          return
        }
        if (data.type === 'pulse' && data.event) {
          const { type, agent, message, tool } = data.event as PulseEntry
          const icon = type === 'done' ? '✅' : type === 'error' ? '❌' : type === 'tool' ? '🔧' : type === 'thinking' ? '💭' : '⚡'
          const now  = new Date().toLocaleTimeString('en', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
          setActivityLogs(prev => [...prev.slice(-99), {
            time: now, icon, agent: agent || 'Aiden',
            message: tool ? `${tool}: ${message}` : message,
            style: (type === 'done' ? 'ok' : type === 'error' ? 'err' : type === 'tool' || type === 'act' ? 'active' : 'default') as ActivityLog['style'],
          }])
        }
      } catch {}
    }
    ws.onerror = () => {}
    return () => { try { ws.close() } catch {} }
  }, [setActivityLogs, setMessages])

  return null // headless — no UI rendered
}

// ── StatusBar (replaces ActivityBar + DisclaimerBar) ─────────

function StatusBar() {
  const { runtimeConnection, runtimeVersion, runtimeEdition, activeJobs, updateBanner, setSettingsOpen, setSettingsTab } = useDevOS()

  return (
    <div className="system-awareness-strip" style={{
      height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center',
      gap: 10, flexShrink: 0,
      background: 'var(--bg1)', borderTop: '1px solid var(--border)',
      fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--muted)',
      userSelect: 'none',
    }}>
      <span style={{ color: 'var(--muted3)' }}>Aiden v{runtimeVersion}</span>
      <span style={{ color: 'var(--border2)' }}>·</span>
      <span>{runtimeEdition === 'community' ? 'Community' : runtimeEdition[0].toUpperCase() + runtimeEdition.slice(1)}</span>
      <span style={{ color: 'var(--border2)' }}>·</span>
      <span>Local</span>
      <span style={{ color: 'var(--border2)' }}>·</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--green)', display: 'inline-block' }} />
         {runtimeConnection}
      </span>
      <span style={{ color: 'var(--border2)' }}>·</span>
      <span>{activeJobs.length > 0 ? `${activeJobs.length} active` : 'Your work stays on this computer'}</span>
      {updateBanner && (
        <>
          <span style={{ color: 'var(--border2)' }}>·</span>
          <span
            onClick={() => { setSettingsOpen(true); setSettingsTab('updates') }}
            style={{ color: 'var(--orange)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 3 }}
          >
            ⬆ Update v{updateBanner.version}
          </span>
        </>
      )}
      <span style={{ color: 'var(--border2)' }}>·</span>
      <a href="https://taracod.com" target="_blank" rel="noopener" style={{ color: 'var(--muted)', textDecoration: 'none' }}>
        taracod.com
      </a>
    </div>
  )
}

// ── MemoryView ────────────────────────────────────────────────

function MemoryView() {
  const [data, setData] = useState<any>(null)
  useEffect(() => {
    fetch('http://localhost:4200/api/memory').then(r => r.json()).then(setData).catch(() => {})
  }, [])
  return (
    <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--muted2)' }}>
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 9, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 6 }}>Recent Facts</div>
        {data?.recentHistory?.slice(0, 5).map((item: any, i: number) => (
          <div key={i} style={{ padding: '5px 0', borderBottom: '1px solid var(--border)', color: 'var(--muted2)', fontSize: 11, lineHeight: 1.5 }}>
            {typeof item === 'string' ? item.slice(0, 120) : JSON.stringify(item).slice(0, 120)}
          </div>
        )) || <div style={{ color: 'var(--muted)' }}>No memory yet</div>}
      </div>
      <div style={{ marginTop: 16 }}>
        <div style={{ fontSize: 9, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 6 }}>Stats</div>
        <div>Semantic items: {data?.semanticItems || 0}</div>
        <div>Sessions: {data?.sessions || 1}</div>
      </div>
      <button onClick={() => {
        if (window.confirm('Clear all memory? Cannot be undone.')) {
          fetch('http://localhost:4200/api/memory', { method: 'DELETE' }).catch(() => {})
          setData(null)
        }
      }} style={{
        marginTop: 16, width: '100%', padding: '8px',
        background: 'transparent', border: '1px solid rgba(239,68,68,0.3)',
        borderRadius: 6, color: 'var(--red)', fontFamily: 'var(--mono)',
        fontSize: 11, cursor: 'pointer',
      }}>Clear All Memory</button>
    </div>
  )
}

// ── SkillsManager ─────────────────────────────────────────────

const SOURCE_COLORS: Record<string, string> = {
  'built-in': 'var(--orange)',
  'workspace': '#60a5fa',
  'learned':   '#34d399',
  'approved':  '#a78bfa',
}

function SkillsManager() {
  const { capabilities } = useDevOS()
  const [skills, setSkills]       = useState<any[]>(capabilities?.skills ?? [])
  const [loading, setLoading]     = useState(capabilities === null)
  const [filter, setFilter]       = useState<'all' | 'built-in' | 'learned' | 'approved' | 'workspace'>('all')

  useEffect(() => {
    setSkills((capabilities?.skills ?? []).map((skill) => ({ ...skill, source: skill.category || 'runtime', enabled: true })))
    setLoading(capabilities === null)
  }, [capabilities])

  const refresh = () => undefined

  const visible = filter === 'all' ? skills : skills.filter(s => s.source === filter)
  const counts  = skills.reduce((acc: Record<string, number>, s) => {
    acc[s.source] = (acc[s.source] || 0) + 1; return acc
  }, {})

  return (
    <div style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>
      {/* Summary bar */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
        {(['all', 'built-in', 'learned', 'approved', 'workspace'] as const).map(f => {
          const count = f === 'all' ? skills.length : (counts[f] || 0)
          if (f !== 'all' && count === 0) return null
          return (
            <button key={f} type="button" onClick={() => setFilter(f)} style={{
              padding: '3px 8px', borderRadius: 4, cursor: 'pointer',
              border: `1px solid ${filter === f ? (f === 'all' ? 'var(--orange)' : SOURCE_COLORS[f]) : 'var(--border)'}`,
              background: filter === f ? 'rgba(255,255,255,0.05)' : 'transparent',
              color: filter === f ? (f === 'all' ? 'var(--orange)' : SOURCE_COLORS[f]) : 'var(--muted2)',
              fontSize: 10,
            }}>{f} ({count})</button>
          )
        })}
        <button type="button" onClick={refresh} disabled title="Managed by the Aiden runtime" style={{
          marginLeft: 'auto', padding: '3px 10px', borderRadius: 4,
          border: '1px solid var(--border)', background: 'transparent',
          color: 'var(--muted2)', fontSize: 10, cursor: 'pointer',
        }}>⟲ Refresh</button>
      </div>

      {/* List */}
      {loading && <div style={{ color: 'var(--muted)', textAlign: 'center', padding: 20 }}>Loading skills…</div>}
      {!loading && visible.length === 0 && (
        <div style={{ color: 'var(--muted)', textAlign: 'center', padding: 20 }}>No skills found</div>
      )}
      {visible.map((skill: any) => {
        const isBuiltIn  = skill.source === 'built-in'
        const srcColor   = SOURCE_COLORS[skill.source] || 'var(--muted)'
        const isToggling = false
        return (
          <div key={skill.name} style={{
            padding: '10px 12px', marginBottom: 6,
            background: skill.enabled ? 'var(--bg)' : 'rgba(0,0,0,0.3)',
            border: `1px solid ${skill.enabled ? 'var(--border)' : 'rgba(255,255,255,0.06)'}`,
            borderRadius: 6, opacity: skill.enabled ? 1 : 0.55,
            transition: 'opacity 0.2s',
          }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                  <span style={{ color: 'var(--text)', fontWeight: 600 }}>{skill.name}</span>
                  <span style={{ fontSize: 9, color: srcColor, border: `1px solid ${srcColor}`, borderRadius: 3, padding: '0 4px', opacity: 0.8 }}>{skill.source}</span>
                  {skill.version && <span style={{ fontSize: 9, color: 'var(--muted)', opacity: 0.6 }}>v{skill.version}</span>}
                </div>
                <div style={{ color: 'var(--muted2)', fontSize: 11, lineHeight: 1.4 }}>{skill.description || '—'}</div>
                {skill.tags?.length > 0 && (
                  <div style={{ marginTop: 4, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    {skill.tags.map((tag: string) => (
                      <span key={tag} style={{ fontSize: 9, color: 'var(--muted)', background: 'var(--bg2)', borderRadius: 3, padding: '1px 5px' }}>{tag}</span>
                    ))}
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                {/* Toggle */}
                <button type="button" disabled title="Managed by the Aiden runtime" style={{
                  padding: '3px 7px', borderRadius: 4, cursor: 'pointer',
                  border: `1px solid ${skill.enabled ? 'rgba(52,211,153,0.4)' : 'var(--border)'}`,
                  background: skill.enabled ? 'rgba(52,211,153,0.08)' : 'transparent',
                  color: skill.enabled ? '#34d399' : 'var(--muted)', fontSize: 10,
                }}>{isToggling ? '…' : skill.enabled ? 'ON' : 'OFF'}</button>
                {/* Delete — only for non built-in */}
                {false && !isBuiltIn && (
                  <button type="button" disabled title="Managed by the Aiden runtime" style={{
                    padding: '3px 7px', borderRadius: 4, cursor: 'pointer',
                    border: '1px solid rgba(239,68,68,0.3)', background: 'transparent',
                    color: 'var(--red)', fontSize: 10,
                  }}>✕</button>
                )}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── MCPView ───────────────────────────────────────────────────

function MCPView() {
  const [url, setUrl] = useState('')
  const [plugins, setPlugins] = useState<any[]>([])
  useEffect(() => {
    fetch('http://localhost:4200/api/mcp/list').then(r => r.json()).then(d => setPlugins(d.plugins || [])).catch(() => {})
  }, [])
  const connect = async () => {
    if (!url.trim()) return
    try {
      await fetch('http://localhost:4200/api/mcp/connect', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim() }),
      })
      setUrl('')
      fetch('http://localhost:4200/api/mcp/list').then(r => r.json()).then(d => setPlugins(d.plugins || [])).catch(() => {})
    } catch {}
  }
  return (
    <div style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 9, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 8 }}>Add Plugin</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input value={url} onChange={e => setUrl(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && connect()}
            placeholder="Plugin URL or npm package..."
            style={{
              flex: 1, background: 'var(--bg)', border: '1px solid var(--border2)',
              borderRadius: 5, padding: '7px 10px', fontFamily: 'var(--mono)',
              fontSize: 11, color: 'var(--text)', outline: 'none',
            }} />
          <button onClick={connect} style={{
            padding: '7px 14px', background: 'var(--orange)', border: 'none',
            borderRadius: 5, color: '#000', fontFamily: 'var(--mono)',
            fontSize: 11, fontWeight: 600, cursor: 'pointer',
          }}>Add</button>
        </div>
      </div>
      {plugins.length === 0
        ? <div style={{ color: 'var(--muted)', textAlign: 'center', padding: 20 }}>No plugins connected</div>
        : plugins.map((p: any, i: number) => (
          <div key={i} style={{
            padding: '8px 12px', marginBottom: 6,
            background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6,
            display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--green)', flexShrink: 0 }} />
            <span style={{ flex: 1, color: 'var(--muted2)' }}>{p.name || p.url}</span>
          </div>
        ))
      }
    </div>
  )
}

// ── ChannelModal ──────────────────────────────────────────────

const CHANNEL_IDS_LIST = ['telegram', 'whatsapp', 'discord', 'slack', 'email']

const CHANNEL_CONFIG: Record<string, any> = {
  telegram: {
    title: '💬 Telegram',
    fields: [{ id: 'token', label: 'Bot Token', placeholder: 'Your Telegram bot token...', type: 'password' }],
    help: 'Create a bot via @BotFather on Telegram. Copy the token and paste it here.',
  },
  whatsapp: { title: '📱 WhatsApp', fields: [], help: '' },
  discord: {
    title: '🎮 Discord',
    fields: [
      { id: 'token', label: 'Bot Token', placeholder: 'Discord bot token...', type: 'password' },
      { id: 'channel', label: 'Channel ID', placeholder: 'Channel ID...', type: 'text' },
    ],
    help: 'Create a bot at discord.com/developers. Enable MESSAGE_CONTENT intent.',
  },
  slack: {
    title: '💼 Slack',
    fields: [{ id: 'token', label: 'Bot Token', placeholder: 'xoxb-...', type: 'password' }],
    help: 'Create a Slack app at api.slack.com. Add the bot token (xoxb-...) here.',
  },
  email: {
    title: '📧 Email',
    fields: [
      { id: 'token', label: 'SMTP Password / App Password', placeholder: 'App password...', type: 'password' },
      { id: 'channel', label: 'Email Address', placeholder: 'your@email.com', type: 'text' },
    ],
    help: 'Use a Gmail App Password (2FA required). DevOS sends and receives email on your behalf.',
  },
  memory: { title: '🧠 Memory', renderContent: () => <MemoryView />, fields: [], help: '' },
  skills: { title: '📚 Skills', renderContent: () => <SkillsManager />, fields: [], help: '' },
  mcp:    { title: '🔌 MCP Plugins', renderContent: () => <MCPView />, fields: [], help: '' },
}

function ChannelModal() {
  const { channelModal, setChannelModal, channelStatuses, setSettingsOpen, setSettingsTab } = useDevOS()
  const [token, setToken]   = useState('')
  const [extra, setExtra]   = useState('')
  const [saving, setSaving] = useState(false)
  const [saved,  setSaved]  = useState(false)

  useEffect(() => { setToken(''); setExtra(''); setSaving(false); setSaved(false) }, [channelModal])

  if (!channelModal) return null
  const config = CHANNEL_CONFIG[channelModal]
  if (!config) return null

  const saveChannel = async () => {
    setSaving(true)
    try {
      await fetch('http://localhost:4200/api/channels/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: channelModal, token, extra }),
      })
      setSaved(true)
      setTimeout(() => { setChannelModal(null); setSaved(false) }, 1400)
    } catch {
      setSaving(false)
    }
  }

  const isChannel = CHANNEL_IDS_LIST.includes(channelModal)

  return (
    <>
      <div onClick={() => setChannelModal(null)} style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
        zIndex: 300, backdropFilter: 'blur(4px)',
      }} />
      <div style={{
        position: 'fixed', top: '50%', left: '50%',
        transform: 'translate(-50%,-50%)',
        background: 'var(--bg2)', border: '1px solid var(--border2)',
        borderRadius: 12, padding: 24, width: 380,
        maxHeight: '80vh', overflowY: 'auto',
        zIndex: 301, animation: 'fadeInUp 0.2s ease-out',
      }}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 14, color: 'var(--text)', fontWeight: 600 }}>
            {config.title}
          </span>
          <button onClick={() => setChannelModal(null)} style={{
            background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 18,
          }}>✕</button>
        </div>

        {/* Custom render content (memory, skills, mcp) */}
        {'renderContent' in config && config.renderContent
          ? config.renderContent()
          : (
            <>
              {/* Status badge for channels */}
              {isChannel && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 16, fontFamily: 'var(--mono)', fontSize: 11 }}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: channelStatuses[channelModal] ? 'var(--green)' : 'var(--muted)' }} />
                  <span style={{ color: 'var(--muted)' }}>{channelStatuses[channelModal] ? 'Connected' : 'Not connected'}</span>
                </div>
              )}

              {/* WhatsApp QR special case */}
              {channelModal === 'whatsapp' ? (
                <div style={{ textAlign: 'center', padding: '12px 0' }}>
                  <div style={{ fontSize: 40, marginBottom: 12 }}>📱</div>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--muted2)', lineHeight: 1.8 }}>
                    WhatsApp connects via QR code.<br />
                    Open your DevOS terminal and<br />
                    scan the QR code that appears.
                  </div>
                  <div style={{ marginTop: 12, padding: '8px 12px', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)' }}>
                    {channelStatuses['whatsapp'] ? '● Connected' : '○ Scan QR to connect'}
                  </div>
                </div>
              ) : (
                <>
                  {/* Input fields */}
                  {config.fields?.map((field: any, i: number) => (
                    <div key={field.id} style={{ marginBottom: 12 }}>
                      <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--mono)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                        {field.label}
                      </div>
                      <input
                        type={field.type || 'text'}
                        placeholder={field.placeholder}
                        onChange={e => i === 0 ? setToken(e.target.value) : setExtra(e.target.value)}
                        style={{
                          width: '100%', background: 'var(--bg)',
                          border: '1px solid var(--border2)', borderRadius: 6,
                          padding: '8px 12px', fontFamily: 'var(--mono)',
                          fontSize: 12, color: 'var(--text)', outline: 'none',
                        }}
                      />
                    </div>
                  ))}

                  {/* Help text */}
                  {config.help && (
                    <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--mono)', lineHeight: 1.6, marginBottom: 16, padding: '8px 12px', background: 'var(--bg)', borderRadius: 6, border: '1px solid var(--border)' }}>
                      {config.help}
                    </div>
                  )}

                  {/* Save button */}
                  {config.fields?.length > 0 && (
                    <button onClick={saveChannel} disabled={saving || saved} style={{
                      width: '100%', padding: '10px',
                      background: saved ? 'rgba(34,197,94,0.15)' : 'var(--orange)',
                      border: saved ? '1px solid rgba(34,197,94,0.3)' : 'none',
                      borderRadius: 6, color: saved ? 'var(--green)' : '#000',
                      fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 600,
                      cursor: saving ? 'not-allowed' : 'pointer',
                    }}>
                      {saved ? '✓ Saved!' : saving ? 'Saving...' : 'Save & Connect'}
                    </button>
                  )}
                </>
              )}

              {/* View Setup Guide link */}
              <div style={{ marginTop: 16, textAlign: 'center' }}>
                <button onClick={() => { setChannelModal(null); setSettingsTab('setup'); setSettingsOpen(true) }} style={{
                  background: 'none', border: 'none', color: 'var(--muted)',
                  fontFamily: 'var(--mono)', fontSize: 10, cursor: 'pointer',
                  textDecoration: 'underline',
                }}>View Setup Guide →</button>
              </div>
            </>
          )
        }
      </div>
    </>
  )
}

// ── DisclaimerBar ─────────────────────────────────────────────

function DisclaimerBar() {
  return (
    <div style={{
      height: 24, display: 'flex', alignItems: 'center',
      justifyContent: 'center', gap: 8, flexShrink: 0,
      background: 'var(--bg1)', borderTop: '1px solid var(--border)',
      fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--muted)',
    }}>
      <span>Aiden is an AI and can make mistakes. Always verify important responses.</span>
      <span style={{ color: 'var(--border2)' }}>·</span>
      <span>
        Built by{' '}
        <a href="https://taracod.com" target="_blank" rel="noopener" style={{ color: 'var(--muted2)', textDecoration: 'none' }}>
          Shiva Deore
        </a>
        {' '}at Taracod · White Lotus · © 2026
      </span>
    </div>
  )
}

// ── UserProfileTab ────────────────────────────────────────────

function UserProfileTab() {
  const [content,  setContent]  = useState('')
  const [loading,  setLoading]  = useState(true)
  const [saving,   setSaving]   = useState(false)
  const [saved,    setSaved]    = useState(false)
  const [exists,   setExists]   = useState(false)

  useEffect(() => {
    fetch('http://localhost:4200/api/user-profile')
      .then(r => r.json())
      .then((d: { exists: boolean; content: string }) => {
        setExists(d.exists)
        setContent(d.content ?? '')
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  async function save() {
    setSaving(true)
    setSaved(false)
    try {
      await fetch('http://localhost:4200/api/user-profile', {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ content }),
      })
      setSaved(true)
      setExists(true)
      setTimeout(() => setSaved(false), 2500)
    } catch {}
    setSaving(false)
  }

  if (loading) return <div style={{ color: 'var(--muted)', fontSize: 11, padding: '20px 0' }}>Loading profile…</div>

  return (
    <div>
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 12, color: 'var(--text)', fontWeight: 600, marginBottom: 4 }}>
          {exists ? 'Edit Your Profile' : 'Create Your Profile'}
        </div>
        <div style={{ fontSize: 11, color: 'var(--muted2)', lineHeight: 1.6 }}>
          Aiden injects this into every conversation so it always knows who you are, your role, what to monitor, and how you like to communicate.
        </div>
      </div>

      <textarea
        value={content || "# User Profile\nName: \nRole: \nTimezone: \nLocation: \n\n# Preferences\nResponse style: Direct, concise, no fluff\nTechnical level: Expert\nAutonomy level: Assistant\n\n# Accounts & Tools\n- GitHub: \n- Primary browser: Chrome\n\n# Proactive Monitoring\n- Markets: \n- Email: \n- Folders to watch: \n- Repos to monitor: \n\n# Notes\n"}
        onChange={e => setContent(e.target.value)}
        spellCheck={false}
        style={{
          width: '100%', minHeight: 380,
          background: 'var(--bg2)', border: '1px solid var(--border)',
          borderRadius: 7, padding: '12px 14px',
          fontFamily: 'var(--mono)', fontSize: 11,
          color: 'var(--text)', lineHeight: 1.7,
          resize: 'vertical', outline: 'none',
          boxSizing: 'border-box',
        }}
      />

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
        <button
          onClick={save}
          disabled={saving}
          style={{
            background: saving ? 'var(--bg3)' : 'var(--orange)',
            border: 'none', borderRadius: 6,
            padding: '8px 20px', fontSize: 11, fontWeight: 700,
            color: saving ? 'var(--muted)' : '#000',
            fontFamily: 'var(--mono)', cursor: saving ? 'default' : 'pointer',
            transition: 'all 0.15s',
          }}
        >
          {saving ? 'Saving…' : 'Save profile'}
        </button>
        {saved && (
          <span style={{ fontSize: 11, color: 'var(--green)' }}>✓ Saved — Aiden will use this from next message</span>
        )}
      </div>

      <div style={{ marginTop: 16, padding: '10px 12px', background: 'var(--bg2)', borderRadius: 6, border: '1px solid var(--border)' }}>
        <div style={{ fontSize: 10, color: 'var(--muted)', lineHeight: 1.6 }}>
          <strong style={{ color: 'var(--muted2)' }}>How it works:</strong> This markdown file is saved to{' '}
          <code style={{ background: 'var(--bg3)', padding: '1px 5px', borderRadius: 3 }}>workspace/USER.md</code>{' '}
          and prepended to Aiden&apos;s system prompt on every message. Edit freely — plain text or markdown both work.
        </div>
      </div>
    </div>
  )
}

// ── PluginsList ────────────────────────────────────────────────

interface PluginInfo {
  name:        string
  version:     string
  description: string
  author?:     string
  active:      boolean
}

function PluginsList() {
  const { capabilities } = useDevOS()
  const plugins = (capabilities?.plugins ?? []).map((plugin) => ({
    ...plugin,
    active: plugin.status === 'active' || plugin.status === 'loaded' || plugin.status === 'ready',
  }))
  const loading = capabilities === null

  if (loading) return <p style={settingsTextStyle}>Loading plugins...</p>

  return (
    <div>
      {plugins.length === 0 ? (
        <div style={{ ...settingsTextStyle, padding: '16px 0' }}>
          No plugins loaded. Drop a plugin folder into{' '}
          <code style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--orange)' }}>
            workspace/plugins/
          </code>{' '}
          to get started.
        </div>
      ) : (
        plugins.map(p => (
          <div key={p.name} style={{
            background: 'var(--bg2)', border: '1px solid var(--border)',
            borderRadius: 8, padding: '12px 14px', marginBottom: 10,
            display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10,
          }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text)', fontWeight: 600 }}>
                {p.name}
                <span style={{ color: 'var(--muted)', fontWeight: 400, marginLeft: 6 }}>
                  v{p.version}
                </span>
                {p.author && (
                  <span style={{ color: 'var(--muted2)', fontWeight: 400, marginLeft: 8, fontSize: 10 }}>
                    by {p.author}
                  </span>
                )}
              </div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4, lineHeight: 1.4 }}>
                {p.description}
              </div>
            </div>
            <span style={{
              background:    p.active ? 'rgba(34,197,94,0.12)' : 'var(--bg3)',
              color:         p.active ? 'var(--green)'          : 'var(--muted)',
              fontSize:      9,
              fontFamily:    'var(--mono)',
              padding:       '2px 7px',
              borderRadius:  4,
              fontWeight:    700,
              letterSpacing: '0.05em',
              flexShrink:    0,
            }}>
              {p.active ? 'ACTIVE' : 'INACTIVE'}
            </span>
          </div>
        ))
      )}
      <p style={{ ...settingsTextStyle, marginTop: 16, fontSize: 10 }}>
        Managed by the Aiden runtime. Workbench shows the exact loaded inventory and does not mutate it.
      </p>
    </div>
  )
}

// ── UpdatesTab ────────────────────────────────────────────────

type UpdateState = 'idle' | 'checking' | 'uptodate' | 'available' | 'downloading' | 'ready' | 'error'

function UpdatesTab() {
  const { runtimeVersion } = useDevOS()
  const [updateState,   setUpdateState]   = useState<UpdateState>('idle')
  const [latestVersion, setLatestVersion] = useState('')
  const [releaseNotes,  setReleaseNotes]  = useState('')
  const [releaseDate,   setReleaseDate]   = useState('')
  const [progress,      setProgress]      = useState(0)
  const [speed,         setSpeed]         = useState(0)
  const [transferred,   setTransferred]   = useState(0)
  const [total,         setTotal]         = useState(0)
  const [errorMsg,      setErrorMsg]      = useState('')
  const [checkedAt,     setCheckedAt]     = useState('')
  const isElectron = typeof window !== 'undefined' && !!(window as any).aidenUpdater

  // ── Wire up Electron IPC listeners ─────────────────────────
  useEffect(() => {
    const u = (window as any).aidenUpdater
    if (!u) return

    u.onUpdateAvailable((data: any) => {
      setUpdateState('available')
      setLatestVersion(data.version || '')
      setReleaseNotes(typeof data.releaseNotes === 'string' ? data.releaseNotes : '')
      setReleaseDate(data.releaseDate ? new Date(data.releaseDate).toLocaleDateString() : '')
    })
    u.onUpdateNotAvailable(() => {
      setUpdateState('uptodate')
      setCheckedAt(new Date().toLocaleTimeString())
    })
    u.onUpdateProgress((data: any) => {
      setUpdateState('downloading')
      setProgress(data.percent ?? 0)
      setSpeed(data.speed ?? 0)
      setTransferred(data.transferred ?? 0)
      setTotal(data.total ?? 0)
    })
    u.onUpdateDownloaded((data: any) => {
      setUpdateState('ready')
      setLatestVersion(data.version || latestVersion)
    })
    u.onUpdateError((data: any) => {
      setUpdateState('error')
      setErrorMsg(data.message || 'Unknown error')
    })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Fallback API check (browser / dev mode) ─────────────────
  const apiFallbackCheck = async () => {
    setUpdateState('checking')
    try {
      const res  = await fetch('http://localhost:4200/api/update/check')
      const data = await res.json() as any
      if (data.available && data.latestVersion) {
        setUpdateState('available')
        setLatestVersion(data.latestVersion)
        setReleaseNotes(data.releaseNotes || '')
        setReleaseDate(data.publishedAt ? new Date(data.publishedAt).toLocaleDateString() : '')
      } else {
        setUpdateState('uptodate')
        setCheckedAt(new Date().toLocaleTimeString())
      }
    } catch (e: any) {
      setUpdateState('error')
      setErrorMsg(e?.message || 'Check failed')
    }
  }

  const handleCheck = () => {
    setUpdateState('checking')
    if (isElectron) {
      ;(window as any).aidenUpdater.checkUpdate()
    } else {
      apiFallbackCheck()
    }
  }

  const handleDownload = () => {
    if (isElectron) {
      ;(window as any).aidenUpdater.downloadUpdate()
      setUpdateState('downloading')
    } else {
      // Browser fallback — open GitHub release
      window.open('https://github.com/taracodlabs/aiden-releases/releases/latest', '_blank')
    }
  }

  const handleInstall = () => {
    if (isElectron) {
      ;(window as any).aidenUpdater.installUpdate()
    }
  }

  // ── Helpers ─────────────────────────────────────────────────
  const fmtBytes = (b: number) => b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`
  const fmtSpeed = (b: number) => b > 1e6 ? `${(b / 1e6).toFixed(1)} MB/s` : `${Math.round(b / 1024)} KB/s`

  const mono12 = { fontFamily: 'var(--mono)', fontSize: 12 } as const
  const mono10 = { fontFamily: 'var(--mono)', fontSize: 10 } as const

  return (
    <div>
      <SettingsSection title="Software Updates">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

          {/* Current version pill */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '10px 14px', background: 'var(--bg2)',
            borderRadius: 8, border: '1px solid var(--border)',
          }}>
            <span style={{ fontSize: 18 }}>🤖</span>
            <div>
              <div style={{ ...mono12, color: 'var(--text)', fontWeight: 600 }}>Aiden v{runtimeVersion}</div>
              <div style={{ ...mono10, color: 'var(--muted)', marginTop: 2 }}>
                Installed · Local AI OS{!isElectron ? ' · browser mode' : ''}
              </div>
            </div>
          </div>

          {/* ── IDLE / UP-TO-DATE ── */}
          {(updateState === 'idle' || updateState === 'uptodate') && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {updateState === 'uptodate' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, ...mono12, color: '#4ade80' }}>
                  ✓ Aiden v{runtimeVersion} — You&apos;re on the latest version
                  {checkedAt && <span style={{ ...mono10, color: 'var(--muted)' }}>· checked {checkedAt}</span>}
                </div>
              )}
              <button onClick={handleCheck} style={{
                padding: '8px 18px', borderRadius: 6, cursor: 'pointer',
                background: 'var(--orange)', border: 'none', color: '#000',
                ...mono12, fontWeight: 600, alignSelf: 'flex-start',
              }}>
                {updateState === 'uptodate' ? 'Check Again' : 'Check for Updates'}
              </button>
            </div>
          )}

          {/* ── CHECKING ── */}
          {updateState === 'checking' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, ...mono12, color: 'var(--muted)' }}>
              <span style={{ animation: 'spin 1s linear infinite', display: 'inline-block' }}>⟳</span>
              Checking for updates…
            </div>
          )}

          {/* ── UPDATE AVAILABLE ── */}
          {updateState === 'available' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '10px 14px', background: 'rgba(251,146,60,0.08)',
                borderRadius: 8, border: '1px solid rgba(251,146,60,0.3)',
              }}>
                <span style={{ fontSize: 18 }}>⬆</span>
                <div style={{ flex: 1 }}>
                  <div style={{ ...mono12, color: 'var(--orange)', fontWeight: 600 }}>
                    Aiden v{latestVersion} is available!
                  </div>
                  <div style={{ ...mono10, color: 'var(--muted)', marginTop: 2 }}>
                    Current: v{runtimeVersion}{releaseDate ? ` · Released ${releaseDate}` : ''}
                  </div>
                </div>
                <button onClick={handleDownload} style={{
                  padding: '7px 18px', borderRadius: 6, cursor: 'pointer',
                  background: 'var(--orange)', border: 'none', color: '#000',
                  ...mono12, fontWeight: 700, flexShrink: 0,
                }}>
                  Download Update
                </button>
              </div>
              {releaseNotes && (
                <div style={{
                  padding: '10px 14px', background: 'var(--bg2)',
                  borderRadius: 8, border: '1px solid var(--border)',
                  ...mono10, color: 'var(--muted2)',
                  whiteSpace: 'pre-wrap', lineHeight: 1.6, maxHeight: 200, overflowY: 'auto',
                }}>
                  <div style={{ color: 'var(--muted)', marginBottom: 6 }}>Release notes:</div>
                  {releaseNotes}
                </div>
              )}
            </div>
          )}

          {/* ── DOWNLOADING ── */}
          {updateState === 'downloading' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ ...mono12, color: 'var(--text)' }}>
                Downloading v{latestVersion || 'update'}…
              </div>
              {/* Progress bar */}
              <div style={{
                width: '100%', height: 8, background: 'var(--bg3)',
                borderRadius: 4, overflow: 'hidden',
              }}>
                <div style={{
                  height: '100%', width: `${progress}%`,
                  background: 'var(--orange)',
                  borderRadius: 4,
                  transition: 'width 0.3s ease',
                }} />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, ...mono10, color: 'var(--muted)' }}>
                <span style={{ fontWeight: 600, color: 'var(--text)' }}>{progress}%</span>
                {total > 0 && <span>{fmtBytes(transferred)} / {fmtBytes(total)}</span>}
                {speed > 0 && <span>{fmtSpeed(speed)}</span>}
              </div>
            </div>
          )}

          {/* ── READY TO INSTALL ── */}
          {updateState === 'ready' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{
                padding: '10px 14px', background: 'rgba(74,222,128,0.08)',
                borderRadius: 8, border: '1px solid rgba(74,222,128,0.25)',
                ...mono12, color: '#4ade80',
              }}>
                ✓ v{latestVersion} downloaded and ready!
                <div style={{ ...mono10, color: 'var(--muted)', marginTop: 4 }}>
                  Aiden will restart automatically to apply the update.
                </div>
              </div>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <button onClick={handleInstall} style={{
                  padding: '8px 20px', borderRadius: 6, cursor: 'pointer',
                  background: '#4ade80', border: 'none', color: '#000',
                  ...mono12, fontWeight: 700,
                }}>
                  Install &amp; Restart
                </button>
                <span style={{ ...mono10, color: 'var(--muted)', cursor: 'pointer' }}
                  onClick={() => setUpdateState('idle')}>
                  Later
                </span>
              </div>
            </div>
          )}

          {/* ── ERROR ── */}
          {updateState === 'error' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ ...mono12, color: '#ef4444' }}>
                Update check failed. {errorMsg && <span style={{ ...mono10, color: 'var(--muted)' }}>{errorMsg}</span>}
              </div>
              <button onClick={handleCheck} style={{
                padding: '7px 16px', borderRadius: 6, cursor: 'pointer',
                background: 'var(--bg3)', border: '1px solid var(--border)', color: 'var(--text)',
                ...mono12, alignSelf: 'flex-start',
              }}>
                Retry
              </button>
            </div>
          )}

        </div>
      </SettingsSection>
    </div>
  )
}

// ── UsageDashboard ────────────────────────────────────────────

interface UsageData {
  today:      { cost: number; userCost: number; systemCost: number; byProvider: Record<string, number>; currency: string; budget: number }
  dailyHistory: Array<{ date: string; totalUSD: number; systemUSD: number; userUSD: number; totalTokens: number; calls: number }>
  toolStats:    Array<{ tool: string; calls: number; totalDuration: number; failures: number }>
  providerStats: Array<{ provider: string; calls: number; totalCost: number; inputTokens: number; outputTokens: number }>
  totalExecutions: number
}

function UsageDashboard() {
  const [usage, setUsage]   = useState<UsageData | null>(null)
  const [error, setError]   = useState(false)

  useEffect(() => {
    fetch('http://localhost:4200/api/usage')
      .then(r => r.ok ? r.json() : Promise.reject())
      .then((d: UsageData) => setUsage(d))
      .catch(() => setError(true))
  }, [])

  const card = (label: string, value: string, sub?: string) => (
    <div style={{
      background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8,
      padding: '14px 16px', flex: '1 1 120px', minWidth: 100,
    }}>
      <div style={{ fontSize: 11, color: 'var(--muted2)', fontFamily: 'var(--mono)', marginBottom: 6, textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--orange)', fontFamily: 'var(--mono)' }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>{sub}</div>}
    </div>
  )

  const th: CSSProperties = { textAlign: 'left', color: 'var(--muted2)', padding: '7px 10px', fontSize: 11, fontFamily: 'var(--mono)', borderBottom: '1px solid var(--border)', fontWeight: 600 }
  const td: CSSProperties = { padding: '5px 10px', fontSize: 12, fontFamily: 'var(--mono)', color: 'var(--text)', borderBottom: '1px solid var(--bg2)' }

  if (error) return <p style={settingsTextStyle}>Could not load usage data.</p>
  if (!usage) return <p style={settingsTextStyle}>Loading...</p>

  const budgetPct = usage.today.budget > 0 ? Math.min(100, (usage.today.userCost / usage.today.budget) * 100) : 0
  const totalTokens7d = usage.dailyHistory.reduce((s, d) => s + d.totalTokens, 0)
  const totalCalls7d  = usage.dailyHistory.reduce((s, d) => s + d.calls, 0)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

      {/* ── Top stat cards ── */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
        {card('Today (user)', `$${usage.today.userCost.toFixed(4)}`, `of $${usage.today.budget.toFixed(2)} budget`)}
        {card('Total Tasks', String(usage.totalExecutions), 'all time')}
        {card('Tokens (7d)', totalTokens7d > 1_000_000 ? `${(totalTokens7d / 1_000_000).toFixed(1)}M` : `${(totalTokens7d / 1000).toFixed(0)}K`, `${totalCalls7d} calls`)}
        {card('Today (system)', `$${usage.today.systemCost.toFixed(4)}`, 'background ops')}
      </div>

      {/* ── Budget bar ── */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
          <span style={{ fontSize: 11, color: 'var(--muted2)', fontFamily: 'var(--mono)' }}>DAILY BUDGET</span>
          <span style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>${usage.today.userCost.toFixed(4)} / ${usage.today.budget.toFixed(2)}</span>
        </div>
        <div style={{ height: 6, background: 'var(--bg2)', borderRadius: 3, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${budgetPct}%`, background: budgetPct > 80 ? '#ef4444' : 'var(--orange)', borderRadius: 3, transition: 'width 0.3s' }} />
        </div>
      </div>

      {/* ── 7-day history ── */}
      {usage.dailyHistory.length > 0 && (
        <div>
          <div style={{ fontSize: 11, color: 'var(--muted2)', fontFamily: 'var(--mono)', marginBottom: 8, textTransform: 'uppercase' }}>7-Day History</div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>
              <th style={th}>Date</th>
              <th style={{ ...th, textAlign: 'right' }}>Cost</th>
              <th style={{ ...th, textAlign: 'right' }}>Tokens</th>
              <th style={{ ...th, textAlign: 'right' }}>Calls</th>
            </tr></thead>
            <tbody>
              {[...usage.dailyHistory].reverse().map(d => (
                <tr key={d.date}>
                  <td style={td}>{d.date}</td>
                  <td style={{ ...td, textAlign: 'right', color: d.totalUSD > 0 ? 'var(--orange)' : 'var(--muted)' }}>${d.totalUSD.toFixed(4)}</td>
                  <td style={{ ...td, textAlign: 'right' }}>{d.totalTokens > 1000 ? `${(d.totalTokens / 1000).toFixed(0)}K` : d.totalTokens}</td>
                  <td style={{ ...td, textAlign: 'right' }}>{d.calls}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Provider stats ── */}
      {usage.providerStats.length > 0 && (
        <div>
          <div style={{ fontSize: 11, color: 'var(--muted2)', fontFamily: 'var(--mono)', marginBottom: 8, textTransform: 'uppercase' }}>By Provider (7d)</div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>
              <th style={th}>Provider</th>
              <th style={{ ...th, textAlign: 'right' }}>Calls</th>
              <th style={{ ...th, textAlign: 'right' }}>Tokens In</th>
              <th style={{ ...th, textAlign: 'right' }}>Tokens Out</th>
              <th style={{ ...th, textAlign: 'right' }}>Cost</th>
            </tr></thead>
            <tbody>
              {usage.providerStats.map(p => (
                <tr key={p.provider}>
                  <td style={td}>{p.provider}</td>
                  <td style={{ ...td, textAlign: 'right' }}>{p.calls}</td>
                  <td style={{ ...td, textAlign: 'right' }}>{p.inputTokens > 1000 ? `${(p.inputTokens / 1000).toFixed(0)}K` : p.inputTokens}</td>
                  <td style={{ ...td, textAlign: 'right' }}>{p.outputTokens > 1000 ? `${(p.outputTokens / 1000).toFixed(0)}K` : p.outputTokens}</td>
                  <td style={{ ...td, textAlign: 'right', color: p.totalCost > 0 ? 'var(--orange)' : 'var(--muted)' }}>${p.totalCost.toFixed(4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Tool stats ── */}
      {usage.toolStats.length > 0 && (
        <div>
          <div style={{ fontSize: 11, color: 'var(--muted2)', fontFamily: 'var(--mono)', marginBottom: 8, textTransform: 'uppercase' }}>Tool Usage</div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>
              <th style={th}>Tool</th>
              <th style={{ ...th, textAlign: 'right' }}>Calls</th>
              <th style={{ ...th, textAlign: 'right' }}>Avg ms</th>
              <th style={{ ...th, textAlign: 'right' }}>Failures</th>
            </tr></thead>
            <tbody>
              {usage.toolStats.slice(0, 15).map(t => (
                <tr key={t.tool}>
                  <td style={td}>{t.tool}</td>
                  <td style={{ ...td, textAlign: 'right' }}>{t.calls}</td>
                  <td style={{ ...td, textAlign: 'right' }}>{t.calls > 0 ? Math.round(t.totalDuration / t.calls) : 0}</td>
                  <td style={{ ...td, textAlign: 'right', color: t.failures > 0 ? '#ef4444' : 'var(--muted)' }}>{t.failures}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {usage.toolStats.length === 0 && usage.providerStats.length === 0 && (
        <p style={settingsTextStyle}>No usage data yet — start chatting with Aiden to see stats here.</p>
      )}
    </div>
  )
}

// ── TelegramSettingsTab ───────────────────────────────────────

function TelegramSettingsTab() {
  const [enabled,        setEnabled]        = useState(false)
  const [botToken,       setBotToken]       = useState('')
  const [allowedChatIds, setAllowedChatIds] = useState('')
  const [saving,         setSaving]         = useState(false)
  const [saved,          setSaved]          = useState(false)
  const [loaded,         setLoaded]         = useState(false)

  useEffect(() => {
    fetch('http://localhost:4200/api/telegram/config')
      .then(r => r.ok ? r.json() : null)
      .then((data: any) => {
        if (!data) return
        setEnabled(!!data.enabled)
        setBotToken(data.botToken || '')
        setAllowedChatIds(Array.isArray(data.allowedChatIds) ? data.allowedChatIds.join(', ') : '')
        setLoaded(true)
      })
      .catch(() => setLoaded(true))
  }, [])

  const save = async () => {
    setSaving(true)
    try {
      await fetch('http://localhost:4200/api/telegram/config', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          enabled,
          botToken,
          allowedChatIds: allowedChatIds.split(',').map((s: string) => s.trim()).filter(Boolean),
          pollingInterval: 1000,
        }),
      })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch {}
    setSaving(false)
  }

  if (!loaded) return <p style={settingsTextStyle}>Loading...</p>

  return (
    <div>
      <SettingsSection title="Telegram Bot">
        <p style={{ ...settingsTextStyle, marginBottom: 14 }}>
          Connect Aiden to Telegram so you can chat from your phone.
          Create a bot via <b>@BotFather</b>, copy the token, and paste it below.
        </p>

        {/* Enable toggle */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
          <button
            onClick={() => setEnabled(v => !v)}
            style={{
              width: 40, height: 22, borderRadius: 11,
              background: enabled ? 'var(--orange)' : 'var(--bg3)',
              border: 'none', cursor: 'pointer', position: 'relative',
              transition: 'background 0.2s', flexShrink: 0,
            }}
          >
            <span style={{
              position: 'absolute', top: 3,
              left: enabled ? 21 : 3,
              width: 16, height: 16, borderRadius: '50%',
              background: '#fff', transition: 'left 0.2s',
            }} />
          </button>
          <span style={{ fontSize: 13, color: 'var(--text)', fontFamily: 'var(--mono)' }}>
            {enabled ? 'Enabled' : 'Disabled'}
          </span>
        </div>

        {/* Bot token */}
        <div style={{ marginBottom: 12 }}>
          <label style={{ display: 'block', fontSize: 11, color: 'var(--muted2)', fontFamily: 'var(--mono)', marginBottom: 4 }}>
            Bot Token (from @BotFather)
          </label>
          <input
            type="password"
            value={botToken}
            onChange={e => setBotToken(e.target.value)}
            placeholder="123456:ABC-DEF..."
            style={{
              width: '100%', padding: '7px 10px', borderRadius: 5,
              background: 'var(--bg2)', border: '1px solid var(--border)',
              color: 'var(--text)', fontFamily: 'var(--mono)', fontSize: 12,
              boxSizing: 'border-box',
            }}
          />
        </div>

        {/* Allowed Chat IDs */}
        <div style={{ marginBottom: 16 }}>
          <label style={{ display: 'block', fontSize: 11, color: 'var(--muted2)', fontFamily: 'var(--mono)', marginBottom: 4 }}>
            Allowed Chat IDs <span style={{ opacity: 0.6 }}>(comma-separated, leave empty to allow all)</span>
          </label>
          <input
            type="text"
            value={allowedChatIds}
            onChange={e => setAllowedChatIds(e.target.value)}
            placeholder="123456789, 987654321"
            style={{
              width: '100%', padding: '7px 10px', borderRadius: 5,
              background: 'var(--bg2)', border: '1px solid var(--border)',
              color: 'var(--text)', fontFamily: 'var(--mono)', fontSize: 12,
              boxSizing: 'border-box',
            }}
          />
          <p style={{ ...settingsTextStyle, marginTop: 6, fontSize: 11 }}>
            Send <code style={{ background: 'var(--bg3)', padding: '1px 4px', borderRadius: 3 }}>/start</code> to your bot to get your chat ID.
          </p>
        </div>

        <button
          onClick={save}
          disabled={saving}
          style={{
            padding: '7px 18px', borderRadius: 5, border: 'none',
            background: saved ? '#22c55e' : 'var(--orange)',
            color: '#fff', fontFamily: 'var(--mono)', fontSize: 12,
            cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.7 : 1,
          }}
        >
          {saved ? '✓ Saved' : saving ? 'Saving...' : 'Save Telegram Settings'}
        </button>
      </SettingsSection>

      <SettingsSection title="Google Calendar">
        <p style={{ ...settingsTextStyle, marginBottom: 10 }}>
          Go to <b>Google Calendar → Settings → your calendar → "Secret address in iCal format"</b>. Paste the URL below.
        </p>
        <CalendarGmailSettings />
      </SettingsSection>

      <SettingsSection title="Other Channels">
        {['WhatsApp', 'Discord', 'Slack'].map(ch => (
          <p key={ch} style={{ ...settingsTextStyle, marginBottom: 8 }}>
            <b>{ch}</b> — configure in your .env or DevOS config.
          </p>
        ))}
      </SettingsSection>

      <SettingsSection title="Gateway Status">
        <GatewayStatus />
      </SettingsSection>
    </div>
  )
}

// ── GatewayStatus — live channel connection list ──────────────

function GatewayStatus() {
  const [channels, setChannels] = useState<Array<{ channel: string; active: boolean }>>([])

  useEffect(() => {
    fetch('/api/gateway/status')
      .then(r => r.json())
      .then(setChannels)
      .catch(() => {})
  }, [])

  return (
    <div className="gateway-channel-list">
      {channels.map(ch => (
        <div key={ch.channel} className="channel-status">
          <span className={`status-dot ${ch.active ? 'active' : 'inactive'}`} />
          <span className="channel-name">{ch.channel}</span>
          <span className="channel-state">
            {ch.active ? 'Connected' : 'Not configured'}
          </span>
        </div>
      ))}
    </div>
  )
}

// ── CalendarGmailSettings — inline form inside Channels tab ───

function CalendarGmailSettings() {
  const [icalUrl,       setIcalUrl]       = useState('')
  const [gmailEmail,    setGmailEmail]    = useState('')
  const [gmailPassword, setGmailPassword] = useState('')
  const [saving,        setSaving]        = useState(false)
  const [saved,         setSaved]         = useState(false)

  useEffect(() => {
    fetch('http://localhost:4200/api/calendar-gmail/config')
      .then(r => r.ok ? r.json() : null)
      .then((data: any) => {
        if (!data) return
        setIcalUrl(data.icalUrl || '')
        setGmailEmail(data.gmailEmail || '')
        setGmailPassword(data.gmailPassword || '')
      })
      .catch(() => {})
  }, [])

  const save = async () => {
    setSaving(true)
    try {
      await fetch('http://localhost:4200/api/calendar-gmail/config', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ icalUrl, gmailEmail, gmailPassword }),
      })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch {}
    setSaving(false)
  }

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '8px 10px', borderRadius: 6,
    background: 'var(--bg)', border: '1px solid var(--border)',
    color: 'var(--text)', fontFamily: 'var(--mono)', fontSize: 12,
    marginBottom: 8, boxSizing: 'border-box',
  }

  return (
    <div>
      {/* Calendar iCal URL */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 11, color: 'var(--muted2)', fontFamily: 'var(--mono)', marginBottom: 5 }}>
          iCal URL
        </div>
        <input
          type="text"
          placeholder="https://calendar.google.com/calendar/ical/…"
          value={icalUrl}
          onChange={e => setIcalUrl(e.target.value)}
          style={inputStyle}
        />
      </div>

      {/* Gmail */}
      <div style={{ borderTop: '1px solid var(--border)', paddingTop: 14, marginBottom: 16 }}>
        <div style={{ fontSize: 12, color: 'var(--text)', fontFamily: 'var(--mono)', marginBottom: 6, fontWeight: 600 }}>
          Gmail (App Password)
        </div>
        <p style={{ ...settingsTextStyle, marginBottom: 8 }}>
          Go to <b>Google Account → Security → App Passwords → Generate for "DevOS"</b>. Paste the 16-character password below.
        </p>
        <input
          type="email"
          placeholder="you@gmail.com"
          value={gmailEmail}
          onChange={e => setGmailEmail(e.target.value)}
          style={inputStyle}
        />
        <input
          type="password"
          placeholder="App Password (16 chars)"
          value={gmailPassword}
          onChange={e => setGmailPassword(e.target.value)}
          style={inputStyle}
        />
      </div>

      <button
        onClick={save}
        disabled={saving}
        style={{
          padding: '8px 18px', borderRadius: 6, border: 'none',
          background: saved ? 'var(--green)' : 'var(--orange)',
          color: '#fff', fontFamily: 'var(--mono)', fontSize: 12,
          cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.7 : 1,
        }}
      >
        {saved ? '✓ Saved' : saving ? 'Saving…' : 'Save'}
      </button>
    </div>
  )
}

// ── DebugPanel ────────────────────────────────────────────────

function DebugPanel() {
  const [logs,    setLogs]    = useState<any[]>([])
  const [health,  setHealth]  = useState<any>(null)
  const [models,  setModels]  = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [filter,  setFilter]  = useState<'all'|'info'|'warn'|'error'|'debug'>('all')
  const logsEndRef = useRef<HTMLDivElement>(null)

  const reload = async () => {
    try {
      const [logsRes, healthRes, modelsRes] = await Promise.all([
        fetch('http://localhost:4200/api/debug/logs?n=200').then(r => r.json()).catch(() => ({ logs: [] })),
        fetch('http://localhost:4200/api/debug/health').then(r => r.json()).catch(() => null),
        fetch('http://localhost:4200/api/debug/models').then(r => r.json()).catch(() => null),
      ])
      setLogs(logsRes.logs || [])
      setHealth(healthRes)
      setModels(modelsRes)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { reload() }, [])

  useEffect(() => {
    const id = setInterval(reload, 3000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs])

  const clearLogs = async () => {
    await fetch('http://localhost:4200/api/debug/logs/clear', { method: 'POST' }).catch(() => {})
    setLogs([])
  }

  const filteredLogs = filter === 'all' ? logs : logs.filter((l: any) => l.level === filter)

  const levelColor: Record<string, string> = {
    info:  'var(--text)',
    warn:  '#f59e0b',
    error: 'var(--red)',
    debug: 'var(--muted2)',
  }

  const levelBg: Record<string, string> = {
    info:  'transparent',
    warn:  'rgba(245,158,11,0.06)',
    error: 'rgba(239,68,68,0.06)',
    debug: 'transparent',
  }

  return (
    <div>
      {/* Health row */}
      {health && (
        <div className="debug-health-grid">
          {[
            { label: 'Uptime',     value: `${Math.floor(health.uptime / 60)}m ${health.uptime % 60}s` },
            { label: 'Memory',     value: `${health.memoryMB} MB` },
            { label: 'Heap',       value: `${health.heapUsedMB}/${health.heapTotalMB} MB` },
            { label: 'Node',       value: health.nodeVersion },
            { label: 'Logs',       value: String(health.logBufferSize) },
            { label: 'Model',      value: health.activeModel },
          ].map(item => (
            <div key={item.label} className="debug-health-card">
              <div className="debug-health-label">{item.label}</div>
              <div className="debug-health-value">{item.value}</div>
            </div>
          ))}
        </div>
      )}

      {/* Providers */}
      {models && (
        <SettingsSection title="Providers">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {(models.providers || []).map((p: any) => (
              <div key={p.name} style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '6px 10px', background: 'var(--bg2)', borderRadius: 5,
              }}>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text)' }}>
                  {p.name}
                </span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: p.active ? 'var(--green)' : 'var(--muted)' }}>
                  {p.active ? `✓ ${p.model}` : '✗ not configured'}
                </span>
              </div>
            ))}
          </div>
        </SettingsSection>
      )}

      {/* Log viewer */}
      <SettingsSection title="Live Logs">
        {/* Toolbar */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {(['all','info','warn','error','debug'] as const).map(lvl => (
            <button key={lvl} onClick={() => setFilter(lvl)} style={{
              padding: '3px 9px', borderRadius: 4, border: 'none', cursor: 'pointer',
              fontFamily: 'var(--mono)', fontSize: 10,
              background: filter === lvl ? 'var(--orange)' : 'var(--bg2)',
              color:      filter === lvl ? '#fff' : 'var(--muted2)',
            }}>{lvl}</button>
          ))}
          <button onClick={() => reload()} style={{
            marginLeft: 'auto', padding: '3px 9px', borderRadius: 4, border: '1px solid var(--border)',
            background: 'transparent', color: 'var(--muted2)', fontFamily: 'var(--mono)',
            fontSize: 10, cursor: 'pointer',
          }}>↻ Refresh</button>
          <button onClick={clearLogs} style={{
            padding: '3px 9px', borderRadius: 4, border: '1px solid rgba(239,68,68,0.3)',
            background: 'transparent', color: 'var(--red)', fontFamily: 'var(--mono)',
            fontSize: 10, cursor: 'pointer',
          }}>Clear</button>
        </div>

        {/* Log list */}
        <div className="debug-log-container">
          {loading && <div style={{ color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 11 }}>Loading…</div>}
          {!loading && filteredLogs.length === 0 && (
            <div style={{ color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 11 }}>No log entries.</div>
          )}
          {filteredLogs.map((entry: any, i: number) => (
            <div key={i} className="debug-log-row" style={{ background: levelBg[entry.level] || 'transparent' }}>
              <span className="debug-log-time">{entry.timestamp?.slice(11, 19) || ''}</span>
              <span className="debug-log-level" style={{ color: levelColor[entry.level] || 'var(--text)' }}>
                {(entry.level || 'info').toUpperCase().padEnd(5)}
              </span>
              <span className="debug-log-source">[{entry.source || 'System'}]</span>
              <span className="debug-log-msg">{entry.message}</span>
            </div>
          ))}
          <div ref={logsEndRef} />
        </div>
      </SettingsSection>
    </div>
  )
}

// ── SecurityScan ─────────────────────────────────────────────

function SecurityScan() {
  const [result,  setResult]  = useState<any>(null)
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState<string | null>(null)

  const runScan = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('http://localhost:4200/api/security/scan')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setResult(await res.json())
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  const riskClass = (score: number) =>
    score >= 50 ? 'risk-high' : score >= 20 ? 'risk-medium' : 'risk-low'

  const severityColor: Record<string, string> = {
    critical: '#ef4444',
    high:     '#f97316',
    medium:   '#eab308',
    low:      '#3b82f6',
    info:     '#6b7280',
  }

  return (
    <SettingsSection title="AgentShield — Security Scanner">
      <p style={{ fontSize: 12, color: 'var(--muted3)', marginBottom: 14, lineHeight: 1.6 }}>
        Scans skill files, config, and identity documents for injection patterns, exposed secrets, and obfuscated payloads.
      </p>

      <button onClick={runScan} disabled={loading} style={{
        background: loading ? 'var(--bg3)' : 'var(--orange)',
        color: '#fff', border: 'none', borderRadius: 6,
        padding: '7px 16px', fontSize: 12, fontWeight: 600,
        cursor: loading ? 'not-allowed' : 'pointer', marginBottom: 16,
        fontFamily: 'var(--mono)',
      }}>
        {loading ? '⏳ Scanning…' : '🛡️ Run Scan'}
      </button>

      {error && (
        <div style={{ color: 'var(--red)', fontSize: 12, marginBottom: 12 }}>⚠️ {error}</div>
      )}

      {result && (
        <div className="security-scan">
          {/* Risk score */}
          <div className={`risk-score ${riskClass(result.riskScore)}`}>
            <span style={{ fontSize: 24, fontWeight: 700 }}>{result.riskScore}</span>
            <span style={{ fontSize: 11, opacity: 0.8 }}>/100 risk score</span>
            <span style={{ fontSize: 11, marginLeft: 'auto', opacity: 0.7 }}>
              {result.scanned.skills} skills · {result.scanned.configs} configs · {result.duration}ms
            </span>
          </div>

          {/* Findings */}
          {result.findings.length === 0 ? (
            <div style={{ color: 'var(--green)', fontSize: 13, padding: '10px 0' }}>✅ No issues found</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 12 }}>
              {result.findings.map((f: any, i: number) => (
                <div key={i} className={`finding finding-${f.severity}`}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <span className="finding-severity" style={{ background: severityColor[f.severity] }}>
                      {f.severity.toUpperCase()}
                    </span>
                    <span className="finding-file">{f.file}</span>
                  </div>
                  <div className="finding-desc">{f.description}</div>
                  <div className="finding-rec">→ {f.recommendation}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </SettingsSection>
  )
}

// ── IdeIntegration ───────────────────────────────────────────

function IdeIntegration() {
  const codeStyle: React.CSSProperties = {
    display: 'block', background: 'var(--bg)', border: '1px solid var(--border)',
    borderRadius: 6, padding: '10px 12px', fontFamily: 'var(--mono)', fontSize: 11,
    color: 'var(--text2)', whiteSpace: 'pre', overflowX: 'auto', marginBottom: 16,
  }
  const h4Style: React.CSSProperties = {
    fontSize: 12, fontWeight: 600, color: 'var(--text)', marginBottom: 6, marginTop: 14,
  }

  return (
    <SettingsSection title="IDE Integration — ACP">
      <p style={{ fontSize: 12, color: 'var(--muted3)', marginBottom: 14, lineHeight: 1.6 }}>
        Aiden exposes an OpenAI-compatible API at <code style={{ fontFamily: 'var(--mono)', color: 'var(--orange)' }}>http://localhost:4200/v1</code>.
        Point any OpenAI-compatible editor at that base URL and Aiden handles completions — with full memory and tools.
      </p>

      <h4 style={h4Style}>VS Code — Continue.dev</h4>
      <code style={codeStyle}>{`// ~/.continue/config.json
{
  "models": [{
    "title": "Aiden",
    "provider": "openai",
    "model": "aiden",
    "apiBase": "http://localhost:4200/v1",
    "apiKey": "not-needed"
  }]
}`}</code>

      <h4 style={h4Style}>Cursor</h4>
      <code style={codeStyle}>{`Settings → Models → OpenAI API Base
  http://localhost:4200/v1

API Key : any-value
Model   : aiden`}</code>

      <h4 style={h4Style}>JetBrains — AI Assistant / Grazie</h4>
      <code style={codeStyle}>{`Settings → Tools → AI Assistant → Custom OpenAI endpoint
  URL   : http://localhost:4200/v1/chat/completions
  Key   : not-needed
  Model : aiden`}</code>

      <h4 style={h4Style}>Any OpenAI client</h4>
      <code style={codeStyle}>{`from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:4200/v1",
    api_key="not-needed",
)
response = client.chat.completions.create(
    model="aiden",
    messages=[{"role": "user", "content": "Hello"}]
)`}</code>

      <div style={{
        marginTop: 16, padding: '10px 12px', borderRadius: 7,
        background: 'rgba(249,115,22,0.06)', border: '1px solid rgba(249,115,22,0.2)',
        fontSize: 12, color: 'var(--muted3)', lineHeight: 1.6,
      }}>
        <strong style={{ color: 'var(--orange)' }}>Available endpoints</strong><br />
        <code style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>GET&nbsp; /v1/models</code> — model list<br />
        <code style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>POST /v1/chat/completions</code> — streaming + non-streaming
      </div>
    </SettingsSection>
  )
}

// ── SettingsDrawer ────────────────────────────────────────────

function LearningSettingsTab() {
  const [snapshot, setSnapshot] = useState<aiden.WorkbenchLearningSnapshot | null>(null)
  const [review, setReview] = useState<aiden.WorkbenchLearningReview | null>(null)
  const [filter, setFilter] = useState<'all' | 'preferences' | 'corrections' | 'workspace' | 'skills'>('all')
  const [draft, setDraft] = useState('')
  const [subject, setSubject] = useState('user.preference')
  const [edit, setEdit] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const refresh = useCallback(async () => {
    setError(null)
    try { setSnapshot(await aiden.loadLearning()) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Learning is unavailable') }
  }, [])
  useEffect(() => { void refresh() }, [refresh])

  const idempotencyKey = () => typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `learning-${Date.now()}`
  const openReview = async (entryId: string) => {
    setBusy(true); setError(null)
    try { const value = await aiden.loadLearningReview(entryId); setReview(value); setEdit(value.entry.content ?? '') }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Learning review is unavailable') }
    finally { setBusy(false) }
  }
  const mutate = async (operation: () => Promise<unknown>, reopen?: string) => {
    setBusy(true); setError(null)
    try { await operation(); await refresh(); if (reopen) await openReview(reopen); else setReview(null) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Learning change failed') }
    finally { setBusy(false) }
  }
  const exportJson = async () => {
    setBusy(true); setError(null)
    try {
      const value = await aiden.exportLearning()
      const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }))
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'aiden-learning-export.json'; anchor.click()
      URL.revokeObjectURL(url)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Learning export failed') }
    finally { setBusy(false) }
  }
  const accepts = (entry: aiden.WorkbenchLearningEntry) => filter === 'all'
    || (filter === 'preferences' && entry.type === 'USER_PREFERENCE')
    || (filter === 'corrections' && entry.type === 'USER_CORRECTION')
    || (filter === 'workspace' && ['WORKSPACE_CONVENTION', 'VERIFIED_PROCEDURE_LESSON', 'TOOL_RELIABILITY_LESSON'].includes(entry.type))
    || (filter === 'skills' && entry.type === 'SKILL_RELIABILITY')
  const cards = (entries: aiden.WorkbenchLearningEntry[]) => entries.filter(accepts).map((entry) => (
    <article className="learning-card" key={entry.id}>
      <div><strong>{entry.content ?? '[learned content deleted]'}</strong><span>{entry.confidence} · {entry.scope.kind.replace(/_/g, ' ')}</span></div>
      <button type="button" disabled={busy} onClick={() => { void openReview(entry.id) }}>Review</button>
    </article>
  ))

  return (
    <SettingsSection title="What Aiden has learned">
      <p style={settingsTextStyle}>Evidence-linked context stays local and never grants permission, approval, budget, or execution authority.</p>
      {snapshot && !snapshot.enabled && <p className="learning-notice">New capture and use are unavailable. Inspect, export, archive, and delete remain available.</p>}
      {error && <p className="learning-error">{error}</p>}
      <div className="learning-actions">
        <button type="button" disabled={busy} onClick={() => { void refresh() }}>Refresh</button>
        <button type="button" disabled={busy} onClick={() => { void exportJson() }}>Export JSON</button>
      </div>
      <form className="learning-remember" onSubmit={(event) => {
        event.preventDefault()
        if (!draft.trim()) return
        void mutate(() => aiden.rememberLearning({
          content: draft.trim(), subjectKey: subject.trim() || 'user.preference', type: 'USER_PREFERENCE',
          scopeKind: 'REPOSITORY', idempotencyKey: idempotencyKey(),
        })).then(() => setDraft(''))
      }}>
        <label>Remember this<textarea value={draft} disabled={!snapshot?.enabled || busy} onChange={(event) => setDraft(event.target.value)} placeholder="A preference or repository convention you explicitly want Aiden to remember" /></label>
        <input value={subject} disabled={!snapshot?.enabled || busy} onChange={(event) => setSubject(event.target.value)} aria-label="Learning subject" />
        <button type="submit" disabled={!snapshot?.enabled || busy || !draft.trim()}>Remember this</button>
      </form>
      <div className="learning-filters" aria-label="Learning filters">
        {([['all', 'All'], ['preferences', 'Preferences'], ['corrections', 'Corrections'], ['workspace', 'Workspace lessons'], ['skills', 'Skill reliability']] as const).map(([id, label]) => (
          <button type="button" className={filter === id ? 'is-active' : ''} key={id} onClick={() => setFilter(id)}>{label}</button>
        ))}
      </div>
      {snapshot && <div className="learning-groups">
        {([['Trusted', snapshot.trusted], ['Needs review', snapshot.needsReview], ['Archived', snapshot.archived]] as const).map(([title, entries]) => (
          <section key={title}><h4>{title} <span>{entries.filter(accepts).length}</span></h4>{entries.filter(accepts).length ? cards(entries) : <p>No matching items.</p>}</section>
        ))}
        <section><h4>Conflicts <span>{snapshot.conflicts.length}</span></h4>
          {snapshot.conflicts.length ? snapshot.conflicts.map((conflict) => <button className="learning-conflict" type="button" key={conflict.id} onClick={() => { void openReview(conflict.leftEntryId) }}>Needs review · {conflict.reasonCode.replace(/_/g, ' ')}</button>) : <p>No unresolved conflicts.</p>}
        </section>
      </div>}
      {review && <div className="learning-review" role="dialog" aria-label="Learning review">
        <div className="learning-review-head"><h4>Review learned context</h4><button type="button" onClick={() => setReview(null)}>Close</button></div>
        <textarea value={edit} disabled={!snapshot?.enabled || busy || review.entry.lifecycle === 'DELETED'} onChange={(event) => setEdit(event.target.value)} />
        <p>Editing preserves history.</p>
        <dl>
          <dt>Status</dt><dd>{review.entry.confidence} · {review.entry.lifecycle}</dd>
          <dt>Scope</dt><dd>{review.entry.scope.kind} · {review.entry.scope.key}</dd>
          <dt>Expiry</dt><dd>{review.entry.expiresAt === null ? 'No expiry' : new Date(review.entry.expiresAt).toLocaleString()}</dd>
          <dt>Why Aiden remembers this</dt><dd>{review.sources.map((source) => `${source.kind} · ${source.verification} · ${new Date(source.occurredAt).toLocaleString()}`).join(', ') || 'No active source content'}</dd>
          <dt>Evidence</dt><dd>{review.sources.map((source) => source.evidenceId ?? source.identity).join(', ')}</dd>
          <dt>Source records</dt><dd>{review.sources.map((source) => [
            source.presenceId, source.automationId, source.skillName, source.recoveryId,
          ].filter(Boolean).join(' · ') || source.identity).join(', ')}</dd>
          <dt>History</dt><dd>{review.history.map((event) => `${event.type} v${event.entryVersion}`).join(' → ')}</dd>
        </dl>
        <div className="learning-actions">
          <button type="button" disabled={!snapshot?.enabled || busy || edit.trim() === review.entry.content} onClick={() => { void mutate(() => aiden.editLearning(review.entry.id, { expectedVersion: review.entry.version, content: edit, idempotencyKey: idempotencyKey() }), review.entry.id) }}>Save edit</button>
          <button type="button" disabled={busy || review.entry.lifecycle === 'DELETED'} onClick={() => { void mutate(() => aiden.demoteLearning(review.entry.id, review.entry.version), review.entry.id) }}>Stop using automatically</button>
          <button type="button" disabled={busy || review.entry.lifecycle === 'DELETED'} onClick={() => { void mutate(() => aiden.archiveLearning(review.entry.id, review.entry.version), review.entry.id) }}>Archive</button>
          <button type="button" disabled={busy || review.entry.lifecycle === 'DELETED'} onClick={() => {
            if (window.confirm('Delete learned content permanently? Source Job and Evidence records remain.')) void mutate(() => aiden.deleteLearning(review.entry.id, review.entry.version))
          }}>Delete learned content</button>
        </div>
        {review.versions.length > 1 && <div className="learning-versions"><h4>Prior versions</h4>{review.versions.filter((version) => version.contentDigest !== review.entry.contentDigest).map((version) => (
          <button type="button" key={version.id} disabled={!snapshot?.enabled || busy} onClick={() => { void mutate(() => aiden.rollbackLearning(review.entry.id, { expectedVersion: review.entry.version, versionId: version.id, idempotencyKey: idempotencyKey() }), review.entry.id) }}>Roll back · {new Date(version.createdAt).toLocaleString()}</button>
        ))}</div>}
      </div>}
    </SettingsSection>
  )
}

const SETTINGS_TABS = [
  { id: 'runtime',  label: '◆ Readiness', section: 'General' },
  { id: 'model',    label: '◈ AI & Models', section: 'General' },
  { id: 'conversation', label: '◇ Conversation', section: 'General' },
  { id: 'appearance', label: '◐ Appearance', section: 'General' },
  { id: 'skills',   label: '◇ Skills', section: 'Advanced' },
  { id: 'capabilities', label: '◇ Capabilities', section: 'Advanced' },
  { id: 'plugins',  label: '◇ Plugins', section: 'Advanced' },
  { id: 'sponsor',  label: '♥ Sponsor', section: 'About' },
  { id: 'guide',    label: '📖 User Guide', section: 'About' },
  { id: 'privacy',  label: '📜 Privacy', section: 'About' },
  { id: 'legal',    label: '⚖️ Legal', section: 'About' },
  { id: 'about',    label: 'ℹ️ About', section: 'About' },
]

function CapabilitiesSettings() {
  const [snapshot, setSnapshot] = useState<aiden.CapabilityExtensionsSnapshot | null>(null)
  const [sourcePath, setSourcePath] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const refresh = useCallback(async () => {
    const value = await aiden.loadWorkbenchCapabilities()
    setSnapshot(value.extensions ?? null)
  }, [])
  useEffect(() => { void refresh().catch((cause) => setError(cause instanceof Error ? cause.message : 'Capabilities unavailable')) }, [refresh])
  const act = async (label: string, operation: () => Promise<aiden.CapabilityExtensionsSnapshot>) => {
    setBusy(label); setError(null)
    try { setSnapshot(await operation()) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Capability operation failed') }
    finally { setBusy(null) }
  }
  if (!snapshot) return <p style={settingsTextStyle}>{error || 'Loading capability registry…'}</p>
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <p style={settingsTextStyle}>
        Execution: <strong style={{ color: snapshot.executionEnabled && snapshot.sandbox.available ? 'var(--green)' : 'var(--orange)' }}>
          {snapshot.executionEnabled ? (snapshot.sandbox.available ? 'Docker boundary ready' : 'Docker boundary unavailable') : 'Entitlement unavailable'}
        </strong>
      </p>
      <p style={settingsTextStyle}>{snapshot.sandbox.image}{snapshot.sandbox.reason ? ` · ${snapshot.sandbox.reason}` : ''}</p>
      <form onSubmit={(event) => {
        event.preventDefault()
        const value = sourcePath.trim()
        if (!value) return
        void act('install', () => aiden.installCapability(value)).then(() => setSourcePath(''))
      }} style={{ display: 'flex', gap: 6 }}>
        <input value={sourcePath} onChange={(event) => setSourcePath(event.target.value)} placeholder="Local capability folder" style={{ flex: 1, minWidth: 0, padding: 8, background: 'var(--bg2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6 }} />
        <button type="submit" className="nav-btn" disabled={busy !== null || !sourcePath.trim()}>Install</button>
      </form>
      {snapshot.items.length === 0 && <p style={settingsTextStyle}>No capabilities installed.</p>}
      {snapshot.items.map((item) => {
        const latest = item.versions[item.versions.length - 1]
        const pendingPermissions = item.permissionChanges.added
        return (
          <div key={item.capabilityId} style={{ padding: 12, border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg2)', minWidth: 0 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'start' }}>
              <div style={{ minWidth: 0 }}>
                <strong style={{ color: 'var(--text)', overflowWrap: 'anywhere' }}>{item.displayName}</strong>
                <div style={{ ...settingsTextStyle, overflowWrap: 'anywhere' }}>{item.capabilityId}</div>
              </div>
              <span style={{ color: item.health?.state === 'healthy' ? 'var(--green)' : 'var(--orange)', fontFamily: 'var(--mono)', fontSize: 10 }}>{item.health?.state ?? 'unknown'}</span>
            </div>
            <p style={settingsTextStyle}>Active: {item.active ? `${item.active.version} · ${item.active.enabled ? 'enabled' : 'disabled'}` : 'none'}</p>
            <p style={{ ...settingsTextStyle, overflowWrap: 'anywhere' }}>Digest: {item.active?.digest ?? latest?.digest ?? '—'}</p>
            <p style={settingsTextStyle}>Requested: {item.requestedPermissions.map((permission) => permission.kind).join(', ') || 'none'}</p>
            <p style={settingsTextStyle}>Granted: {item.grantedPermissions.map((permission) => permission.permission).join(', ') || 'none'}</p>
            {pendingPermissions.length > 0 && <p style={{ ...settingsTextStyle, color: 'var(--orange)' }}>New permission review: {pendingPermissions.map((permission) => permission.kind).join(', ')}</p>}
            <p style={settingsTextStyle}>Recent: {item.recentInvocations[0]?.state ?? 'no invocations'}</p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {latest && (!item.active?.enabled || item.active.version !== latest.version) && <button type="button" className="nav-btn" disabled={busy !== null} onClick={() => {
                const permissions = item.requestedPermissions.map((permission) => `${permission.kind} ${JSON.stringify(permission.scope)}`).join('\n') || 'No permissions'
                if (window.confirm(`Activate ${item.displayName} ${latest.version}?\n\n${permissions}`)) void act('activate', () => aiden.activateCapability(item.capabilityId, latest.version))
              }}>Review and activate {latest.version}</button>}
              {item.active?.enabled && <button type="button" className="nav-btn" disabled={busy !== null} onClick={() => { void act('test', () => aiden.testCapability(item.capabilityId)) }}>Test health</button>}
              {item.active?.enabled && item.rollbackTarget && <button type="button" className="nav-btn" disabled={busy !== null} onClick={() => { void act('rollback', () => aiden.rollbackCapability(item.capabilityId)) }}>Rollback to {item.rollbackTarget.version}</button>}
              {item.active?.enabled && <button type="button" className="nav-btn" disabled={busy !== null} onClick={() => { void act('disable', () => aiden.disableCapability(item.capabilityId)) }}>Disable</button>}
              {latest && !item.active?.enabled && <button type="button" className="nav-btn" disabled={busy !== null} onClick={() => {
                if (window.confirm(`Uninstall ${item.displayName} ${latest.version}?`)) void act('uninstall', () => aiden.uninstallCapability(item.capabilityId, latest.version))
              }}>Uninstall {latest.version}</button>}
            </div>
          </div>
        )
      })}
      <button type="button" className="nav-btn" disabled={busy !== null} onClick={() => { void refresh() }}>Refresh</button>
      {error && <p role="alert" style={{ ...settingsTextStyle, color: 'var(--red)' }}>{error}</p>}
    </div>
  )
}

function ReadinessSettings({ sessionId, onOpenModels, onOpenApps }: {
  sessionId: string
  onOpenModels: () => void
  onOpenApps: () => void
}) {
  const [snapshot, setSnapshot] = useState<aiden.SystemReadinessProjection | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const refresh = useCallback(async () => {
    setError(null)
    try { setSnapshot(await aiden.loadSystemReadiness(sessionId)) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Readiness is unavailable') }
  }, [sessionId])
  useEffect(() => { void refresh() }, [refresh])
  const grantBrowser = async () => {
    setBusy(true); setError(null)
    try { await aiden.grantBrowserPermission(); await refresh() }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Browser permission could not be granted') }
    finally { setBusy(false) }
  }
  if (error) return <p style={{ ...settingsTextStyle, color: 'var(--red)' }}>{error}</p>
  if (!snapshot) return <p style={settingsTextStyle}>Checking system readiness…</p>
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <p style={settingsTextStyle}>Overall: <strong style={{ color: snapshot.overall === 'ready' ? 'var(--green)' : 'var(--orange)' }}>{snapshot.overall.replace(/_/g, ' ')}</strong></p>
      {snapshot.items.map((item) => (
        <div key={item.id} style={{ padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg2)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
            <strong style={{ color: 'var(--text)', fontSize: 12 }}>{item.title}</strong>
            <span style={{ color: item.healthy ? 'var(--green)' : item.severity === 'error' ? 'var(--red)' : 'var(--orange)', fontSize: 11, fontFamily: 'var(--mono)' }}>{item.state.replace(/_/g, ' ')}</span>
          </div>
          <p style={{ ...settingsTextStyle, margin: '6px 0 0' }}>{item.detail}</p>
          {item.availableActions.includes('manage_provider') && <button type="button" className="nav-btn" onClick={onOpenModels}>Manage AI & Models</button>}
          {item.availableActions.includes('manage_apps') && <button type="button" className="nav-btn" onClick={onOpenApps}>Manage Apps</button>}
          {item.availableActions.includes('review_browser_permission') && <button type="button" className="nav-btn" disabled={busy} onClick={() => { void grantBrowser() }}>{busy ? 'Granting…' : 'Review and grant browser permission'}</button>}
        </div>
      ))}
      <button type="button" className="nav-btn" disabled={busy} onClick={() => { void refresh() }}>Refresh readiness</button>
    </div>
  )
}

function AIModelsSettings({ sessionId }: { sessionId: string }) {
  const [snapshot, setSnapshot] = useState<aiden.WorkbenchProviderSnapshot | null>(null)
  const [providerId, setProviderId] = useState('')
  const [modelId, setModelId] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [auth, setAuth] = useState<aiden.WorkbenchAuthSession | null>(null)
  const reload = useCallback(async () => {
    setError(null)
    try {
      const next = await aiden.loadProviderSetup(sessionId)
      setSnapshot(next)
      const selected = next.sessionSelection ?? next.defaultSelection
      setProviderId((current) => current || selected?.providerId || next.providers[0]?.id || '')
      setModelId((current) => current || selected?.modelId || next.providers.find((provider) => provider.id === (selected?.providerId || next.providers[0]?.id))?.models[0]?.id || '')
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Provider setup is unavailable') }
  }, [sessionId])
  useEffect(() => { void reload() }, [reload])
  useEffect(() => {
    if (!auth || ['connected', 'failed', 'expired'].includes(auth.state)) return
    const timer = window.setInterval(() => {
      void aiden.loadProviderAuthSession(auth.authSessionId).then((next) => {
        setAuth(next)
        if (next.state === 'connected') void reload()
      }).catch(() => undefined)
    }, 1_000)
    return () => window.clearInterval(timer)
  }, [auth, reload])
  const provider = snapshot?.providers.find((item) => item.id === providerId) ?? null
  const chooseProvider = (nextId: string) => {
    setProviderId(nextId)
    setModelId(snapshot?.providers.find((item) => item.id === nextId)?.models[0]?.id || '')
    setError(null)
  }
  const act = async (label: string, operation: () => Promise<unknown>) => {
    setBusy(label); setError(null)
    try { await operation(); await reload() }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Provider operation failed') }
    finally { setBusy(null) }
  }
  const submitCredential = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!provider || !modelId) return
    const form = event.currentTarget
    const credential = String(new FormData(form).get('credential') ?? '').trim()
    if (!credential) { setError('API key is required'); return }
    await act(provider.configured ? 'replace' : 'connect', () => provider.configured
      ? aiden.replaceProviderCredential({ providerId, modelId, credential })
      : aiden.connectProvider({ providerId, modelId, credential }))
    form.reset()
  }
  if (!snapshot) return <p style={settingsTextStyle}>{error || 'Loading provider authority…'}</p>
  const selectionLabel = (selection: { providerId: string; modelId: string } | null) => selection
    ? `${snapshot.providers.find((item) => item.id === selection.providerId)?.displayName ?? selection.providerId} · ${selection.modelId}`
    : 'Not configured'
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <p style={settingsTextStyle}>Credentials are handled by the local backend and protected by <strong style={{ color: 'var(--text)' }}>{snapshot.secretStorage.backend}</strong>. They are never stored in browser state.</p>
      <div style={{ display: 'grid', gap: 4, padding: 10, border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg2)' }}>
        <span style={settingsTextStyle}>Current chat: <strong style={{ color: 'var(--text)' }}>{snapshot.sessionSelection ? selectionLabel(snapshot.sessionSelection) : 'Uses the future default'}</strong></span>
        <span style={settingsTextStyle}>Future default: <strong style={{ color: 'var(--text)' }}>{selectionLabel(snapshot.defaultSelection)}</strong></span>
      </div>
      <label style={settingsTextStyle}>Provider
        <select value={providerId} onChange={(event) => chooseProvider(event.target.value)} style={{ width: '100%', marginTop: 5, padding: 8, background: 'var(--bg2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6 }}>
          {snapshot.providers.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}
        </select>
      </label>
      {provider && (
        <>
          <div style={{ padding: 10, border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg2)' }}>
            <strong style={{ color: 'var(--text)' }}>{provider.displayName}</strong>
            <p style={{ ...settingsTextStyle, margin: '5px 0' }}>{provider.description}</p>
            <span style={{ color: provider.healthy ? 'var(--green)' : provider.configured ? 'var(--orange)' : 'var(--muted2)', fontSize: 11, fontFamily: 'var(--mono)' }}>{provider.connectionState.replace(/_/g, ' ')}{provider.credentialHint ? ` · ${provider.credentialHint}` : ''}</span>
          </div>
          <label style={settingsTextStyle}>Model
            <select value={modelId} onChange={(event) => setModelId(event.target.value)} style={{ width: '100%', marginTop: 5, padding: 8, background: 'var(--bg2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6 }}>
              {provider.models.map((model) => <option key={model.id} value={model.id}>{model.displayName}</option>)}
            </select>
          </label>
          {provider.authKinds.includes('api_key') && (
            <form onSubmit={(event) => { void submitCredential(event) }} style={{ display: 'grid', gap: 7 }}>
              <input name="credential" type="password" autoComplete="off" placeholder={provider.configured ? 'Enter replacement API key' : 'Enter API key'} style={{ padding: 8, background: 'var(--bg2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6 }} />
              <button type="submit" className="nav-btn" disabled={busy !== null || !modelId}>{provider.configured ? 'Replace credential' : 'Connect and verify'}</button>
            </form>
          )}
          {provider.authKinds.includes('oauth') && (
            <button type="button" className="nav-btn" disabled={busy !== null} onClick={() => {
              setBusy('oauth'); setError(null)
              void aiden.startProviderOAuth(provider.id).then(setAuth).catch((cause) => setError(cause instanceof Error ? cause.message : 'Sign-in failed')).finally(() => setBusy(null))
            }}>Connect with {provider.displayName}</button>
          )}
          {auth && <p style={settingsTextStyle}>Sign-in: <strong style={{ color: auth.state === 'connected' ? 'var(--green)' : auth.state === 'failed' ? 'var(--red)' : 'var(--orange)' }}>{auth.state.replace(/_/g, ' ')}</strong>{auth.userCode ? ` · code ${auth.userCode}` : ''}{auth.detail ? ` · ${auth.detail}` : ''}</p>}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            <button type="button" className="nav-btn" disabled={busy !== null || !modelId} onClick={() => { void act('test', () => aiden.testProvider({ providerId, modelId })) }}>Test connection</button>
            <button type="button" className="nav-btn" disabled={busy !== null || !modelId || !sessionId} onClick={() => { void act('session', () => aiden.setSessionModel({ sessionId, providerId, modelId })) }}>Use for this chat</button>
            <button type="button" className="nav-btn" disabled={busy !== null || !modelId} onClick={() => { void act('default', () => aiden.setDefaultModel({ providerId, modelId })) }}>Make default</button>
            <button type="button" className="nav-btn" disabled={busy !== null} onClick={() => { void act('models', () => aiden.refreshProviderModels(providerId)) }}>Refresh models</button>
            {provider.configured && <button type="button" className="nav-btn" disabled={busy !== null} onClick={() => { void act('disconnect', () => aiden.disconnectProvider(providerId)) }}>Disconnect</button>}
          </div>
          <p style={settingsTextStyle}>Changes affect future Jobs. A running Job keeps the provider and model captured when it was admitted.</p>
        </>
      )}
      {error && <p role="alert" style={{ ...settingsTextStyle, color: 'var(--red)' }}>{error}</p>}
    </div>
  )
}

function SettingsDrawer() {
  const {
    settingsTab, setSettingsTab, setSettingsOpen, setConversations, setMessages,
    licenseStatus, licenseKey, setLicenseKey, activatingKey, licenseMsg, setLicenseMsg,
    validateKey, clearProLicense, setPricingOpen, runtimeVersion,
    activeProvider, activeModel, runtimeConnection, executionAvailable,
    executionQueue, workbenchReadOnly, capabilities, startNewChat, clearCurrentView,
    appearance, setAppearance, setMainView, sessionId,
  } = useDevOS()
  const [codingHealth, setCodingHealth] = useState<aiden.ExternalCodingHealth | null>(null)
  const [codingHealthError, setCodingHealthError] = useState<string | null>(null)
  const [codingSaving, setCodingSaving] = useState(false)

  useEffect(() => {
    if (settingsTab !== 'runtime') return
    let current = true
    setCodingHealthError(null)
    void aiden.loadExternalCodingHealth()
      .then((health) => { if (current) setCodingHealth(health) })
      .catch((error) => {
        if (!current) return
        setCodingHealth(null)
        setCodingHealthError(error instanceof Error ? error.message : 'External coding health unavailable')
      })
    return () => { current = false }
  }, [settingsTab])

  return (
    <>
      <div onClick={() => setSettingsOpen(false)} style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
        zIndex: 200, backdropFilter: 'blur(2px)',
      }} />
      <div className="settings-drawer" style={{
        position: 'fixed', top: 0, right: 0, bottom: 0, width: 420,
        background: 'var(--bg1)', borderLeft: '1px solid var(--border)',
        zIndex: 201, display: 'flex', flexDirection: 'column',
        animation: 'slideIn 0.25s ease-out',
      }}>
        {/* Header */}
        <div style={{
          height: 52, display: 'flex', alignItems: 'center',
          justifyContent: 'space-between', padding: '0 20px',
          borderBottom: '1px solid var(--border)', flexShrink: 0,
        }}>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--text)' }}>⚙ Settings</span>
          <button onClick={() => setSettingsOpen(false)} style={{
            background: 'none', border: 'none', color: 'var(--muted)',
            cursor: 'pointer', fontSize: 18, padding: '0 4px',
          }}>✕</button>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '8px 8px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          {SETTINGS_TABS.map((tab, index) => (
            <Fragment key={tab.id}>
            {(index === 0 || SETTINGS_TABS[index - 1]?.section !== tab.section) && <span className="settings-section-label">{tab.section}</span>}
            <button onClick={() => setSettingsTab(tab.id)} style={{
              textAlign: 'left', padding: '7px 12px', borderRadius: 5,
              background: settingsTab === tab.id ? 'var(--bg2)' : 'transparent',
              border: 'none',
              borderLeft: `2px solid ${settingsTab === tab.id ? 'var(--orange)' : 'transparent'}`,
              color: settingsTab === tab.id ? 'var(--text)' : 'var(--muted2)',
              fontFamily: 'var(--mono)', fontSize: 12, cursor: 'pointer',
              transition: 'all 0.15s',
            }}>
              {tab.label}
            </button>
            </Fragment>
          ))}
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
          {settingsTab === 'runtime' && (
            <>
              <SettingsSection title="System Readiness">
                <p style={settingsTextStyle}><strong style={{ color: 'var(--text)' }}>Aiden v{runtimeVersion}</strong></p>
                <p style={settingsTextStyle}>Connection: <strong style={{ color: 'var(--text)' }}>{runtimeConnection}</strong></p>
                <p style={settingsTextStyle}>Execution: <strong style={{ color: executionAvailable ? 'var(--green)' : 'var(--red)' }}>
                  {executionAvailable ? `${executionQueue.workerCount} durable workers ready` : 'unavailable'}
                </strong></p>
                <p style={settingsTextStyle}>Queue: {executionQueue.inflight} running · {executionQueue.pending} pending · {executionQueue.claimed} claimed</p>
                <p style={settingsTextStyle}>{workbenchReadOnly ? 'This browser surface is read-only.' : 'Setup commands use the same local runtime authorities as the CLI.'}</p>
                <ReadinessSettings sessionId={sessionId} onOpenModels={() => setSettingsTab('model')} onOpenApps={() => { setMainView('apps'); setSettingsOpen(false) }} />
              </SettingsSection>
              <SettingsSection title="External Coding">
                {codingHealth ? (
                  <>
                    <p style={settingsTextStyle}>Status: <strong style={{ color: codingHealth.ready ? 'var(--green)' : 'var(--red)' }}>{codingHealth.ready ? 'Ready' : 'Needs attention'}</strong></p>
                    <p style={settingsTextStyle}>Provider: <strong style={{ color: 'var(--text)' }}>{codingHealth.provider}</strong></p>
                    <p style={settingsTextStyle}>Version: <strong style={{ color: 'var(--text)' }}>{codingHealth.version}</strong></p>
                    <p style={settingsTextStyle}>Model: <strong style={{ color: 'var(--text)' }}>{codingHealth.model || 'Not configured'}</strong></p>
                    <p style={settingsTextStyle}>Exact model check: <strong style={{ color: codingHealth.modelValidation === 'ready' ? 'var(--green)' : 'var(--red)' }}>{codingHealth.modelValidation.replace(/_/g, ' ')}</strong></p>
                    <p style={settingsTextStyle}>Authentication: <strong style={{ color: 'var(--text)' }}>{codingHealth.authenticationMode.replace(/_/g, ' ')} · {codingHealth.authentication}</strong></p>
                    <p style={settingsTextStyle}>Isolation: <strong style={{ color: codingHealth.isolation === 'available' ? 'var(--green)' : 'var(--red)' }}>{codingHealth.isolation}</strong></p>
                    <p style={settingsTextStyle}>Validation: <strong style={{ color: codingHealth.isolation === 'available' ? 'var(--green)' : 'var(--red)' }}>{codingHealth.isolation === 'available' ? 'Docker ready' : 'Docker unavailable'}</strong></p>
                    <p style={settingsTextStyle}>Network: Disabled by default</p>
                    <p style={settingsTextStyle}>{codingHealth.reason}</p>
                    <form onSubmit={(event) => {
                      event.preventDefault()
                      const model = String(new FormData(event.currentTarget).get('codingModel') ?? '').trim()
                      if (!model) { setCodingHealthError('A coding model is required'); return }
                      setCodingSaving(true); setCodingHealthError(null)
                      void aiden.configureExternalCoding(model)
                        .then(setCodingHealth)
                        .catch((error) => setCodingHealthError(error instanceof Error ? error.message : 'Coding setup failed'))
                        .finally(() => setCodingSaving(false))
                    }} style={{ display: 'grid', gap: 7, marginTop: 10 }}>
                      <label style={settingsTextStyle}>Exact compatible model
                        <input name="codingModel" defaultValue={codingHealth.model ?? ''} autoComplete="off" placeholder="Model ID" style={{ width: '100%', marginTop: 5, padding: 8, background: 'var(--bg2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6 }} />
                      </label>
                      <button type="submit" className="nav-btn" disabled={codingSaving}>{codingSaving ? 'Validating…' : 'Validate and save model'}</button>
                    </form>
                    <p style={settingsTextStyle}>Aiden uses the bounded detected executable shown above. Environment variables remain advanced process-level overrides.</p>
                  </>
                ) : <p style={settingsTextStyle}>{codingHealthError || 'Checking external coding health…'}</p>}
                {codingHealth && codingHealthError && <p role="alert" style={{ ...settingsTextStyle, color: 'var(--red)' }}>{codingHealthError}</p>}
              </SettingsSection>
            </>
          )}
          {settingsTab === 'profile'   && <UserProfileTab />}
          {settingsTab === 'api'       && <ApiKeysTab />}
          {settingsTab === 'custom'    && <CustomProvidersTab />}
          {settingsTab === 'knowledge' && <KnowledgeBaseTab />}
          {settingsTab === 'updates'   && <UpdatesTab />}

          {settingsTab === 'model' && (
            <SettingsSection title="AI & Models">
              <AIModelsSettings sessionId={sessionId} />
            </SettingsSection>
          )}

          {settingsTab === 'conversation' && (
            <SettingsSection title="Conversation">
              <p style={settingsTextStyle}>These controls change only the current browser view. Durable Job, Attempt, Evidence and Proof records remain intact.</p>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" className="nav-btn" onClick={() => { startNewChat(); setSettingsOpen(false) }}>New Chat</button>
                <button type="button" className="nav-btn" onClick={() => { clearCurrentView(); setSettingsOpen(false) }}>Clear current view</button>
              </div>
              <p style={settingsTextStyle}>Use Export in the Workbench header for Markdown or JSON. Durable deletion is not exposed because no safe deletion authority is available.</p>
            </SettingsSection>
          )}

          {settingsTab === 'appearance' && (
            <SettingsSection title="Appearance">
              <p style={settingsTextStyle}>Appearance is a local Workbench preference and does not change durable runtime state.</p>
              <div className="appearance-options" role="group" aria-label="Appearance">
                <button type="button" className={appearance === 'dark' ? 'is-selected' : ''} onClick={() => setAppearance('dark')}>
                  <strong>Dark</strong><small>Always use Aiden’s designed dark workspace.</small>
                </button>
                <button type="button" className={appearance === 'system' ? 'is-selected' : ''} onClick={() => setAppearance('system')}>
                  <strong>System</strong><small>Follow the operating-system appearance.</small>
                </button>
              </div>
            </SettingsSection>
          )}

          {settingsTab === 'sponsor' && (
            <SettingsSection title="Sponsor Aiden">
              <p style={settingsTextStyle}>Aiden is built independently. Support helps fund development, testing and infrastructure.</p>
              <button type="button" className="sponsor-button" onClick={() => { setMainView('sponsors'); setSettingsOpen(false) }}>Open Sponsors</button>
              <p style={settingsTextStyle}>Support opens the reviewed external payment page. Aiden never reads or stores payment details.</p>
            </SettingsSection>
          )}

          {settingsTab === 'usage' && (
            <SettingsSection title="Usage & Analytics">
              <UsageDashboard />
            </SettingsSection>
          )}

          {settingsTab === 'skills' && (
            <SettingsSection title="Skills Manager">
              <SkillsManager />
            </SettingsSection>
          )}

          {settingsTab === 'capabilities' && (
            <SettingsSection title="Capabilities">
              <CapabilitiesSettings />
            </SettingsSection>
          )}

          {settingsTab === 'plugins' && (
            <SettingsSection title="Plugins">
              <PluginsList />
            </SettingsSection>
          )}

          {settingsTab === 'channels' && <TelegramSettingsTab />}

          {settingsTab === 'security' && <SecurityScan />}

          {settingsTab === 'ide' && <IdeIntegration />}

          {settingsTab === 'pro' && (
            <SettingsSection title="License">

              {/* ── Status card ──────────────────────────────── */}
              <div style={{
                background: licenseStatus.isPro ? 'rgba(249,115,22,0.06)' : 'var(--bg2)',
                border: `1px solid ${licenseStatus.isPro ? 'rgba(249,115,22,0.3)' : 'var(--border)'}`,
                borderRadius: 8, padding: '14px 16px', marginBottom: 16,
                display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10,
              }}>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--muted2)', fontFamily: 'var(--mono)', marginBottom: 6 }}>
                    Current plan
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {licenseStatus.isPro ? (
                      <>
                        <span style={{
                          background: 'var(--orange)', color: '#fff', fontSize: 10, fontWeight: 700,
                          fontFamily: 'var(--mono)', padding: '2px 7px', borderRadius: 4, letterSpacing: '0.05em',
                        }}>
                          {(() => {
                            const p = licenseStatus.plan || ''
                            if (p.includes('annual')) return 'PRO ANNUAL'
                            if (p.includes('launch')) return 'PRO LAUNCH'
                            if (p.includes('legacy')) return 'PRO'
                            return 'PRO MONTHLY'
                          })()}
                        </span>
                        {licenseStatus.expiresAt && (
                          <span style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>
                            Expires {new Date(licenseStatus.expiresAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                          </span>
                        )}
                        {!licenseStatus.expiresAt && licenseStatus.expiry > 0 && (
                          <span style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>
                            Expires {new Date(licenseStatus.expiry).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                          </span>
                        )}
                      </>
                    ) : (
                      <span style={{
                        border: '1px solid rgba(249,115,22,0.4)', color: 'var(--orange)', fontSize: 10,
                        fontWeight: 700, fontFamily: 'var(--mono)', padding: '2px 7px', borderRadius: 4,
                        letterSpacing: '0.05em',
                      }}>FREE</span>
                    )}
                  </div>
                  {licenseStatus.isPro && (
                    <div style={{ marginTop: 8, fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--mono)', lineHeight: 1.7 }}>
                      {licenseStatus.email && <div>Licensed to: {licenseStatus.email}</div>}
                      <div>Machines: up to {(licenseStatus.features?.maxMachines as number) || 2} allowed</div>
                    </div>
                  )}
                </div>
              </div>

              {/* ── FREE: activation form ────────────────────── */}
              {!licenseStatus.isPro && (
                <>
                  <div style={{ marginBottom: 12 }}>
                    <input
                      value={licenseKey}
                      onChange={e => setLicenseKey(e.target.value)}
                      placeholder="AIDEN-PRO-XXXXXX-XXXXXX-XXXXXX"
                      style={{
                        width: '100%', background: 'var(--bg3)', border: '1px solid var(--border2)',
                        borderRadius: 6, padding: '8px 12px', fontFamily: 'var(--mono)', fontSize: 12,
                        color: 'var(--text)', outline: 'none', marginBottom: 8, letterSpacing: '0.5px',
                        boxSizing: 'border-box',
                      }}
                      onKeyDown={async e => {
                        if (e.key === 'Enter' && licenseKey.trim()) await validateKey(licenseKey.trim())
                      }}
                    />
                    <button
                      onClick={async () => { if (licenseKey.trim()) await validateKey(licenseKey.trim()) }}
                      disabled={activatingKey || !licenseKey.trim()}
                      style={{
                        width: '100%', padding: '9px', borderRadius: 6,
                        background: activatingKey || !licenseKey.trim() ? 'var(--bg3)' : 'var(--orange)',
                        border: 'none', color: '#fff',
                        fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 700,
                        cursor: activatingKey ? 'wait' : (!licenseKey.trim() ? 'default' : 'pointer'),
                        opacity: !licenseKey.trim() ? 0.5 : 1,
                        transition: 'background 0.15s',
                      }}
                    >
                      {activatingKey
                        ? <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                            <span style={{
                              width: 10, height: 10, border: '2px solid rgba(255,255,255,0.3)',
                              borderTopColor: '#fff', borderRadius: '50%',
                              animation: 'spin 0.7s linear infinite', display: 'inline-block',
                            }} />
                            Activating…
                          </span>
                        : 'Activate'}
                    </button>
                  </div>

                  {/* Message */}
                  {licenseMsg && (
                    <div style={{
                      padding: '8px 12px', borderRadius: 6, fontSize: 11, fontFamily: 'var(--mono)',
                      background: licenseMsg.type === 'success' ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)',
                      border: `1px solid ${licenseMsg.type === 'success' ? 'rgba(34,197,94,0.25)' : 'rgba(239,68,68,0.25)'}`,
                      color: licenseMsg.type === 'success' ? '#86efac' : '#fca5a5',
                      marginBottom: 12, lineHeight: 1.5,
                    }}>{licenseMsg.text}</div>
                  )}

                  {/* Get Pro link */}
                  <a
                    href="https://aiden.taracod.com"
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      display: 'block', textAlign: 'center', padding: '8px',
                      borderRadius: 6, border: '1px solid rgba(249,115,22,0.3)',
                      color: 'var(--orange)', fontFamily: 'var(--mono)', fontSize: 12,
                      textDecoration: 'none', marginBottom: 14,
                      transition: 'border-color 0.15s',
                    }}
                  >
                    Get Pro → aiden.taracod.com
                  </a>

                  {/* Free tier note */}
                  <div style={{
                    fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--mono)', lineHeight: 1.7,
                    padding: '10px 12px', background: 'var(--bg2)', borderRadius: 6,
                  }}>
                    Free includes all 44 features with limits on goals (5), memories (50), and routines (10)
                  </div>
                </>
              )}

              {/* ── PRO: active state ────────────────────────── */}
              {licenseStatus.isPro && (
                <>
                  {/* Success/info message */}
                  {licenseMsg && (
                    <div style={{
                      padding: '8px 12px', borderRadius: 6, fontSize: 11, fontFamily: 'var(--mono)',
                      background: licenseMsg.type === 'success' ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)',
                      border: `1px solid ${licenseMsg.type === 'success' ? 'rgba(34,197,94,0.25)' : 'rgba(239,68,68,0.25)'}`,
                      color: licenseMsg.type === 'success' ? '#86efac' : '#fca5a5',
                      marginBottom: 14, lineHeight: 1.5,
                    }}>{licenseMsg.text}</div>
                  )}

                  {/* Pro features note */}
                  <div style={{
                    fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--mono)', lineHeight: 1.8,
                    padding: '10px 12px', background: 'var(--bg2)', borderRadius: 6, marginBottom: 16,
                  }}>
                    All limits removed. Night Mode, Watchdog, Persistent Rules, and Persona Engine are active.
                  </div>

                  {/* Deactivate button */}
                  <button
                    onClick={clearProLicense}
                    style={{
                      padding: '6px 12px', borderRadius: 5,
                      background: 'transparent', border: '1px solid rgba(239,68,68,0.35)',
                      color: '#f87171', fontFamily: 'var(--mono)', fontSize: 11,
                      cursor: 'pointer',
                    }}
                  >
                    Deactivate This Machine
                  </button>
                </>
              )}

            </SettingsSection>
          )}

          {settingsTab === 'guide' && (
            <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--muted2)', lineHeight: 1.8 }}>
              <SettingsSection title="Quick Start">
                <ol style={{ paddingLeft: 16, color: 'var(--muted2)' }}>
                  <li>Start DevOS: <code style={codeStyle}>npx ts-node index.ts serve</code></li>
                  <li>Open <code style={codeStyle}>http://localhost:3000</code></li>
                  <li>Add an API key in Settings → API Keys (Groq is free)</li>
                  <li>Ask Aiden anything in the chat</li>
                  <li>Click + to upload files to your knowledge base</li>
                </ol>
              </SettingsSection>
              <SettingsSection title="Tips">
                <ul style={{ paddingLeft: 16 }}>
                  <li>Be specific: "research X and save a detailed report to Desktop"</li>
                  <li>For web search: "search for X and give me the top 5 results"</li>
                  <li>For stocks: "show me NSE top gainers today"</li>
                </ul>
              </SettingsSection>
              <SettingsSection title="Keyboard Shortcuts">
                {[['Ctrl+K', 'New chat'], ['Ctrl+P', 'Toggle Power Mode'], ['Escape', 'Close settings'], ['Enter', 'Send message'], ['Shift+Enter', 'New line']].map(([key, desc]) => (
                  <div key={key} style={{ display: 'flex', gap: 16, marginBottom: 6 }}>
                    <code style={{ ...codeStyle, minWidth: 100 }}>{key}</code>
                    <span>{desc}</span>
                  </div>
                ))}
              </SettingsSection>
            </div>
          )}

          {settingsTab === 'setup' && (
            <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--muted2)', lineHeight: 1.8 }}>
              <SettingsSection title="Prerequisites">
                <ul style={{ paddingLeft: 16 }}>
                  <li>Node.js 18+</li>
                  <li>Ollama (local models) — <a href="https://ollama.com" target="_blank" rel="noopener" style={{ color: 'var(--orange)' }}>ollama.com</a></li>
                  <li>Windows 10/11</li>
                </ul>
              </SettingsSection>
              <SettingsSection title="Recommended Models (GTX 1060 6GB)">
                {[['Chat', 'mistral:7b or qwen2.5:7b'], ['Code', 'qwen2.5-coder:7b'], ['Vision', 'llava:7b'], ['Embedding', 'nomic-embed-text']].map(([type, model]) => (
                  <div key={type} style={{ display: 'flex', gap: 16, marginBottom: 6 }}>
                    <span style={{ minWidth: 80, color: 'var(--muted)' }}>{type}</span>
                    <code style={codeStyle}>{model}</code>
                  </div>
                ))}
              </SettingsSection>
              <SettingsSection title="Voice Setup (Optional)">
                <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted2)', lineHeight: 1.8 }}>
                  <div style={{ marginBottom: 8, color: 'var(--muted3)' }}>Voice input requires Python + faster-whisper:</div>
                  <code style={codeStyle}>pip install faster-whisper</code>
                  <div style={{ marginTop: 12, marginBottom: 8, color: 'var(--muted3)' }}>Voice output (edge-tts) — natural Aria voice:</div>
                  <code style={codeStyle}>pip install edge-tts</code>
                  <div style={{ marginTop: 12, padding: '8px 10px', background: 'var(--bg2)', borderRadius: 6, border: '1px solid var(--border)' }}>
                    <div style={{ color: 'var(--muted)' }}>Once installed, restart DevOS. The 🎤 and 🔊 buttons appear automatically in chat — no config needed.</div>
                    <div style={{ marginTop: 6, color: 'var(--muted)' }}>Without edge-tts, Windows SAPI (built-in) is used as fallback.</div>
                  </div>
                </div>
              </SettingsSection>
              <SettingsSection title="Web Search Setup (Optional)">
                <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted2)', lineHeight: 1.8 }}>
                  <div style={{ marginBottom: 8, color: 'var(--muted3)' }}>SearxNG gives unlimited self-hosted search (requires Docker):</div>
                  <code style={codeStyle}>.\scripts\start-searxng.ps1</code>
                  <div style={{ marginTop: 10, marginBottom: 8, color: 'var(--muted3)' }}>Or add a Brave Search API key to .env for a free fallback:</div>
                  <code style={codeStyle}>BRAVE_SEARCH_API_KEY=your_key</code>
                </div>
              </SettingsSection>
            </div>
          )}

          {settingsTab === 'privacy' && (
            <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--muted2)', lineHeight: 1.8 }}>
              <LearningSettingsTab />
              <SettingsSection title="Privacy Policy">
                <p style={settingsTextStyle}><strong style={{ color: 'var(--text)' }}>DevOS runs entirely on your machine.</strong></p>
                <br />
                <strong style={{ color: 'var(--muted3)' }}>Stays on your device:</strong>
                <ul style={{ paddingLeft: 16, marginTop: 6 }}>
                  <li>All conversations and chat history</li>
                  <li>Knowledge base files and embeddings (stored in <code style={codeStyle}>workspace/knowledge/</code>)</li>
                  <li>PDF, EPUB, and document files you upload — text is extracted locally, no cloud OCR</li>
                  <li>Task history and execution logs</li>
                  <li>Memory, entity graph, semantic index</li>
                  <li>Screenshots and workspace files</li>
                  <li>Your API keys (stored locally)</li>
                </ul>
                <br />
                <strong style={{ color: 'var(--muted3)' }}>Leaves your device:</strong>
                <ul style={{ paddingLeft: 16, marginTop: 6 }}>
                  <li>Only message text sent to your configured AI provider</li>
                  <li>Zero telemetry or analytics collected</li>
                </ul>
                <br />
                <p style={settingsTextStyle}>Contact: <a href="mailto:contact@taracod.com" style={{ color: 'var(--orange)' }}>contact@taracod.com</a></p>
                <p style={{ ...settingsTextStyle, marginTop: 4 }}>Last updated: March 2026</p>
              </SettingsSection>
            </div>
          )}

          {settingsTab === 'legal' && (
            <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--muted2)', lineHeight: 1.8 }}>
              <SettingsSection title="License & Copyright">
                <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8, padding: 16, marginBottom: 16 }}>
                  <div style={{ fontSize: 13, color: 'var(--text)', fontWeight: 600, marginBottom: 8 }}>DevOS · Aiden</div>
                  <div>Built by <strong style={{ color: 'var(--text)' }}>Shiva Deore</strong></div>
                  <div>
                    <a href="https://taracod.com" target="_blank" rel="noopener" style={{ color: 'var(--orange)', textDecoration: 'none' }}>Taracod</a>
                    {' · '}<strong style={{ color: 'var(--muted3)' }}>White Lotus</strong>
                  </div>
                  <div style={{ marginTop: 8, color: 'var(--muted)' }}>© 2026 All rights reserved</div>
                </div>
                <p style={settingsTextStyle}>
                  <a href="mailto:contact@taracod.com" style={{ color: 'var(--orange)' }}>contact@taracod.com</a>
                  {' · '}
                  <a href="https://taracod.com" target="_blank" rel="noopener" style={{ color: 'var(--orange)' }}>taracod.com</a>
                </p>
              </SettingsSection>
            </div>
          )}

          {settingsTab === 'about' && (
            <div>
              <div style={{ textAlign: 'center', padding: '24px 0 16px', borderBottom: '1px solid var(--border)', marginBottom: 20 }}>
                <div style={{
                  width: 48, height: 48, borderRadius: 10, background: 'var(--orange)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 18, fontWeight: 800, color: '#000', margin: '0 auto 12px',
                  fontFamily: 'var(--sans)',
                }}>D/</div>
                <div style={{ fontFamily: 'var(--sans)', fontSize: 16, fontWeight: 700, color: 'var(--text)' }}>DevOS · Aiden</div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>v{runtimeVersion} · Local AI OS</div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {[
                  { label: 'Discord',          href: 'https://discord.gg/8mBwwBcp' },
                  { label: 'Follow @shivafpx', href: 'https://x.com/shivafpx' },
                  { label: 'Visit taracod.com',href: 'https://taracod.com' },
                  { label: 'Report a bug',     href: 'mailto:contact@taracod.com' },
                ].map(link => (
                  <a key={link.label} href={link.href} target="_blank" rel="noopener" style={{
                    display: 'block', padding: '10px 14px', borderRadius: 6,
                    background: 'var(--bg2)', border: '1px solid var(--border)',
                    color: 'var(--muted2)', fontFamily: 'var(--mono)', fontSize: 12,
                    textDecoration: 'none', transition: 'all 0.15s',
                  }}>{link.label} →</a>
                ))}
              </div>
            </div>
          )}

          {settingsTab === 'danger' && (
            <div>
              <div style={{ background: 'rgba(239,68,68,0.05)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 8, padding: 16, marginBottom: 20 }}>
                <div style={{ fontSize: 12, color: 'var(--red)', fontFamily: 'var(--mono)', marginBottom: 4 }}>⚠️ Danger Zone</div>
                <div style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>These actions cannot be undone.</div>
              </div>
              {[
                {
                  label: 'Clear conversation history',
                  desc:  'Removes all saved conversations from disk and memory',
                  action: async () => {
                    await fetch('http://localhost:4200/api/conversations/clear', { method: 'POST' }).catch(() => {})
                    setConversations([])
                    localStorage.removeItem('devos_conversations')
                    setMessages([])
                  },
                },
                {
                  label: 'Clear all memory',
                  desc:  'Wipes conversation memory and semantic memory index',
                  action: async () => {
                    await fetch('http://localhost:4200/api/memory/clear', { method: 'POST' }).catch(() => {})
                  },
                },
                {
                  label: 'Clear knowledge base',
                  desc:  'Removes all clipped knowledge files',
                  action: async () => {
                    await fetch('http://localhost:4200/api/knowledge/clear', { method: 'POST' }).catch(() => {})
                  },
                },
              ].map(item => (
                <div key={item.label} style={{ marginBottom: 8 }}>
                  <button onClick={async () => {
                    if (window.confirm(`Are you sure? This cannot be undone.\n\n${item.label}`)) {
                      await item.action()
                      alert(`✓ ${item.label} — done.`)
                    }
                  }} style={{
                    width: '100%', padding: '10px 14px',
                    background: 'transparent', border: '1px solid rgba(239,68,68,0.3)',
                    borderRadius: 6, color: 'var(--red)', fontFamily: 'var(--mono)',
                    fontSize: 12, cursor: 'pointer', textAlign: 'left', transition: 'all 0.15s',
                  }}>{item.label}</button>
                  <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--mono)', marginTop: 3, paddingLeft: 2 }}>{item.desc}</div>
                </div>
              ))}
            </div>
          )}

          {settingsTab === 'debug' && <DebugPanel />}
        </div>
      </div>
    </>
  )
}

// ── Main component ────────────────────────────────────────────

export default function Home() {

  const [runtimeVersion, setRuntimeVersion] = useState('unknown')
  const [runtimeEdition, setRuntimeEdition] = useState<'community' | 'pro' | 'team' | 'enterprise'>('community')

  // ── Onboarding ──────────────────────────────────────────────
  const [onboardingDone, setOnboardingDone] = useState<boolean | null>(null)

  useEffect(() => {
    setOnboardingDone(window.localStorage.getItem('aiden:first-run:v1') === 'complete')
  }, [])

  // ── Load active model label for header ───────────────────────
  // ── Auto-update banner wiring ────────────────────────────────
  useEffect(() => {
    // Electron: listen via IPC (aidenUpdater from preload)
    const updater = typeof window !== 'undefined' ? (window as any).aidenUpdater : null
    if (updater) {
      updater.onUpdateAvailable((data: any) => {
        if (data?.version) setUpdateBanner({ version: data.version, url: '' })
      })
      return // IPC handles everything — no polling needed
    }

    // Browser fallback: poll the API once after 30s
    const t = setTimeout(async () => {
      try {
        const res  = await fetch('http://localhost:4200/api/update/check')
        const data = await res.json() as any
        if (data.available && data.latestVersion) {
          setUpdateBanner({ version: data.latestVersion, url: data.downloadUrl || '' })
        }
      } catch { /* silently ignore */ }
    }, 30000)
    return () => clearTimeout(t)
  }, [])

  // ── UI Mode ─────────────────────────────────────────────────
  const [uiMode,         setUIMode]         = useState<UIMode>('focus')
  const [execMode,       setExecMode]       = useState<ExecMode>('auto')
  const [historyOpen,    setHistoryOpen]    = useState(true)
  const [liveViewOpen,   setLiveViewOpen]   = useState(false)
  const [activityOpen,   setActivityOpen]   = useState(false)
  const [settingsOpen,   setSettingsOpen]   = useState(false)
  const [settingsTab,    setSettingsTab]    = useState('runtime')
  const [appearance,     setAppearance]     = useState<WorkbenchAppearance>('dark')
  const [isExecuting,    setIsExecuting]    = useState(false)
  const [isStreaming,    setIsStreaming]    = useState(false)
  const [thinking,       setThinking]       = useState<{ stage: string; message: string; tool?: string } | null>(null)
  const [budget,         setBudget]         = useState<{ current: number; max: number; remaining: number } | null>(null)
  const [activeModel,    setActiveModel]    = useState<string>('')
  const [activeProvider, setActiveProvider] = useState<string>('')
  const [runtimeConnection, setRuntimeConnection] = useState<'connected' | 'reconnecting' | 'unavailable'>('unavailable')
  const [executionAvailable, setExecutionAvailable] = useState(false)
  const [executionQueue, setExecutionQueue] = useState({ pending: 0, claimed: 0, inflight: 0, workerCount: 0 })
  const [workbenchReadOnly, setWorkbenchReadOnly] = useState(true)
  const [presence, setPresence] = useState<aiden.WorkbenchPresenceSnapshot | null>(null)
  const [presenceBriefing, setPresenceBriefing] = useState<aiden.WorkbenchPresenceBriefing | null>(null)
  const refreshPresence = useCallback(async () => {
    const snapshot = await aiden.loadPresenceSnapshot()
    setPresence(snapshot)
  }, [])

  useEffect(() => {
    const narrow = window.matchMedia('(max-width: 620px)')
    const closePermanentSidebar = (event: MediaQueryListEvent | MediaQueryList) => {
      if (event.matches) setHistoryOpen(false)
    }
    closePermanentSidebar(narrow)
    narrow.addEventListener('change', closePermanentSidebar)
    return () => narrow.removeEventListener('change', closePermanentSidebar)
  }, [])

  // ── Messages / conversations ────────────────────────────────
  const [messages,       setMessages]       = useState<Message[]>([])
  const [conversations,  setConversations]  = useState<Conversation[]>([])
  const [conversationsHydrated, setConversationsHydrated] = useState(false)
  const conversationsRef = useRef<Conversation[]>([])
  const [currentConvId,  setCurrentConvId]  = useState<string>('')
  const [input,          setInput]          = useState('')

  // ── Activity / screenshot ───────────────────────────────────
  const [activityLogs,   setActivityLogs]   = useState<ActivityLog[]>([])
  const [liveActivity,   setLiveActivity]   = useState<LiveActivityItem[]>([])
  const liveActivityByJobRef = useRef(new Map<string, LiveActivityItem[]>())
  const [attachments,    setAttachments]    = useState<aiden.WorkbenchAttachment[]>([])
  const [runProjection,  setRunProjection]  = useState<aiden.WorkbenchRunProjection | null>(null)
  const [runArtifacts,   setRunArtifacts]   = useState<aiden.WorkbenchArtifact[]>([])
  const [capabilities,   setCapabilities]   = useState<aiden.WorkbenchCapabilities | null>(null)
  const [browserSession, setBrowserSession] = useState<aiden.WorkbenchBrowserSession | null>(null)
  const [liveExecution, setLiveExecution] = useState<aiden.WorkbenchLiveExecutionProjection | null>(null)
  const [liveExecutionSelection, setLiveExecutionSelection] = useState<LiveExecutionSelection>({
    selectedSurfaceId: null, pinnedSurfaceId: null, autoFollow: true,
  })
  const liveExecutionCollapsedKeyRef = useRef<string | null>(null)
  const liveExecutionIdentityKeyRef = useRef<string | null>(null)
  const [projectionRevision, setProjectionRevision] = useState(0)
  const recordLiveActivity = useCallback((jobId: string, activity: LiveActivityItem, foreground: boolean) => {
    const next = mergeLiveActivity(liveActivityByJobRef.current.get(jobId) ?? [], activity)
    liveActivityByJobRef.current.set(jobId, next)
    if (foreground) setLiveActivity(next)
  }, [])
  const [screenshot,     setScreenshot]     = useState<string | null>(null)
  // ── Main view (chat | activity) + the run currently attached to the chat ──
  const [mainView,       setMainView]       = useState<MainView>('chat')
  const activeRunIdRef = useRef<number | null>(null)
  const activeRunFollowAbortRef = useRef<AbortController | null>(null)
  const activeRunFollowControllersRef = useRef<Set<AbortController>>(new Set())
  const [activeJobId, setActiveJobId] = useState<string | null>(null)
  const [activeAttemptId, setActiveAttemptId] = useState<string | null>(null)
  const [activeRunId, setActiveRunId] = useState<number | null>(null)
  const workbenchControllerRef = useRef(new WorkbenchController())
  const [controllerRevision, setControllerRevision] = useState(0)
  const selectedContext = workbenchControllerRef.current.snapshot().selected
  const publishController = useCallback(() => setControllerRevision((value) => value + 1), [])
  const selectContext = useCallback((selection: WorkbenchSelection, replace = false) => {
    workbenchControllerRef.current.select(selection)
    publishController()
    setMainView('chat')
    if (typeof window !== 'undefined') {
      const next = selectionToSearch(selection)
      const url = `${window.location.pathname}${next}`
      if (replace) window.history.replaceState(window.history.state, '', url)
      else window.history.pushState(window.history.state, '', url)
    }
  }, [publishController])
  const syncForegroundLifecycle = useCallback((jobId: string | null) => {
    const projected = jobId === null
      ? undefined
      : workbenchControllerRef.current.active().find((job) => job.jobId === jobId)
    const active = projected && isForegroundExecutionStatus(projected.status) ? projected : undefined
    setIsExecuting(Boolean(active))
    setIsStreaming(Boolean(active))
    setThinking(active ? {
      stage: active.status,
      message: active.statusDetail || active.status.replace(/_/g, ' '),
    } : null)
    if (!active) setBudget(null)
  }, [])
  useEffect(() => {
    let current = true
    const refreshActiveJobs = async () => {
      const bootstrap = await aiden.loadWorkbenchBootstrap()
      if (!current) return
      setRuntimeVersion(bootstrap.runtime.version)
      setRuntimeEdition(bootstrap.runtime.edition)
      setActiveProvider(bootstrap.provider.displayName || bootstrap.provider.id || '')
      setActiveModel(bootstrap.model.displayName || bootstrap.model.id || '')
      setRuntimeConnection(bootstrap.connection)
      setExecutionAvailable(bootstrap.execution.available)
      setExecutionQueue({
        pending: bootstrap.execution.pending,
        claimed: bootstrap.execution.claimed,
        inflight: bootstrap.execution.inflight,
        workerCount: bootstrap.execution.workerCount,
      })
      setWorkbenchReadOnly(bootstrap.readOnly)
      workbenchControllerRef.current.reconcileActive(bootstrap.activeJobs.map((job) => ({
          sessionId: job.sessionId,
          jobId: job.jobId,
          attemptId: job.attemptId,
          runId: job.runId,
          status: normalizeActiveJobStatus(job.status),
          title: job.title,
          statusDetail: job.statusDetail,
          updatedAt: job.updatedAt,
      })))
      const selectedJobId = workbenchControllerRef.current.snapshot().selected.jobId
      if (selectedJobId) syncForegroundLifecycle(selectedJobId)
      publishController()
    }
    void refreshActiveJobs().catch(() => { /* the bridge may be read-only or temporarily unavailable */ })
    const timer = window.setInterval(() => {
      void refreshActiveJobs().catch(() => { /* keep the last authoritative snapshot on transient failure */ })
    }, 5_000)
    return () => { current = false; window.clearInterval(timer) }
  }, [publishController, syncForegroundLifecycle])
  useEffect(() => {
    let current = true
    const refresh = async () => {
      const snapshot = await aiden.loadPresenceSnapshot()
      if (current) setPresence(snapshot)
    }
    void refresh().catch(() => { /* Presence projection failure never changes Job or composer truth. */ })
    const timer = window.setInterval(() => {
      void refresh().catch(() => { /* retain the last durable attention projection */ })
    }, 5_000)
    let briefingId = window.sessionStorage.getItem('aiden.presence.briefing.v1')
    if (!briefingId) {
      briefingId = `workbench-start:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`
      window.sessionStorage.setItem('aiden.presence.briefing.v1', briefingId)
    }
    void aiden.loadPresenceBriefing(briefingId)
      .then((briefing) => { if (current) setPresenceBriefing(briefing) })
      .catch(() => { /* the normal snapshot remains available if briefing projection fails */ })
    return () => { current = false; window.clearInterval(timer) }
  }, [])
  useEffect(() => {
    let current = true
    void aiden.loadWorkbenchCapabilities()
      .then((next) => { if (current) setCapabilities(next) })
      .catch(() => { if (current) setCapabilities({ modelSwitch: { available: false, reason: 'Managed by the Aiden runtime.' }, skills: [], plugins: [] }) })
    return () => { current = false }
  }, [])
  useEffect(() => {
    if (typeof window === 'undefined') return
    const saved = window.localStorage.getItem('aiden.workbench.sidebar.v1')
    if (saved === 'closed') setHistoryOpen(false)
    if (window.matchMedia('(max-width: 980px)').matches) setHistoryOpen(false)
  }, [])
  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('aiden.workbench.sidebar.v1', historyOpen ? 'open' : 'closed')
    }
  }, [historyOpen])
  useEffect(() => {
    if (typeof window === 'undefined') return
    const saved = window.localStorage.getItem('aiden.workbench.appearance.v1')
    if (saved === 'system' || saved === 'dark') setAppearance(saved)
  }, [])
  useEffect(() => {
    if (typeof document === 'undefined' || typeof window === 'undefined') return
    document.documentElement.dataset.appearance = appearance
    window.localStorage.setItem('aiden.workbench.appearance.v1', appearance)
  }, [appearance])
  useEffect(() => {
    if (typeof window === 'undefined') return
    const narrow = window.matchMedia('(max-width: 980px)')
    const collapse = (event: MediaQueryListEvent) => { if (event.matches) setHistoryOpen(false) }
    narrow.addEventListener('change', collapse)
    return () => narrow.removeEventListener('change', collapse)
  }, [])
  useEffect(() => {
    let current = true
    if (!activeJobId || !activeAttemptId || activeRunId === null) {
      setRunProjection(null)
      setRunArtifacts([])
      return () => { current = false }
    }
    const refresh = async () => {
      const [projection, artifacts] = await Promise.all([
        aiden.loadRunProjection(activeJobId, activeAttemptId, activeRunId),
        aiden.listArtifacts(activeRunId),
      ])
      if (!current) return
      setRunProjection(projection)
      setRunArtifacts(artifacts)
    }
    void refresh().catch(() => { /* live events remain available during transient projection failure */ })
    const timer = runProjection?.receipt.terminal ? null : window.setInterval(() => {
      void refresh().catch(() => { /* keep the last exact durable projection */ })
    }, 1_000)
    return () => { current = false; if (timer !== null) window.clearInterval(timer) }
  }, [activeJobId, activeAttemptId, activeRunId, projectionRevision, runProjection?.receipt.terminal])
  useEffect(() => {
    let current = true
    const generation = runProjection?.identity.generation
    if (!activeJobId || !activeAttemptId || activeRunId === null || generation === undefined) {
      setLiveExecution(null)
      setLiveExecutionSelection({ selectedSurfaceId: null, pinnedSurfaceId: null, autoFollow: true })
      liveExecutionCollapsedKeyRef.current = null
      liveExecutionIdentityKeyRef.current = null
      return () => { current = false }
    }
    setLiveExecution((visible) => visible
      && visible.job.jobId === activeJobId
      && visible.job.attemptId === activeAttemptId
      && visible.job.generation === generation
      && visible.job.runId === activeRunId
      ? visible
      : null)
    const refresh = async () => {
      const next = await aiden.loadLiveExecution({
        jobId: activeJobId, attemptId: activeAttemptId, generation, runId: activeRunId,
      })
      if (!current || !next) return
      const identityKey = `${next.job.jobId}:${next.job.attemptId}:${next.job.generation}:${next.job.runId}`
      if (liveExecutionIdentityKeyRef.current !== identityKey) {
        liveExecutionIdentityKeyRef.current = identityKey
        liveExecutionCollapsedKeyRef.current = null
      }
      setLiveExecution(next)
      const attention = next.surfaces.find((surface) => surface.kind === 'app_action' && surface.status === 'waiting')?.surfaceId ?? null
      setLiveExecutionSelection((selection) => chooseLiveExecutionSurface(
        next.surfaces,
        selection,
        next.activeSurface?.surfaceId ?? null,
        attention,
      ))
      const autoOpenSurfaceId = next.activeSurface?.surfaceId ?? next.surfaces[0]?.surfaceId ?? null
      if (shouldAutoOpenLiveExecution(next.job, next.job.terminal, autoOpenSurfaceId, liveExecutionCollapsedKeyRef.current)) {
        setLiveViewOpen(true)
      }
    }
    void refresh().catch(() => { /* observer failure never changes Job truth */ })
    const timer = window.setInterval(() => {
      void refresh().catch(() => { /* retain last bounded observer snapshot */ })
    }, runProjection?.receipt.terminal ? 2_000 : 500)
    return () => { current = false; window.clearInterval(timer) }
  }, [activeJobId, activeAttemptId, activeRunId, runProjection?.identity.generation, runProjection?.receipt.terminal])
  useEffect(() => {
    let current = true
    if (!activeJobId) {
      setBrowserSession(null)
      return () => { current = false }
    }
    const refresh = async () => {
      const next = await aiden.loadBrowserSession(activeJobId)
      if (current) setBrowserSession(next)
    }
    void refresh().catch(() => { if (current) setBrowserSession(null) })
    const timer = window.setInterval(() => { void refresh().catch(() => { /* keep last durable state */ }) }, 1_000)
    return () => { current = false; window.clearInterval(timer) }
  }, [activeJobId])
  const controlBrowser = useCallback(async (action: 'take' | 'return' | 'clear') => {
    if (!activeJobId) return
    const next = await aiden.controlBrowserSession(activeJobId, action)
    setBrowserSession(next)
  }, [activeJobId])
  const selectLiveExecutionSurface = useCallback((surfaceId: string) => {
    setLiveExecutionSelection((selection) => ({
      ...selection, selectedSurfaceId: surfaceId, autoFollow: false, attentionSurfaceId: null,
    }))
    setLiveViewOpen(true)
  }, [])
  const toggleLiveExecutionPin = useCallback(() => {
    setLiveExecutionSelection((selection) => {
      const pinned = selection.pinnedSurfaceId === selection.selectedSurfaceId ? null : selection.selectedSurfaceId
      return { ...selection, pinnedSurfaceId: pinned, autoFollow: pinned === null }
    })
  }, [])
  const collapseLiveExecution = useCallback(() => {
    if (liveExecution) {
      const autoOpenSurfaceId = liveExecution.activeSurface?.surfaceId ?? liveExecution.surfaces[0]?.surfaceId ?? null
      liveExecutionCollapsedKeyRef.current = liveExecutionAutoOpenKey(liveExecution.job, autoOpenSurfaceId)
    }
    setLiveViewOpen(false)
  }, [liveExecution])
  const reopenLiveExecution = useCallback(() => {
    liveExecutionCollapsedKeyRef.current = null
    setLiveViewOpen(true)
  }, [])
  useEffect(() => {
    if (typeof window === 'undefined') return
    const onPopState = () => {
      const selection = selectionFromSearch(window.location.search)
      const conversation = conversations.find((item) =>
        (selection.jobId && item.jobId === selection.jobId)
        || (selection.sessionId && (item.id === selection.sessionId || item.sessionId === selection.sessionId)))
      selectContext(selection, true)
      setCurrentConvId(conversation?.id || selection.sessionId || '')
      if (conversation) setMessages(conversation.messages)
      else if (!selection.jobId) setMessages([])
      setLiveActivity(selection.jobId ? (liveActivityByJobRef.current.get(selection.jobId) ?? []) : [])
      setActiveJobId(selection.jobId)
      setActiveAttemptId(selection.attemptId)
      setActiveRunId(selection.runId)
      activeRunIdRef.current = selection.runId
      syncForegroundLifecycle(selection.jobId)
    }
    onPopState()
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [conversations, selectContext, syncForegroundLifecycle])
  useEffect(() => {
    if (!conversationsHydrated) return
    let restored = aiden.restoreRunHandle()
    if (!restored) return
    const controller = new AbortController()
    let restorationSelectionGeneration = workbenchControllerRef.current.snapshot().selectionGeneration
    const restorationStillOwnsSelection = () => !controller.signal.aborted
      && workbenchControllerRef.current.isCurrent(restorationSelectionGeneration)
    const replay = { admission: restored.admission, lastEventId: 0 }
    const recoveredMessageId = `recovered_${restored.admission.attemptId}`
    let fullReply = ''
    const nowTime = () => new Date().toLocaleTimeString('en', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
    const settle = () => {
      if (activeRunFollowAbortRef.current === controller) activeRunFollowAbortRef.current = null
      activeRunFollowControllersRef.current.delete(controller)
      setThinking(null); setBudget(null); setIsExecuting(false); setIsStreaming(false)
    }
    const startReplay = () => {
      if (!restorationStillOwnsSelection()) return
      activeRunIdRef.current = restored.admission.runId
      workbenchControllerRef.current.register(restored.admission, restored.admission.jobId)
      publishController()
      setActiveJobId(restored.admission.jobId)
      setActiveAttemptId(restored.admission.attemptId)
      setActiveRunId(restored.admission.runId)
      activeRunFollowAbortRef.current = controller
       activeRunFollowControllersRef.current.add(controller)
      setIsExecuting(true)
      setIsStreaming(true)
      setThinking({ stage: 'reconnecting', message: 'Reconnecting…' })
      void aiden.followRun(replay, {
      onConnectionState: (state) => {
        if (!restorationStillOwnsSelection()) return
        if (state === 'terminal') return
        setThinking({ stage: state, message: state === 'connected' ? 'Restoring durable activity…' : `${state}…` })
      },
      onReattached: (admission) => {
        if (!restorationStillOwnsSelection()) return
        restored = { admission, lastEventId: 0 }
        const sessionId = workbenchControllerRef.current.snapshot().selected.sessionId
        setActiveJobId(admission.jobId)
        setActiveAttemptId(admission.attemptId)
        setActiveRunId(admission.runId)
        activeRunIdRef.current = admission.runId
        selectContext({
          sessionId,
          jobId: admission.jobId,
          attemptId: admission.attemptId,
          runId: admission.runId,
        }, true)
        restorationSelectionGeneration = workbenchControllerRef.current.snapshot().selectionGeneration
      },
      onThinking: (stage, message) => {
        if (!restorationStillOwnsSelection()) return
        setThinking({ stage, message })
      },
      onReply: (chunk) => {
        if (!restorationStillOwnsSelection()) return
        setThinking(null)
        fullReply += chunk
        setMessages((prev) => {
          const recovered = prev.some((message) => message.id === recoveredMessageId)
          const next: Message = { id: recoveredMessageId, role: 'assistant', content: fullReply, timestamp: Date.now(), isStreaming: true }
          return recovered ? prev.map((message) => message.id === recoveredMessageId ? next : message) : [...prev, next]
        })
      },
      onReplySnapshot: (content) => {
        if (!restorationStillOwnsSelection()) return
        setThinking(null)
        fullReply = content
        setMessages((prev) => {
          const recovered = prev.some((message) => message.id === recoveredMessageId)
          const next: Message = { id: recoveredMessageId, role: 'assistant', content, timestamp: Date.now(), isStreaming: true }
          return recovered ? prev.map((message) => message.id === recoveredMessageId ? next : message) : [...prev, next]
        })
      },
      onActivity: (activity) => {
        if (!restorationStillOwnsSelection()) return
        recordLiveActivity(restored.admission.jobId, activity, true)
        const style: ActivityLog['style'] = activity.status === 'ok'
          ? 'ok' : (activity.status === 'failed' || activity.status === 'warn') ? 'err' : 'active'
        const icon = activity.kind === 'verify'
          ? (activity.status === 'ok' ? '✓' : '⚠')
          : activity.status === 'failed' ? '✗' : activity.status === 'running' ? '▸' : '✓'
        const message = activity.label + (activity.detail ? ` · ${activity.detail}` : '')
        setActivityLogs((prev) => [...prev.slice(-199), { time: nowTime(), icon, agent: 'Aiden', message, style }])
      },
      onTokens: (total) => {
        if (!restorationStillOwnsSelection()) return
        setBudget({ current: total, max: 0, remaining: 0 })
      },
      onDone: (info) => {
        if (!restorationStillOwnsSelection()) return
        aiden.clearRunHandle(restored.admission)
        settle()
        if (!fullReply && info.summary) {
          setMessages((prev) => [...prev, { id: recoveredMessageId, role: 'assistant', content: info.summary!, timestamp: Date.now(), isStreaming: false }])
        } else if (fullReply) {
          setMessages((prev) => prev.map((message) => message.id === recoveredMessageId ? { ...message, isStreaming: false } : message))
        }
      },
      onError: (message) => {
        if (!restorationStillOwnsSelection()) return
        aiden.clearRunHandle(restored.admission)
        settle()
        setMessages((prev) => fullReply ? prev : [...prev, { id: recoveredMessageId, role: 'assistant', content: `⚠ ${message}`, timestamp: Date.now(), isStreaming: false }])
      },
      }, { signal: controller.signal, stallMs: 2_000, maxUncertainMs: 15_000 })
    }
    void aiden.reconcileRestoredRunHandle(restored).then((resolution) => {
      if (!restorationStillOwnsSelection()) return
      if (resolution.kind === 'missing') throw new Error('stale Workbench run handle')
      restored = resolution.handle
      setActiveJobId(restored.admission.jobId)
      setActiveAttemptId(restored.admission.attemptId)
      setActiveRunId(restored.admission.runId)
      activeRunIdRef.current = restored.admission.runId
      selectContext({
        sessionId: null,
        jobId: restored.admission.jobId,
        attemptId: restored.admission.attemptId,
        runId: restored.admission.runId,
      }, true)
      restorationSelectionGeneration = workbenchControllerRef.current.snapshot().selectionGeneration
      if (resolution.kind === 'terminal') {
        workbenchControllerRef.current.register(restored.admission, null)
        workbenchControllerRef.current.settle(restored.admission.jobId)
        publishController()
        aiden.clearRunHandle(restored.admission)
        settle()
        const summary = aiden.assistantOutputText(resolution.projection)
          || resolution.projection.receipt.summary
        const durableConversation = conversationForExactRun(
          conversationsRef.current,
          restored.admission,
        )
        const durableResponseExists = durableConversation?.messages.at(-1)?.role === 'assistant'
          && durableConversation.messages.at(-1)?.isStreaming !== true
          && Boolean(durableConversation.messages.at(-1)?.content.trim())
        if (durableConversation && durableResponseExists) {
          setCurrentConvId(durableConversation.id)
          setMessages([...durableConversation.messages])
        } else if (summary) {
          setMessages((prev) => prev.some((message) => message.id === recoveredMessageId)
            ? prev
            : [...prev, { id: recoveredMessageId, role: 'assistant', content: summary, timestamp: Date.now(), isStreaming: false }])
        }
        return
      }
      if (resolution.kind === 'inactive') {
        workbenchControllerRef.current.registerView({
          sessionId: null,
          jobId: restored.admission.jobId,
          attemptId: restored.admission.attemptId,
          runId: restored.admission.runId,
          status: normalizeActiveJobStatus(resolution.projection.receipt.status),
          statusDetail: resolution.projection.receipt.summary || 'Durable reconciliation required',
          updatedAt: Date.now(),
        })
        publishController()
        aiden.clearRunHandle(restored.admission)
        activeRunIdRef.current = null
        settle()
        return
      }
      startReplay()
    }).catch(() => {
      if (!restorationStillOwnsSelection()) return
      aiden.clearRunHandle(restored.admission)
      workbenchControllerRef.current.settle(restored.admission.jobId)
      publishController()
      activeRunIdRef.current = null
      setActiveJobId(null)
      setActiveAttemptId(null)
      setActiveRunId(null)
      settle()
      setMessages((prev) => [...prev, {
        id: recoveredMessageId,
        role: 'assistant',
        content: '⚠ saved activity could not be restored. The stale browser handle was cleared; durable state was not changed.',
        timestamp: Date.now(),
        isStreaming: false,
      }])
    })
    return () => {
      controller.abort()
      activeRunFollowControllersRef.current.delete(controller)
    }
  }, [conversationsHydrated, publishController, selectContext, recordLiveActivity])
  useEffect(() => () => {
    for (const controller of Array.from(activeRunFollowControllersRef.current)) controller.abort()
    activeRunFollowControllersRef.current.clear()
  }, [])

  // ── Plus menu state ─────────────────────────────────────────
  const [plusMenuOpen,      setPlusMenuOpen]      = useState(false)
  const [activeSubmenu,     setActiveSubmenu]     = useState<string | null>(null)
  const [channelStatuses,   setChannelStatuses]   = useState<Record<string, boolean>>({})  // eslint-disable-line @typescript-eslint/no-unused-vars
  const [channelModal,      setChannelModal]      = useState<string | null>(null)
  const [miniPrompt,        setMiniPrompt]        = useState<MiniPromptConfig | null>(null)
  const [miniPromptValue,   setMiniPromptValue]   = useState('')

  // ── Update banner ────────────────────────────────────────────
  const [updateBanner, setUpdateBanner] = useState<{ version: string; url: string } | null>(null)

  // ── Voice state ─────────────────────────────────────────────
  const [voiceStatus,    setVoiceStatus]    = useState<{ stt: boolean; tts: boolean }>({ stt: false, tts: false })
  const [isRecording,    setIsRecording]    = useState(false)
  const [ttsEnabled,     setTtsEnabled]     = useState(false)
  const [recordingTimer, setRecordingTimer] = useState(0)

  // ── Live view data ──────────────────────────────────────────
  const [systemStats,    setSystemStats]    = useState<any>(null)
  const [recentTasks,    setRecentTasks]    = useState<any[]>([])

  // ── Session ID ──────────────────────────────────────────────
  const [sessionId] = useState<string>(() => {
    if (typeof window === 'undefined') return `session_${Date.now()}`
    const stored = sessionStorage.getItem('devos_session')
    if (stored) return stored
    const newId = `session_${Date.now()}`
    sessionStorage.setItem('devos_session', newId)
    return newId
  })

  // ── Settings state ──────────────────────────────────────────
  const [providers,       setProviders]       = useState<any[]>([])
  const [routing,         setRouting]         = useState<any>({ mode: 'auto', fallbackToOllama: true })
  const [addingProvider,  setAddingProvider]  = useState<string | null>(null)
  const [providerKeys,    setProviderKeys]    = useState<Record<string, string>>({})
  const [providerModels,  setProviderModels]  = useState<Record<string, string>>({})
  const [savingKey,       setSavingKey]       = useState(false)

  // ── Knowledge Base state ────────────────────────────────────
  const [knowledgeFiles,    setKnowledgeFiles]    = useState<any[]>([])
  const [knowledgeStats,    setKnowledgeStats]    = useState<any>(null)
  const [uploadingFile,     setUploadingFile]     = useState(false)
  const [uploadCategory,    setUploadCategory]    = useState('general')

  // ── License / Pro state ──────────────────────────────────────
  const [pricingOpen,    setPricingOpen]    = useState(false)
  const [licenseStatus,  setLicenseStatus]  = useState<{
    active: boolean; isPro: boolean; plan: string; expiresAt: string;
    features: Record<string, boolean | number>; tier: string; email: string; expiry: number
  }>({ active: false, isPro: false, plan: 'free', expiresAt: '', features: {}, tier: 'free', email: '', expiry: 0 })
  const [activatingKey,  setActivatingKey]  = useState(false)   // eslint-disable-line @typescript-eslint/no-unused-vars
  const [licenseKey,     setLicenseKey]     = useState('')
  const [licenseMsg,     setLicenseMsg]     = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  // ── Sprint 19: upgrade nudge toast ───────────────────────────
  const [upgradeToast, setUpgradeToast] = useState<{ message: string; action: string; onAction: () => void } | null>(null)

  // ── Sprint 12: proactive automation suggestions ──────────────
  const [suggestionPattern,  setSuggestionPattern]  = useState<AutomationPattern | null>(null)
  const [suggestionDismissed, setSuggestionDismissed] = useState(false)

  useEffect(() => {
    // Only start polling after 20+ conversations
    const convCount = messages.filter(m => m.role === 'user').length
    if (convCount < 20 || suggestionDismissed) return

    const check = () => {
      fetch('http://localhost:4200/api/cognition/suggestions')
        .then(r => r.json())
        .then((d: any) => {
          const patterns: AutomationPattern[] = d.patterns ?? []
          if (patterns.length > 0 && !suggestionDismissed) {
            setSuggestionPattern(patterns[0])
          }
        })
        .catch(() => {})
    }

    check()
    const timer = setInterval(check, 5 * 60 * 1000) // re-check every 5 minutes
    return () => clearInterval(timer)
  }, [messages.length, suggestionDismissed]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Refs ────────────────────────────────────────────────────
  const inputRef         = useRef<HTMLTextAreaElement>(null)
  const kbInputRef       = useRef<HTMLInputElement>(null)
  const messagesEndRef   = useRef<HTMLDivElement>(null)
  const logsEndRef       = useRef<HTMLDivElement>(null)
  const knowledgeInputRef= useRef<HTMLInputElement>(null)
  const conversationMessagesRef = useRef(new Map<string, Message[]>());

  // ── Auto-switch modes based on execution state ──────────────
  useEffect(() => {
    if (isExecuting) {
      setUIMode('execution')
      setLiveViewOpen(true)
      setActivityOpen(true)
    } else if (uiMode === 'execution') {
      const t = setTimeout(() => {
        setUIMode('focus')
        setLiveViewOpen(false)
      }, 3000)
      return () => clearTimeout(t)
    }
  }, [isExecuting])

  // ── Voice availability check ─────────────────────────────────
  useEffect(() => {
    fetch('http://localhost:4200/api/voice/status')
      .then(r => r.json())
      .then(data => setVoiceStatus(data))
      .catch(() => {})
  }, [])

  // ── Auto-speak Aiden responses when TTS enabled ──────────────
  useEffect(() => {
    if (!ttsEnabled) return
    const lastMsg = messages[messages.length - 1]
    if (lastMsg?.role === 'assistant' && !(lastMsg as any).isStreaming && lastMsg.content) {
      fetch('http://localhost:4200/api/voice/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: lastMsg.content }),
      }).catch(() => {})
    }
  }, [messages, ttsEnabled])

  // ── Load license status on mount ────────────────────────────
  useEffect(() => {
    const refreshLicense = () => {
      Promise.all([
        fetch('http://localhost:4200/api/license/status').then(r => r.json()).catch(() => ({})),
        fetch('http://localhost:4200/api/license/pro-status').then(r => r.json()).catch(() => ({})),
      ]).then(([old, pro]) => {
        setLicenseStatus({
          active:    !!(pro.isPro || old.active),
          isPro:     !!pro.isPro,
          plan:      pro.plan      || (old.active ? 'pro_legacy' : 'free'),
          expiresAt: pro.expiresAt || '',
          features:  pro.features  || {},
          tier:      old.tier      || (pro.isPro ? 'pro' : 'free'),
          email:     old.email     || '',
          expiry:    old.expiry    || 0,
        })
      })
    }
    refreshLicense()
  }, [])

  // ── Load conversations from localStorage + backend ───────────
  useEffect(() => {
    let loaded: Conversation[] = []
    try {
      const saved = localStorage.getItem('devos_conversations')
      if (saved) {
        const parsed = JSON.parse(saved)
        if (Array.isArray(parsed)) loaded = parsed
      }
    } catch {}
    conversationsRef.current = loaded
    setConversations(loaded)
    setConversationsHydrated(true)
    // Fetch backend sessions and merge in any not already in localStorage
    aiden.listSessions()
      .then((sessions) => {
        if (!sessions.length) return
        setConversations(prev => {
          const existingIds = new Set(prev.map((c: Conversation) => c.id))
          const fromBackend = sessions
            .filter(s => !existingIds.has(s.id))
            .map(s => ({ id: s.id, title: s.label || 'Untitled', timestamp: s.lastActive, messages: [] as Message[] }))
          const next = fromBackend.length > 0
            ? [...prev, ...fromBackend].sort((a: Conversation, b: Conversation) => b.timestamp - a.timestamp)
            : prev
          conversationsRef.current = next
          return next
        })
      })
      .catch(() => {})
  }, [])

  // ── Save conversations to localStorage ──────────────────────
  useEffect(() => {
    conversationsRef.current = conversations
    try { localStorage.setItem('devos_conversations', JSON.stringify(conversations)) } catch {}
  }, [conversations])

  // Screenshot polling is handled inside LiveViewPanel (adaptive 800ms/3000ms)

  // ── Load system stats + recent tasks (idle) ─────────────────
  useEffect(() => {
    if (isExecuting) return
    Promise.all([
      fetch('http://localhost:4200/api/memory').then(r => r.json()).catch(() => null),
      fetch('http://localhost:4200/api/tasks').then(r => r.json()).catch(() => []),
    ]).then(([mem, tasks]) => {
      setSystemStats(mem)
      setRecentTasks(Array.isArray(tasks) ? tasks.slice(0, 3) : [])
    })
  }, [isExecuting])

  // ── Load providers when settings opens ──────────────────────
  useEffect(() => {
    if (!settingsOpen) return
    fetch('http://localhost:4200/api/providers')
      .then(r => r.json())
      .then((d: any) => { setProviders(d.apis || []); setRouting(d.routing || {}) })
      .catch(() => {})
    fetch('http://localhost:4200/api/knowledge')
      .then(r => r.json())
      .then((d: any) => setKnowledgeFiles(Array.isArray(d.files) ? d.files : []))
      .catch(() => {})
    fetch('http://localhost:4200/api/knowledge/stats')
      .then(r => r.json())
      .then((d: any) => setKnowledgeStats(d))
      .catch(() => {})
  }, [settingsOpen])

  // ── Keyboard shortcuts ──────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); startNewChat() }
      if (e.key === 'Escape') {
        if (uiMode === 'watch') setUIMode('focus')
        if (settingsOpen) setSettingsOpen(false)
        if (plusMenuOpen) { setPlusMenuOpen(false); setActiveSubmenu(null); setMiniPrompt(null) }
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'p') {
        e.preventDefault()
        setUIMode(m => m === 'power' ? 'focus' : 'power')
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [uiMode, settingsOpen])

  // ── Grid columns ────────────────────────────────────────────
  // ── License helpers ─────────────────────────────────────────
  const refreshLicenseStatus = useCallback(() => {
    Promise.all([
      fetch('http://localhost:4200/api/license/status').then(r => r.json()).catch(() => ({})),
      fetch('http://localhost:4200/api/license/pro-status').then(r => r.json()).catch(() => ({})),
    ]).then(([old, pro]) => {
      setLicenseStatus({
        active:    !!(pro.isPro || old.active),
        isPro:     !!pro.isPro,
        plan:      pro.plan      || (old.active ? 'pro_legacy' : 'free'),
        expiresAt: pro.expiresAt || '',
        features:  pro.features  || {},
        tier:      old.tier      || (pro.isPro ? 'pro' : 'free'),
        email:     old.email     || '',
        expiry:    old.expiry    || 0,
      })
    })
  }, [])

  const validateKey = useCallback(async (key: string): Promise<{ success: boolean; error?: string }> => {
    setActivatingKey(true)
    setLicenseMsg(null)
    try {
      const res  = await fetch('http://localhost:4200/api/license/activate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
      })
      const data = await res.json()
      setActivatingKey(false)
      if (data.success) {
        refreshLicenseStatus()
        setLicenseMsg({ type: 'success', text: '✓ Pro activated! All limits removed.' })
        setLicenseKey('')
        return { success: true }
      } else {
        setLicenseMsg({ type: 'error', text: data.error || 'Invalid key' })
        return { success: false, error: data.error }
      }
    } catch (e: any) {
      setActivatingKey(false)
      setLicenseMsg({ type: 'error', text: `Server error: ${e.message}` })
      return { success: false, error: e.message }
    }
  }, [refreshLicenseStatus])

  const clearProLicense = useCallback(async () => {
    await fetch('http://localhost:4200/api/license/deactivate', { method: 'POST' }).catch(() => {})
    setLicenseStatus(s => ({ ...s, active: false, isPro: false, plan: 'free', expiresAt: '', features: {} }))
    setLicenseMsg({ type: 'success', text: 'Machine deactivated. License slot freed.' })
  }, [])

  // ── Conversation helpers ────────────────────────────────────
  const startNewChat = useCallback(() => {
    const id = `conv_${Date.now()}`
    workbenchControllerRef.current.newChat(id)
    publishController()
    setMainView('chat')
    setCurrentConvId(id)
    setMessages([])
    setLiveActivity([])
    setRunProjection(null)
    setRunArtifacts([])
    setAttachments([])
    setActiveJobId(null)
    setActiveAttemptId(null)
    setActiveRunId(null)
    activeRunIdRef.current = null
    setIsExecuting(false)
    setIsStreaming(false)
    setThinking(null)
    setBudget(null)
    if (typeof window !== 'undefined') window.history.pushState(window.history.state, '', window.location.pathname)
  }, [publishController])

  const clearCurrentView = useCallback(() => {
    setMessages([])
    setActivityLogs([])
    setLiveActivity([])
    setRunProjection(null)
    setRunArtifacts([])
    setThinking(null)
    setBudget(null)
  }, [])

  const refreshProjection = useCallback(() => {
    setProjectionRevision((revision) => revision + 1)
  }, [])

  const addAttachmentFiles = useCallback(async (files: readonly File[]) => {
    const pending = Array.from(files).slice(0, Math.max(0, 10 - attachments.length))
    if (pending.length === 0) return
    try {
      const uploaded = await Promise.all(pending.map((file) => aiden.uploadAttachment(file)))
      setAttachments((current) => [...current, ...uploaded].slice(0, 10))
    } catch (error) {
      setMessages((current) => [...current, {
        id: `attachment_error_${Date.now()}`,
        role: 'assistant',
        content: `Attachment could not be added: ${error instanceof Error ? error.message : String(error)}`,
        timestamp: Date.now(),
        isStreaming: false,
      }])
    }
  }, [attachments.length])

  const removeAttachment = useCallback((id: string) => {
    setAttachments((current) => current.filter((attachment) => attachment.id !== id))
  }, [])

  const loadConversation = useCallback((id: string) => {
    const conv = conversations.find(c => c.id === id)
    if (conv) {
      const selection = conv.jobId
        ? { sessionId: conv.sessionId ?? conv.id, jobId: conv.jobId, attemptId: conv.attemptId ?? null, runId: conv.runId ?? null }
        : emptySelection(conv.sessionId ?? conv.id)
      selectContext(selection)
      setCurrentConvId(id)
      setMessages(conv.messages)
      setLiveActivity(selection.jobId ? (liveActivityByJobRef.current.get(selection.jobId) ?? []) : [])
      setActiveJobId(selection.jobId)
      setActiveAttemptId(selection.attemptId)
      setActiveRunId(selection.runId)
      activeRunIdRef.current = selection.runId
      syncForegroundLifecycle(selection.jobId)
    }
  }, [conversations, selectContext, syncForegroundLifecycle])

  const selectActiveJob = useCallback((job: ReturnType<WorkbenchController['active']>[number]) => {
    selectContext({ sessionId: job.sessionId, jobId: job.jobId, attemptId: job.attemptId, runId: job.runId })
    setCurrentConvId(job.sessionId || job.jobId)
    setActiveJobId(job.jobId)
    setActiveAttemptId(job.attemptId)
    setActiveRunId(job.runId)
    activeRunIdRef.current = job.runId
    const stored = conversationMessagesRef.current.get(job.sessionId || job.jobId)
    setMessages(stored ?? [])
    setLiveActivity(liveActivityByJobRef.current.get(job.jobId) ?? [])
    syncForegroundLifecycle(job.jobId)
  }, [selectContext, syncForegroundLifecycle])

  const saveToConversation = useCallback((msgs: Message[]) => {
    const title = msgs.find(m => m.role === 'user')?.content.slice(0, 40) || 'New Chat'
    setConversations(prev => {
      const existing = prev.find(c => c.id === currentConvId)
      if (existing) return prev.map(c => c.id === currentConvId ? { ...c, messages: msgs } : c)
      return [{ id: currentConvId, title, timestamp: Date.now(), messages: msgs }, ...prev]
    })
  }, [currentConvId])

  // ── Stop execution ───────────────────────────────────────────
  const stopExecution = useCallback(async () => {
    const rid = workbenchControllerRef.current.snapshot().selected.runId ?? activeRunIdRef.current
    if (rid == null) return
    const accepted = await aiden.cancelTask(rid)
    setThinking(accepted
      ? { stage: 'cancelling', message: 'Cancellation requested…' }
      : { stage: 'working', message: 'Cancellation was not accepted; work is still running.' })
  }, [])

  // ── Send message ────────────────────────────────────────────
  const sendMessage = useCallback(async (overrideText?: string) => {
    const text = (overrideText ?? input).trim() || (attachments.length > 0 ? 'Review the attached file(s).' : '')
    if (!text || (isStreaming && selectedContext.jobId !== null)) return
    if (!executionAvailable || workbenchReadOnly) {
      setMessages((current) => [...current, {
        id: `runtime_unavailable_${Date.now()}`,
        role: 'assistant',
        content: workbenchReadOnly
          ? 'This Workbench is read-only.'
          : 'Task execution is unavailable. Configure a provider with the Aiden CLI, then restart Workbench.',
        timestamp: Date.now(),
        isStreaming: false,
      }])
      return
    }
    const requestSessionId = currentConvId || sessionId
    if (selectedContext.sessionId !== requestSessionId || selectedContext.jobId !== null) {
      selectContext(emptySelection(requestSessionId), true)
    }
    let admittedJobId: string | null = null
    let admittedAttemptId: string | null = null
    let admittedRunId: number | null = null
    const isForeground = () => {
      const selected = workbenchControllerRef.current.snapshot().selected
      return selected.sessionId === requestSessionId
        && (admittedJobId === null || selected.jobId === admittedJobId)
    }

    const attachmentSnapshot = [...attachments]
    const userMsg: Message = {
      id: `msg_${Date.now()}`, role: 'user',
      content: text, timestamp: Date.now(), attachments: attachmentSnapshot,
    }
    const newMessages = [...messages, userMsg]
    conversationMessagesRef.current.set(requestSessionId, newMessages)
    setMessages(newMessages)
    if (!overrideText) setInput('')
    setAttachments([])
    setLiveActivity([])
    if (!overrideText && inputRef.current) inputRef.current.style.height = 'auto'
    setIsStreaming(true)
    setIsExecuting(true)
    setThinking({ stage: 'understanding', message: 'Understanding…' })

    const thinkingId = `thinking_${Date.now()}`
    setMessages(m => [...m, { id: thinkingId, role: 'assistant', content: '', timestamp: Date.now(), isStreaming: true }])

    let fullReply = ''
    let turnMessages = [...newMessages, { id: thinkingId, role: 'assistant' as const, content: '', timestamp: Date.now(), isStreaming: true }]
    conversationMessagesRef.current.set(requestSessionId, turnMessages)
    activeRunIdRef.current = null
    setActiveRunId(null)
    const followController = new AbortController()
    activeRunFollowAbortRef.current = followController
    activeRunFollowControllersRef.current.add(followController)

    const nowTime = () => new Date().toLocaleTimeString('en', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
    const pushActivity = (icon: string, message: string, style: ActivityLog['style']) => {
      if (!isForeground()) return
      setActivityLogs(prev => [...prev.slice(-199), { time: nowTime(), icon, agent: 'Aiden', message, style }])
    }
    const persistTurn = () => {
      conversationMessagesRef.current.set(requestSessionId, turnMessages)
      setConversations(prev => {
        const existing = prev.find(c => c.id === requestSessionId)
        if (existing) return prev.map(c => c.id === requestSessionId ? {
          ...c, messages: turnMessages, timestamp: Date.now(),
          jobId: admittedJobId ?? c.jobId,
          attemptId: admittedAttemptId ?? c.attemptId,
          runId: admittedRunId ?? c.runId,
          sessionId: requestSessionId,
        } : c)
        return [{
          id: requestSessionId, title: userMsg.content.slice(0, 40), timestamp: Date.now(),
          messages: turnMessages, sessionId: requestSessionId,
          jobId: admittedJobId ?? undefined,
          attemptId: admittedAttemptId ?? undefined,
          runId: admittedRunId ?? undefined,
        }, ...prev]
      })
      if (isForeground()) { setMessages(turnMessages); saveToConversation(turnMessages) }
    }

    // Send onto the v4 safe job path; stream the reply + activity back. Tool calls
    // and verified/unverified verdicts go to the Activity view, NOT the chat.
    await aiden.runTask(userMsg.content, {
      onAdmission: (admission) => {
        const attachToForeground = shouldAttachAdmission(
          workbenchControllerRef.current.snapshot().selected,
          requestSessionId,
        )
        admittedJobId = admission.jobId
        admittedAttemptId = admission.attemptId
        admittedRunId = admission.runId
        workbenchControllerRef.current.register(admission, requestSessionId, userMsg.content)
        publishController()
        if (attachToForeground) {
          activeRunIdRef.current = admission.runId
          setActiveJobId(admission.jobId)
          setActiveAttemptId(admission.attemptId)
          setActiveRunId(admission.runId)
          selectContext({ sessionId: requestSessionId, jobId: admission.jobId, attemptId: admission.attemptId, runId: admission.runId }, true)
        }
      },
      onRunId:    (rid) => { if (isForeground()) { activeRunIdRef.current = rid; setActiveRunId(rid) } },
      onThinking: (stage, message) => { if (isForeground()) setThinking({ stage, message }) },
      onReply:    (chunk) => {
        if (isForeground()) setThinking(null)
        fullReply += chunk
        turnMessages = turnMessages.map(msg => msg.id === thinkingId ? { ...msg, content: fullReply, isStreaming: true } : msg)
        conversationMessagesRef.current.set(requestSessionId, turnMessages)
        if (isForeground()) setMessages(turnMessages)
      },
      onReplySnapshot: (content) => {
        if (isForeground()) setThinking(null)
        fullReply = content
        turnMessages = turnMessages.map(msg => msg.id === thinkingId ? { ...msg, content, isStreaming: true } : msg)
        conversationMessagesRef.current.set(requestSessionId, turnMessages)
        if (isForeground()) setMessages(turnMessages)
      },
      onActivity: (a) => {
        if (admittedJobId) recordLiveActivity(admittedJobId, a, isForeground())
        const style: ActivityLog['style'] =
          a.status === 'ok' ? 'ok' : (a.status === 'failed' || a.status === 'warn') ? 'err' : 'active'
        const icon = a.kind === 'verify'
          ? (a.status === 'ok' ? '✓' : '⚠')
          : a.status === 'failed' ? '✗' : a.status === 'running' ? '▸' : '✓'
        pushActivity(icon, a.label + (a.detail ? ` · ${a.detail}` : ''), style)
      },
      onTokens: (total) => { if (isForeground()) setBudget({ current: total, max: 0, remaining: 0 }) },
      onDone: (info) => {
        if (admittedJobId && admittedAttemptId && admittedRunId !== null) {
          aiden.clearRunHandle({ jobId: admittedJobId, attemptId: admittedAttemptId, runId: admittedRunId })
        }
        if (admittedJobId) {
          workbenchControllerRef.current.settle(admittedJobId)
          publishController()
        }
        if (activeRunFollowAbortRef.current === followController) activeRunFollowAbortRef.current = null
        activeRunFollowControllersRef.current.delete(followController)
        if (isForeground()) { setThinking(null); setBudget(null); setIsExecuting(false); setIsStreaming(false) }
        const finalContent = fullReply
          || (info.stopped
            ? '_Stopped._'
            : '_Task completed — no written reply was emitted. Open the **Activity** tab to see what ran._')
        const finalMsg: Message = { id: thinkingId, role: 'assistant', content: finalContent, timestamp: Date.now(), isStreaming: false }
        turnMessages = turnMessages.map(m => m.id === thinkingId ? finalMsg : m)
        persistTurn()
        if (isForeground()) refreshProjection()
      },
      onError: (message) => {
        if (admittedJobId && admittedAttemptId && admittedRunId !== null) {
          aiden.clearRunHandle({ jobId: admittedJobId, attemptId: admittedAttemptId, runId: admittedRunId })
        }
        if (admittedJobId) {
          workbenchControllerRef.current.settle(admittedJobId)
          publishController()
        }
        if (activeRunFollowAbortRef.current === followController) activeRunFollowAbortRef.current = null
        activeRunFollowControllersRef.current.delete(followController)
        if (isForeground()) { setThinking(null); setBudget(null); setIsExecuting(false); setIsStreaming(false) }
        turnMessages = turnMessages.map(msg => msg.id === thinkingId
          ? { ...msg, content: fullReply || `⚠ ${message}`, isStreaming: false }
          : msg)
        persistTurn()
        if (isForeground()) refreshProjection()
      },
    }, { signal: followController.signal }, {
      sessionId: requestSessionId,
      attachmentIds: attachmentSnapshot.map((attachment) => attachment.id),
    })
  }, [input, attachments, isStreaming, messages, saveToConversation, selectedContext, currentConvId, sessionId, selectContext, publishController, executionAvailable, workbenchReadOnly, refreshProjection, recordLiveActivity])

  // ── Quick upload (chat + button) ────────────────────────────
  const handleQuickUpload = useCallback(async (e: ChangeEvent<HTMLInputElement>) => {
    await addAttachmentFiles(Array.from(e.target.files ?? []))
    if (kbInputRef.current) kbInputRef.current.value = ''
  }, [addAttachmentFiles])

  // ── Settings: API Key handlers ──────────────────────────────
  const saveKey = useCallback(async (providerID: string) => {
    const key   = (providerKeys[providerID] || '').trim()
    const model = providerModels[providerID] || ''
    if (!key) return
    setSavingKey(true)
    try {
      await fetch('http://localhost:4200/api/providers/add', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: providerID, key, model: model || undefined }),
      })
      setProviderKeys(prev => { const n = { ...prev }; delete n[providerID]; return n })
      setProviderModels(prev => { const n = { ...prev }; delete n[providerID]; return n })
      setAddingProvider(null)
      const d = await fetch('http://localhost:4200/api/providers').then(r => r.json()) as any
      setProviders(d.apis || [])
    } catch {}
    setSavingKey(false)
  }, [providerKeys, providerModels])

  const toggleProvider = useCallback(async (name: string, enabled: boolean) => {
    await fetch(`http://localhost:4200/api/providers/${encodeURIComponent(name)}`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    }).catch(() => {})
    setProviders(prev => prev.map((p: any) => p.name === name ? { ...p, enabled } : p))
  }, [])

  const deleteProvider = useCallback(async (name: string) => {
    if (!window.confirm(`Remove ${name}?`)) return
    await fetch(`http://localhost:4200/api/providers/${encodeURIComponent(name)}`, { method: 'DELETE' }).catch(() => {})
    setProviders(prev => prev.filter((p: any) => p.name !== name))
  }, [])

  const resetLimits = useCallback(async () => {
    await fetch('http://localhost:4200/api/providers/reset-limits', { method: 'POST' }).catch(() => {})
    setProviders(prev => prev.map((p: any) => ({ ...p, rateLimited: false })))
  }, [])

  // ── Settings: Knowledge Base handlers ───────────────────────
  const handleKnowledgeUpload = useCallback(async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setUploadingFile(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('category', uploadCategory)

      // Start async upload — get jobId immediately
      const r = await fetch('http://localhost:4200/api/knowledge/upload/async', { method: 'POST', body: fd })
      const d = await r.json() as any
      // Sprint 19: handle free tier limit / upgrade nudge
      if (r.status === 403 && d.upgrade) {
        setUpgradeToast({ message: d.message, action: 'Upgrade to Pro', onAction: () => setPricingOpen(true) })
        setUploadingFile(false)
        return
      }
      if (!d.success) { setUploadingFile(false); return }

      const jobId = d.jobId as string

      // Poll until done or error
      await new Promise<void>((resolve) => {
        const iv = setInterval(async () => {
          try {
            const pr = await fetch(`http://localhost:4200/api/knowledge/progress/${encodeURIComponent(jobId)}`).then(x => x.json()) as any
            if (pr.status === 'done' || pr.status === 'error') { clearInterval(iv); resolve() }
          } catch { clearInterval(iv); resolve() }
        }, 600)
      })

      // Refresh list + stats after completion
      const updated = await fetch('http://localhost:4200/api/knowledge').then(r2 => r2.json()) as any
      setKnowledgeFiles(Array.isArray(updated.files) ? updated.files : [])
      const stats = await fetch('http://localhost:4200/api/knowledge/stats').then(r2 => r2.json()) as any
      setKnowledgeStats(stats)

    } catch {}
    setUploadingFile(false)
    if (knowledgeInputRef.current) knowledgeInputRef.current.value = ''
  }, [uploadCategory])

  const handleKnowledgeDelete = useCallback(async (fileId: string) => {
    if (!window.confirm('Remove this file from knowledge base?')) return
    await fetch(`http://localhost:4200/api/knowledge/${encodeURIComponent(fileId)}`, { method: 'DELETE' }).catch(() => {})
    setKnowledgeFiles(prev => prev.filter((f: any) => f.id !== fileId))
  }, [])

  // ── Plus menu handlers ───────────────────────────────────────
  const takeScreenshot = useCallback(async () => {
    setPlusMenuOpen(false)
    setActiveSubmenu(null)

    const now = new Date().toLocaleTimeString('en', { hour12: false })
    setActivityLogs(prev => [...prev, { time: now, icon: '📷', agent: 'System', message: 'Taking screenshot...', style: 'active' }])

    try {
      await fetch('http://localhost:4200/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'take a screenshot of the current screen and save it', mode: 'auto', sessionId }),
      })
    } catch {}

    let attempts = 0
    const poll = setInterval(async () => {
      attempts++
      try {
        const r = await fetch('http://localhost:4200/api/screenshot?' + Date.now())
        if (r.ok) {
          const blob = await r.blob()
          if (blob.size > 0) {
            const url = URL.createObjectURL(blob)
            setScreenshot(url)
            setLiveViewOpen(true)
            clearInterval(poll)
            const t = new Date().toLocaleTimeString('en', { hour12: false })
            setActivityLogs(prev => [...prev, { time: t, icon: '✓', agent: 'System', message: 'Screenshot captured', style: 'ok' }])
          }
        }
      } catch {}
      if (attempts > 10) clearInterval(poll)
    }, 800)
  }, [sessionId, setPlusMenuOpen, setActiveSubmenu, setActivityLogs, setScreenshot, setLiveViewOpen])

  const submitMiniPrompt = useCallback(() => {
    if (!miniPromptValue.trim() || !miniPrompt) return

    const val = miniPromptValue.trim()
    setPlusMenuOpen(false)
    setActiveSubmenu(null)
    setMiniPrompt(null)
    setMiniPromptValue('')

    if (miniPrompt.type === 'stocks') {
      // Stocks: use direct phrasing and send
      sendMessage(`get stock data for ${val}`)
    } else {
      const prefixes: Record<string, string> = {
        websearch: 'Search the web for:',
        research:  'Do deep research on:',
      }
      sendMessage(`${prefixes[miniPrompt.type] ?? ''} ${val}`.trim())
    }
  }, [miniPromptValue, miniPrompt, sendMessage])

  // ── Voice recording handler ──────────────────────────────────
  const startRecording = useCallback(async () => {
    if (isRecording || isStreaming) return
    setIsRecording(true)
    setRecordingTimer(5)

    // Countdown display
    const countdown = setInterval(() => {
      setRecordingTimer(t => {
        if (t <= 1) { clearInterval(countdown); return 0 }
        return t - 1
      })
    }, 1000)

    try {
      // Record 5 seconds of audio
      const r1   = await fetch('http://localhost:4200/api/voice/record', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ duration: 5000 }),
      })
      const { path: audioPath } = await r1.json()

      // Transcribe
      const r2   = await fetch('http://localhost:4200/api/voice/transcribe', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ path: audioPath }),
      })
      const { text } = await r2.json()

      if (text?.trim()) {
        setInput(text.trim())
        setTimeout(() => sendMessage(text.trim()), 300)
      }
    } catch (e) {
      console.error('[Voice] Recording error:', e)
    } finally {
      clearInterval(countdown)
      setIsRecording(false)
      setRecordingTimer(0)
    }
  }, [isRecording, isStreaming, sendMessage])

  // ── Context value ───────────────────────────────────────────
  const ctxValue: DevOSCtxType = {
    uiMode, setUIMode, execMode, setExecMode,
    historyOpen, setHistoryOpen, liveViewOpen, setLiveViewOpen, collapseLiveExecution, reopenLiveExecution,
    activityOpen, setActivityOpen, settingsOpen, setSettingsOpen,
    settingsTab, setSettingsTab, mainView, setMainView, appearance, setAppearance,
    isExecuting, isStreaming, thinking, budget, activeModel, activeProvider, runtimeConnection, runtimeVersion, runtimeEdition,
    executionAvailable, executionQueue, workbenchReadOnly,
    runProjection, runArtifacts, capabilities, browserSession, controlBrowser,
    liveExecution, liveExecutionSelection, selectLiveExecutionSurface, toggleLiveExecutionPin,
    selectedContext, activeJobs: workbenchControllerRef.current.active(),
    presence, presenceBriefing, refreshPresence,
    messages, setMessages, conversations, setConversations, currentConvId,
    input, setInput,
    activityLogs, setActivityLogs, liveActivity, screenshot, setScreenshot, sessionId,
    systemStats, recentTasks,
    sendMessage, stopExecution, startNewChat, loadConversation,
    selectActiveJob,
    handleQuickUpload,
    addAttachmentFiles, attachments, removeAttachment, refreshProjection, clearCurrentView,
    inputRef, kbInputRef, messagesEndRef, logsEndRef,
    // Plus menu
    plusMenuOpen, setPlusMenuOpen,
    activeSubmenu, setActiveSubmenu,
    channelStatuses,
    channelModal, setChannelModal,
    miniPrompt, setMiniPrompt,
    miniPromptValue, setMiniPromptValue,
    takeScreenshot, submitMiniPrompt,
    // Voice
    voiceStatus, isRecording, ttsEnabled, setTtsEnabled, recordingTimer, startRecording,
    // API keys
    providers, routing, addingProvider, setAddingProvider,
    providerKeys, setProviderKeys, providerModels, setProviderModels,
    savingKey, saveKey, toggleProvider, deleteProvider, resetLimits,
    // Knowledge base
    knowledgeFiles, knowledgeStats, uploadingFile,
    uploadCategory, setUploadCategory, knowledgeInputRef,
    handleKnowledgeUpload, handleKnowledgeDelete,
    // License / Pro
    pricingOpen, setPricingOpen,
    licenseStatus, licenseKey, setLicenseKey,
    activatingKey, licenseMsg, setLicenseMsg,
    validateKey, clearProLicense,
    // Update banner
    updateBanner, setUpdateBanner,
    controllerRevision,
  }

  // ── Loading splash ──────────────────────────────────────────
  if (onboardingDone === null) return (
    <div style={{
      height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--bg)', color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 12,
    }}>
      loading...
    </div>
  )

  // ── Dashboard ───────────────────────────────────────────────
  return (
    <DevOSCtx.Provider value={ctxValue}>
      <div style={{
        display: 'flex', flexDirection: 'column',
        height: '100vh', background: 'var(--bg)',
        color: 'var(--text)', fontFamily: 'var(--sans)', overflow: 'hidden',
      }}>
        <NavBar />
        {updateBanner && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '6px 16px', background: 'rgba(251,146,60,0.12)',
            borderBottom: '1px solid rgba(251,146,60,0.3)',
            fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--orange)',
          }}>
            <span>🚀</span>
            <span style={{ flex: 1 }}>
              Update available: <strong>v{updateBanner.version}</strong> —{' '}
              <span
                onClick={() => { setSettingsOpen(true); setSettingsTab('updates') }}
                style={{ cursor: 'pointer', textDecoration: 'underline' }}>
                View in Settings
              </span>
            </span>
            <button onClick={() => setUpdateBanner(null)} style={{
              background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer',
              fontSize: 14, padding: '0 4px', lineHeight: 1,
            }}>✕</button>
          </div>
        )}
        {/* Headless connector — keeps WebSocket alive for briefings */}
        <LiveViewPanel />
        <div className={`workbench-grid ${historyOpen ? 'sidebar-open' : 'sidebar-closed'} ${liveViewOpen && liveExecution?.surfaces.length ? 'live-execution-open' : ''}`} style={{
          flex: 1, display: 'grid', overflow: 'hidden',
          transition: 'grid-template-columns 0.3s cubic-bezier(0.22,1,0.36,1)',
        }}>
          <HistorySidebar />
          <div className="workbench-main" style={{ display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>
            <div style={{ flex: 1, minHeight: 0, display: mainView === 'chat' ? 'flex' : 'none', flexDirection: 'column' }}>
              <ChatPanel />
            </div>
            {mainView === 'activity' && (
              <ActivityView
                logs={activityLogs}
                jobId={activeJobId}
                attemptId={activeAttemptId}
                runId={activeRunId}
                onContinued={(jobId, attemptId, runId) => {
                  setActiveJobId(jobId)
                  setActiveAttemptId(attemptId)
                  setActiveRunId(runId)
                  activeRunIdRef.current = runId
                }}
              />
            )}
            {mainView === 'artifacts' && <ArtifactsView />}
            {mainView === 'apps' && <AppsView />}
            {mainView === 'automations' && <AutomationsView />}
            {mainView === 'sponsors' && <SponsorsView />}
            {!liveViewOpen && liveExecution?.surfaces.length ? (
              <button type="button" className="live-execution-reopen" onClick={reopenLiveExecution}>Open Live Execution</button>
            ) : null}
          </div>
          {mainView === 'chat' && <LiveExecutionPane />}
        </div>
        <StatusBar />
        {settingsOpen && <SettingsDrawer />}
        {channelModal && <ChannelModal />}
        {pricingOpen && (
          <PricingModal
            onClose={() => { setPricingOpen(false); setLicenseMsg(null) }}
            onActivate={validateKey}
            currentStatus={licenseStatus}
          />
        )}
        {upgradeToast && (
          <UpgradeToast
            message={upgradeToast.message}
            action={upgradeToast.action}
            onAction={upgradeToast.onAction}
            onDismiss={() => setUpgradeToast(null)}
          />
        )}
        {suggestionPattern && !suggestionDismissed && (
          <PatternSuggestionBanner
            pattern={suggestionPattern}
            onDismiss={() => { setSuggestionDismissed(true); setSuggestionPattern(null) }}
            onSetup={(goal) => { /* handled inside banner */ }}
            onUpgrade={(message) => setUpgradeToast({ message, action: 'Upgrade to Pro', onAction: () => setPricingOpen(true) })}
          />
        )}
        {onboardingDone === false && (
          <OnboardingModal
            onOpenSettings={(tab) => { setSettingsTab(tab); setSettingsOpen(true) }}
            onOpenApps={() => { setMainView('apps') }}
            onComplete={(choice) => {
              window.localStorage.setItem('aiden:first-run:v1', 'complete')
              if (choice === 'Work with Apps') setMainView('apps')
              setOnboardingDone(true)
            }}
          />
        )}
      </div>
    </DevOSCtx.Provider>
  )
}
