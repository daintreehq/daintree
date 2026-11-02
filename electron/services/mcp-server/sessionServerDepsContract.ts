import type { AgentState } from "../../../shared/types/agent.js";
import type { TerminalHandback } from "../../../shared/types/handback.js";
import type { AuditOutcome } from "./auditLog.js";
import type { McpDispatchAuthorization } from "../../../shared/types/ipc/mcpServer.js";
import type { HelpAssistantTier, McpTier, DispatchEnvelope } from "./shared.js";
import type { McpWorkspaceBinding } from "./shared.js";
import type { OwnPane, TerminalNotifyHandlers } from "./terminalNotify.js";
import type { ReplyWaiterService } from "./replyWaiter.js";
import type { CodexQuotaResult } from "../../../shared/types/ipc/agentQuota.js";
import type { HostControlAccess } from "./hostControlTools.js";
import type {
  AssistantCaller,
  AssistantTerminalControl,
} from "../assistants/AssistantTerminalControl.js";
import type { SessionStore } from "./sessionStore.js";

/**
 * The main-process executors an owned tool can name. Kept apart from the rest
 * of {@link SessionServerDeps} so a registry entry can only point at one of
 * these, never at some unrelated dep.
 */
export interface OwnedMainExecutors {
  /**
   * Read the last message the agent in an owned panel wrote to its own
   * transcript (#12479). Given the checked id and the read options its entry's
   * `readOptions` validated (#12496), and nothing else the caller sent.
   */
  handleTerminalReadLastMessageOwned: (
    terminalId: string,
    options: import("../../../shared/types/agentLastMessage.js").AgentLastMessageReadOptions,
    signal: AbortSignal
  ) => Promise<import("../../../shared/types/agentLastMessage.js").AgentLastMessageResult>;
}

/** The pty-host's observations about one terminal that decide the assistant's close. */
export interface TerminalCloseContext {
  /** Absent for a terminal with no agent attached. */
  agentState?: AgentState;
  lastHandback?: Pick<TerminalHandback, "observedAt">;
  lastTypedInputAt?: number;
}

/**
 * Whether the agent printed the handback it was asked for and nothing has been
 * typed into it since (#13128). A tie asks: a millisecond clock cannot order
 * the two.
 */
export function isHandedBackUntouched(context: TerminalCloseContext): boolean {
  const observedAt = context.lastHandback?.observedAt;
  if (typeof observedAt !== "number" || !Number.isFinite(observedAt)) return false;
  const typedAt = context.lastTypedInputAt;
  return typedAt === undefined || typedAt < observedAt;
}

export interface SessionServerDeps extends OwnedMainExecutors {
  sessionStore: SessionStore;
  /**
   * The workspace this session was bound to at handshake (#11789), echoed in
   * the `initialize` result so a client can verify where its calls will land
   * before issuing a mutation. Absent for unbound sessions.
   */
  workspaceBinding?: McpWorkspaceBinding;
  /**
   * An agent pane's launch view (#12486), which its route prefers while the
   * view still shows the bound workspace. Read by the binding resource so it
   * reports the route calls actually take. Absent for every other session.
   */
  preferredWebContentsId?: number;
  requestManifest: () => Promise<import("../../../shared/types/actions.js").ActionManifestEntry[]>;
  dispatchAction: (
    actionId: string,
    args: unknown,
    confirmed?: boolean,
    /**
     * What pre-authorized a `confirmed` dispatch, passed only for the skip
     * preference (#12874) — the one reason the renderer treats differently,
     * since it alone also waives the typed-name gate on a force delete.
     */
    authorization?: McpDispatchAuthorization,
    /**
     * A relayed call's callId from its Shell (#13493), passed only for a
     * relayed session, so an approval the call needs asks about this very
     * call (#13501).
     */
    relayCallId?: string
  ) => Promise<DispatchEnvelope>;
  /**
   * Take the user to a run, and bring the window it lands in with them
   * (#12315), reporting whether that window actually came forward.
   *
   * `terminal.revealOwned` is the only caller, and it needs this rather than
   * `dispatchAction` for a reason that is easy to get backwards. A bound
   * session's dispatches land in its own workspace's view — exactly the view a
   * reveal is trying to bring forward — so the reveal would ask a cached,
   * detached renderer to switch to itself, and the visible view it replaced
   * would be detached with nothing to persist its drafts. The bridge picks the
   * view being replaced instead, in the window that already holds the
   * destination, and raises that same window once the dispatch lands.
   *
   * Optional: without it a reveal falls back to the ordinary dispatch, which is
   * the right target for every session except a bound one, and raises nothing.
   */
  revealOwnedRun?: (
    workspaceId: string | undefined,
    actionId: string,
    args: unknown,
    confirmed?: boolean
  ) => Promise<{ envelope: DispatchEnvelope; raised: boolean }>;
  /**
   * Put a call to the user without running it (#12692). Supplied only for an
   * agent pane, and its presence is what makes the session one: a pane's
   * project tier is the line below which calls run without asking, and above
   * which they ask here instead of being refused. Every other session's tier
   * stays a hard ceiling.
   *
   * Resolves with the dialog's decision in `confirmationDecision` (and
   * `approvalScope` when the user chose to keep allowing the tool); rejects
   * exactly as `dispatchAction` does when the view cannot be reached.
   */
  requestApproval?: (actionId: string, args: unknown) => Promise<DispatchEnvelope>;
  /**
   * The pane's project "Skip confirmations" setting, captured at launch
   * (#12876). Only read alongside {@link requestApproval}: a session that is
   * not an agent pane never skips a confirmation on it.
   */
  paneSkipConfirmations?: boolean;
  /**
   * Put a close by Daintree's own assistant to the user without running it
   * (#12881): one naming panels the session did not create, or whose agent
   * was last seen working or waiting. Resolves with the dialog's decision and,
   * once approved, the ids the user left checked in
   * `result.result.selectedTargetIds`. Rejects when no window can ask, and the
   * close is then refused. Consulted only for a renderer-owned origin.
   */
  requestCloseApproval?: (actionId: string, args: unknown) => Promise<DispatchEnvelope>;
  handleWaitUntilIdle: (
    rawArgs: unknown,
    signal: AbortSignal,
    options?: { maxTimeoutMs?: number; workspaceId?: string }
  ) => Promise<import("./shared.js").WaitUntilIdleResult>;
  handleWaitUntilIdleBatch: (
    rawArgs: unknown,
    signal: AbortSignal,
    options?: { maxTimeoutMs?: number; workspaceId?: string }
  ) => Promise<import("../../../shared/types/terminalWaitUntilIdle.js").WaitUntilIdleBatchResult>;
  /**
   * Execute `skills.search` in the main process (#10892). The renderer holds no
   * skill data (parsed plugin markdown lives in the main-process registry), so
   * this tool short-circuits renderer dispatch — same rationale as
   * `handleWaitUntilIdle`. Throws {@link McpError} on invalid args.
   */
  handleSkillsSearch: (
    rawArgs: unknown
  ) => import("../../../shared/types/skills.js").SkillSearchResult;
  /**
   * Execute `skills.load` in the main process (#10892). Throws {@link McpError}
   * on invalid args or an unknown skill id.
   */
  handleSkillsLoad: (rawArgs: unknown) => import("../../../shared/types/skills.js").SkillLoadResult;
  /**
   * Execute `project.runCheck` in the main process (#11548). A check spawns a
   * real child process and reports its exit code, so it needs main-process
   * access, a cancellable `AbortSignal` (which cannot cross IPC), and a wait
   * far longer than the 30s renderer-dispatch wall. Throws {@link McpError} on
   * invalid args; throws for any reason the check could not start, and resolves
   * with `passed: false` when it ran and failed.
   */
  handleProjectRunCheck: (
    rawArgs: unknown,
    signal: AbortSignal,
    /** Asked once more right before the spawn; throws to refuse (#13493). */
    authorize?: () => void
  ) => Promise<import("../../../shared/types/projectCheck.js").ProjectCheckRunResult>;
  /**
   * Execute `project.runCommand` in the main process (#13495), for the same
   * reasons as `project.runCheck`. The caller restriction is applied before
   * this is reached. Throws {@link McpError} on invalid args; throws for any
   * reason the command could not start, and resolves when it ran, whatever
   * its exit code.
   */
  handleProjectRunCommand: (
    rawArgs: unknown,
    signal: AbortSignal,
    /** Asked once more right before the spawn; throws to refuse (#13493). */
    authorize?: () => void
  ) => Promise<import("../../../shared/types/projectCommand.js").ProjectCommandRunResult>;
  /**
   * Read `terminal.getStatus` off the pty-host for one workspace, with no
   * renderer (#12316). Used only as a fallback when the bound workspace has no
   * live view: the renderer answer is richer, and this one reports which fields
   * it could not observe. Throws {@link McpError} on invalid args.
   */
  handleTerminalGetStatusViewless: (
    rawArgs: unknown,
    workspaceId: string,
    /** Assistant terminals an assistant caller named and may read (#13496). */
    admittedAssistants?: ReadonlySet<string>
  ) => Promise<import("../../../shared/types/terminalStatus.js").TerminalStatusResult>;
  /**
   * Whether a terminal with this id is already live anywhere in the app, read
   * off the pty-host's spawn tracking rather than any one view's panel store
   * (#12407). A caller-chosen id that names one would be recorded as this
   * session's creation while the original shell keeps running under it.
   */
  isTerminalIdInUse: (terminalId: string) => boolean;
  /**
   * What the pty-host itself observed about a terminal, for the assistant's
   * close (#12881, #13128): `null` for an id it does not track, such as a
   * browser panel. Rejects when the terminal cannot be read. Asked rather than
   * the AgentAvailabilityStore mirror, which each window's startup replaces
   * with an empty one, so a missing entry there says nothing about the agent.
   * Absent, every close of a busy-capable panel asks.
   */
  readTerminalCloseContext?: (terminalId: string) => Promise<TerminalCloseContext | null>;
  /**
   * What the pty-host reports of a closed panel's process, read after a close
   * returns (#14474). Absent, a close answers with `closedIds` alone.
   */
  readClosedPanelProcess?: (
    terminalId: string
  ) => Promise<import("../../../shared/types/panelClose.js").ClosedPanelProcess>;
  /**
   * Wait, bounded, for the processes of panels the caller closed to exit
   * (#15728), optionally ending their trash grace first. The caller has
   * already checked each target against what it closed. Absent,
   * `terminal.waitForExit` refuses: nothing here can observe an exit.
   */
  /**
   * The incarnation running under a terminal id as far as main can tell, or
   * after its exit the one main saw exit (#15728). Read for each close, so the
   * wait after it asks about the process that close reached. Absent, closes
   * are noted with no incarnation, and their waits never match a kept exit.
   */
  terminalGenerationOf?: (terminalId: string) => number | undefined;
  /**
   * Every terminal id main tracks, read before `terminal.closeAll` (which
   * names none) so its closes are noted with the incarnation each reached.
   */
  trackedTerminalIds?: () => readonly string[];
  waitForClosedPanelExits?: (
    targets: readonly import("./closedPanelExits.js").ClosedPanelExitTarget[],
    options: import("./closedPanelExits.js").ClosedPanelExitWaitOptions
  ) => Promise<import("../../../shared/types/terminalExitWait.js").TerminalWaitForExitResult>;
  /**
   * Every terminal record the pty-host holds, trashed ones included, read
   * before `worktree.deleteOwned` runs (#15729). Rejects when the host or any
   * of its shards cannot answer. Absent, every owned worktree delete is
   * refused: no reader is no evidence that nothing runs there.
   */
  readTerminalProcesses?: () => Promise<
    readonly import("./worktreeProcessGuard.js").TerminalProcessRecord[]
  >;
  /**
   * What git reports of a worktree about to be retired (#15737): its status
   * and how many of its commits no remote-tracking ref holds. Rejects on any
   * failure. Absent, every retirement is refused: no reader is no evidence
   * that the worktree is clean.
   */
  readWorktreeGit?: (
    worktreePath: string,
    signal: AbortSignal
  ) => Promise<import("./worktreeRetirementGit.js").WorktreeGitObservation>;
  /**
   * Whether a terminal belongs to the workspace of this session's pinned view,
   * re-resolved on every call (#12883). What admits Daintree's own assistant to
   * `terminal.readLastMessageOwned` for a pane it did not create: it already
   * types into that view's panes, so reading what they ask is no wider. Must
   * answer `false` whenever either side is unknown. Absent, every such read is
   * refused.
   */
  isTerminalInPinnedWorkspace?: (terminalId: string) => Promise<boolean>;
  /**
   * Terminal notices. Optional so fixtures that never exercise them need not
   * stub them; absent, `terminal.notifyWhenIdle` and `notify: true` answer
   * not-eligible.
   */
  terminalNotify?: TerminalNotifyHandlers;
  /**
   * The assistant's reach to this Shell's hosts (#13493), bound to this
   * session's help-session bearer. Absent for every other bearer; then
   * `host.list` and `host.call` are neither listed nor run.
   */
  hostControl?: HostControlAccess;
  /**
   * The caller as an assistant (#13496): one of this machine's help sessions,
   * or another machine's assistant reaching this one through its Shell, with
   * the project it works in. Read per call from the session's own state;
   * null for every other session, an agent pane or an api-key client. Absent,
   * no session is.
   */
  assistantCaller?: () => AssistantCaller | null;
  /** Main's side of one assistant addressing another (#13496); absent, none can. */
  assistantControl?: Pick<
    AssistantTerminalControl,
    | "isAssistantTerminal"
    | "resolve"
    | "list"
    | "start"
    | "submit"
    | "sendKeys"
    | "interrupt"
    | "close"
    | "readReply"
  >;
  /**
   * The global Assistant's steer of a worker it didn't launch (#14551), set
   * only for a session relayed for one: a prompt, keys or an interrupt, each
   * held to the run it names and the person at it, and a reveal of its panel
   * held to the same run (#16096). Absent, nothing widens.
   */
  globalSteer?: Pick<
    import("../assistants/GlobalWorkerSteer.js").GlobalWorkerSteer,
    "prompt" | "keys" | "interrupt" | "reveal"
  >;
  /** This machine's Codex quota, as `agent.readQuota` reports it. */
  readCodexQuota?: () => Promise<CodexQuotaResult>;
  /** Blocking replies for `waitForReply`. Optional; absent, the flag is ignored. */
  replyWaiter?: Pick<ReplyWaiterService, "wait">;
  /**
   * Set for a session another machine's assistant reaches through its Shell
   * (#13493). It is then never offered a `host.*` tool or one of this
   * machine's assistant-panel tools, whatever its tier or grants, so a relay
   * never chains through here to another host.
   */
  relay?: {
    shellName: string;
    /** The calling Shell's global Assistant (#14545), as its relay caller recorded it. */
    global?: true;
    /**
     * Asked right before a change this process makes itself rather than
     * through a view: why it may not, or null while the requesting Shell's own
     * view drives the bound project and `projectId`, when named, is that one.
     */
    refuseWrite(projectId: string | undefined): { code: string; message: string } | null;
  };
  /**
   * Set for this host's own assistant running with no view (#13511), and asked
   * as `relay.refuseWrite` is, right before a change this process makes
   * itself: why it may not, or null while nobody drives its project and
   * `projectId`, when named, is that one.
   */
  refuseWrite?: (projectId: string | undefined) => { code: string; message: string } | null;
  /**
   * The caller's own pane, from its credential: a pane bearer's terminal, or
   * the terminal a help session is bound to. Null for everything else — an
   * api-key client has no pane to notify.
   */
  resolveOwnPane?: () => OwnPane | null;
  appendAuditRecord: (input: {
    toolId: string;
    sessionId: string;
    tier: McpTier;
    args: unknown;
    durationMs: number;
    /**
     * The handler's dispatch-start snapshot (#12122), forwarded so the
     * persisted record carries the same start the live strip's started event
     * does. Required — the audit record's own `timestamp` is a later clock
     * read, so a site that omitted this would leave its row unable to be
     * ordered against its siblings. Every CallTool audit write has it in
     * scope; making it mandatory here is what stops the next one from
     * dropping it.
     */
    startedAt: number;
    outcome: AuditOutcome;
    confirmationDecision?: import("../../../shared/types/ipc/mcpServer.js").McpConfirmationDecision;
    authorization?: McpDispatchAuthorization;
    bannerSuppressed?: boolean;
    /**
     * Turn id snapshotted once at dispatch start (#10067). Forwarded so the
     * audit record is stamped with the same turn the live activity strip's
     * started/settled events carry — never re-read at write time, where an
     * active→passive FSM transition could have cleared it and split one call
     * across two groupings.
     */
    capturedTurnId?: string | null;
    /** The caller's origin, so an unauthorized row's tier hint reads its own surface. */
    rendererOwnedOrigin?: boolean;
    /** A relayed call's callId from its Shell (#13493), so both records name one call. */
    relayCallId?: string;
  }) => void;
  getCachedManifest: () => import("../../../shared/types/actions.js").ActionManifestEntry[] | null;
  /**
   * Optional renderer notifier fired when a help-session tool call is denied
   * because the session tier doesn't permit it. Implemented by httpLifecycle
   * for help-session bearers (pinned WebContents); absent for external/api-key
   * sessions, which have no associated UI. True only when the banner event
   * reached a live view, the one case the refusal may point at it (#14995).
   */
  notifyTierMismatch?: (payload: {
    sessionId: string;
    toolId: string;
    tier: McpTier;
    /**
     * Minimum tier that permits the denied tool, or `null` if no non-external
     * help tier permits it — an unknown id, or a deliberately non-grantable
     * one. The renderer's "Set project default" elevates to it
     * via `setSessionTier`; its "Allow this tool" issues a per-tool grant for
     * the denied tool without changing the session tier at all. A `null`
     * withholds both affordances — the denial isn't actionable.
     */
    targetTier: HelpAssistantTier | null;
  }) => boolean;
  /**
   * Feed a denial into the abuse policy — both 401s and tier-mismatches
   * share the same per-session sliding-window counter. Returns
   * `{ tripped: true }` when the threshold is exceeded. Implemented by
   * httpLifecycle; absent in test fixtures that don't wire the policy.
   */
  recordDenial?: (sessionId: string, kind: "auth401" | "tierMismatch") => { tripped: boolean };
  /**
   * Optional renderer notifier fired when a session is revoked by the abuse
   * policy. Follows the same pinned-WebContents pattern as
   * `notifyTierMismatch` so only help-session bearers surface the
   * notification. External / api-key sessions have no associated UI so the
   * callback is a no-op.
   */
  notifySessionRevoked?: (payload: {
    sessionId: string;
    denialKind: string;
    /** Saved before revokeSession clears the map, so the callback can route. */
    pinnedWebContentsId?: number;
    /**
     * Whether this session is one of Daintree's own assistant surfaces, snapshot
     * alongside the pin and for the same reason (#11789): `revokeSession` clears
     * the origin too, so a callback re-reading it afterwards sees the
     * fail-closed `external` default and drops a notification the renderer needs
     * to show its recovery UI.
     */
    rendererOwned?: boolean;
  }) => void;
  /**
   * Remove a session from the abuse policy state so a reconnected session
   * doesn't inherit stale counters. Called after revokeSession and drain().
   */
  clearDenialState?: (sessionId: string) => void;
  /**
   * Resolve the help-session turn id live (#10067). Called exactly once per
   * dispatch — at the top of the CallTool handler — so a single snapshot feeds
   * the started event, the settled event, and the audit record. Returns `null`
   * for sessions with no help binding (external/api-key) or no active turn.
   * Implemented by httpLifecycle (it closes over the help-session id); absent
   * in test fixtures that don't exercise turn correlation.
   */
  getCurrentTurnId?: () => string | null;
  /**
   * Whether the assistant's confirm-gated Daintree actions currently skip the
   * host dialog (#12874) — the global "Skip permission prompts" unless the
   * assistant is set to always ask. Read on every call so a change takes effect
   * on the next one. Only consulted for `help` sessions; absent reads as false.
   */
  readAssistantConfirmationsSkipped?: () => boolean;
  /**
   * Optional renderer notifier fired when an MCP tool dispatch enters the call
   * path (after tier/rate/dedup guards pass and the manifest entry resolves).
   * Drives the Assistant panel's live activity strip (#9759). Implemented by
   * httpLifecycle for help-session bearers (pinned WebContents) — it computes
   * the redacted `argsSummary` and resolves the `turnId` before the targeted
   * send. Absent for external/api-key sessions, which have no associated UI.
   */
  notifyToolCallStarted?: (payload: {
    sessionId: string;
    toolId: string;
    args: unknown;
    startedAt: number;
    /** True when the resolved manifest entry is `danger: "confirm"`. */
    danger: boolean;
    /**
     * True only when this call will put a dialog in front of the person. A
     * confirm-gated call a grant, the pane's skip setting or an earlier
     * approval already authorized is `danger` without asking anyone (#14165).
     */
    asks: boolean;
    /** Turn id snapshotted at dispatch start (#10067); see {@link SessionServerDeps.getCurrentTurnId}. */
    capturedTurnId: string | null;
  }) => void;
  /**
   * Optional renderer notifier fired when a dispatch announced via
   * {@link SessionServerDeps.notifyToolCallStarted} settles. Receives the same
   * `AuditOutcome` the audit record is written from so the strip's result glyph
   * and severity match the audit log exactly (#9759).
   */
  notifyToolCallSettled?: (payload: {
    sessionId: string;
    toolId: string;
    /** The started event's own `startedAt`, so the two pair up exactly. */
    startedAt: number;
    /** The started event's own `danger`. */
    danger: boolean;
    /** The started event's own `asks`: whether this call announced a wait on the person. */
    asks: boolean;
    durationMs: number;
    outcome: AuditOutcome;
    /** Turn id snapshotted at dispatch start (#10067); matches the started event's value. */
    capturedTurnId: string | null;
  }) => void;
  /**
   * Optional renderer notifier fired when the assistant invokes
   * `help.displayImage` (#9828). Pushes the validated image URL and the
   * session-assigned figure number to the pinned WebContents so the Assistant
   * panel can render the figure inline. Implemented by httpLifecycle for
   * help-session bearers; absent for external/api-key sessions (which can't
   * call the tool — it's outside their allowlist — so it never fires for them).
   */
  notifyDisplayImage?: (payload: {
    sessionId: string;
    imageId: string;
    figureNumber: number;
    figureLabel: string;
    url: string;
    caption?: string;
    altText?: string;
  }) => void;
  /**
   * Record where this session's `tools/list` is about to be answered from, so
   * a later route change can tell the client its list moved (#13350). Returns
   * whether the route has moved since. Wired for workspace-bound sessions only.
   */
  noteToolListRoute?: () => () => boolean;
}
