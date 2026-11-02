import { webContents as webContentsModule } from "electron";
import type { WindowRegistry } from "../../window/WindowRegistry.js";
import { CHANNELS } from "../../ipc/channels.js";
import { getEndpointRegistry } from "../../ipc/endpointRegistry.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { readAssistantConfirmationsSkipped } from "./assistantConfirmationsPreference.js";
import type { ActionManifestEntry } from "../../../shared/types/actions.js";
import { isGlobalAssistantId } from "../../../shared/config/globalAssistant.js";
import { summarizeMcpArgs, summarizeMcpResult } from "../../../shared/utils/mcpArgsSummary.js";
import { scrubSecrets } from "../../../shared/utils/secretScrubber.js";
import { sanitizePath } from "../../utils/pathScrubber.js";
import type {
  PaneWorkspaceBinding,
  HelpSessionTerminalResolver,
  AssistantControlBinding,
  WorkspaceDispatchOptions,
  McpRelayCaller,
  McpSessionOrigin,
  McpWorkspaceBinding,
} from "./shared.js";
import {
  auditVerbatimArgKeys,
  projectAuditArgs,
  projectAuditResult,
  projectRelayedAuditArgs,
} from "./auditResultProjection.js";
import { relayOwnershipPrincipal } from "./resourceOwnership.js";
import {
  DriveHolderUnavailableError,
  NoFrontendAttachedError,
  RelayDrivenElsewhereError,
  SessionBindingError,
  WorkspaceBindingError,
} from "./rendererBridge.js";
import { relayWriteStanding } from "./relayWriteRule.js";
import { getGlobalAssistantBaseManifest, getViewlessHelpBaseManifest } from "./baseManifest.js";
import { isRemoteEndpointHandle, NO_VIEW_HANDLE } from "../../ipc/endpoint.js";
import { isProjectWorkspaceId } from "../../../shared/utils/workspaceIds.js";
import type {
  McpBearerIdentity,
  McpDispatchAuthorization,
  McpRequester,
} from "../../../shared/types/ipc/mcpServer.js";
import { buildAnnotations } from "./tierAuth.js";
import { bindHostControl } from "./hostControlTools.js";
import {
  AssistantTargetError,
  type AssistantCaller,
} from "../assistants/AssistantTerminalControl.js";
import { WORKER_STEER_REFUSALS } from "../../../shared/types/assistantControl.js";
import { getAssistantConfirmations } from "../assistants/assistantConfirmations.js";
import type { SessionStore } from "./sessionStore.js";
import type { AuditService } from "./auditLog.js";
import { classifyMcpDispatchResult } from "./auditLog.js";
import { computeMcpAuditSeverity } from "../../../shared/types/ipc/mcpServer.js";
import type { TurnOutcomeService } from "./turnOutcomeLog.js";
import { helpNotifyKey, relayNoticePane } from "./terminalNotify.js";
import type { AbusePolicy } from "./abusePolicy.js";
import {
  MCP_CONFIRMABLE_CALL_MAX_MS,
  MCP_REMOTE_CONFIRM_MARGIN_MS,
} from "../../../shared/config/mcpConfirmWindow.js";
import { createLogger } from "../../utils/logger.js";

const pinnedViewLogger = createLogger("main:McpPinnedView");

/**
 * Push one event to the view pinned to an MCP session. A positive id is a local
 * WebContents; a negative one is the handle of a view attached over a link,
 * which is reached through its endpoint. Returns false when no live view holds
 * the pin, so a caller scanning several sessions can move on to the next. The
 * payload is built only once a live target is found.
 */
export function sendToPinnedView(
  id: number,
  channel: string,
  buildPayload: () => unknown,
  label: string
): boolean {
  if (id < 0) {
    const endpoint = getEndpointRegistry().getByHandle(id);
    if (!endpoint || endpoint.kind !== "remote-view" || endpoint.isClosed()) return false;
    try {
      endpoint.send({ type: "event", channel, args: [buildPayload()] });
    } catch (err) {
      console.error(`[MCP] ${label} send failed:`, err);
      return false;
    }
    return true;
  }
  const wc = webContentsModule.fromId(id);
  if (!wc || wc.isDestroyed()) return false;
  try {
    wc.send(channel, buildPayload());
  } catch (err) {
    console.error(`[MCP] ${label} send failed:`, err);
    return false;
  }
  return true;
}

/** Time past the dispatch deadline a confirmation is still shown, for the hop to the dialog. */
const CONFIRMATION_DEADLINE_GRACE_MS = 2_000;

/** One call of one session, as its started and settled notices both name it. */
function confirmationCallKey(sessionId: string, toolId: string, startedAt: number): string {
  return JSON.stringify([sessionId, toolId, startedAt]);
}

/**
 * Render a dispatch outcome as a redacted, bounded result summary for the
 * audit record, so the recent-calls popover can show what each call actually
 * returned. Gate outcomes (unauthorized / dedup / collision / rate-limit)
 * return null — their `result` classification already says everything.
 *
 * A successful result passes through its tool's host-owned projection first
 * (#12479). The scrub and the length cap run afterwards on whatever is left,
 * so a tool whose result is conversation hands the summarizer only its shape —
 * truncating the text after the fact would still have kept its head.
 */
function summarizeAuditOutcome(
  toolId: string,
  outcome: import("./auditLog.js").AuditOutcome,
  scrub: (value: string) => string
): string | null {
  if (outcome.kind === "result") {
    if (outcome.value.ok) {
      return summarizeMcpResult(projectAuditResult(toolId, outcome.value.result), scrub);
    }
    const { code, message } = outcome.value.error;
    return scrub(`${code}: ${message}`).slice(0, 500);
  }
  if (outcome.kind === "throw") {
    const text = formatErrorMessage(outcome.error, "Dispatch threw");
    return scrub(text).slice(0, 500);
  }
  return null;
}

/**
 * What a session's deps are built from: the routes, executors and services
 * HttpLifecycle is constructed with, as {@link createSessionServerDeps} reads them.
 */
export interface SessionServerDepsSource {
  sessionStore: SessionStore;
  auditService: AuditService;
  turnOutcomeService: TurnOutcomeService;
  abusePolicy: AbusePolicy;
  requestManifest: () => Promise<import("../../../shared/types/actions.js").ActionManifestEntry[]>;
  dispatchAction: (
    actionId: string,
    args: unknown,
    confirmed?: boolean,
    callerInfo?: McpBearerIdentity,
    sessionOrigin?: McpSessionOrigin,
    authorization?: McpDispatchAuthorization
  ) => Promise<import("./shared.js").DispatchEnvelope>;
  // Pinned variants used for help-session bearers — route to the renderer
  // WebContents that minted the bearer at provision time (#7002). Optional
  // for backward-compat with test fixtures that don't wire help routing.
  requestManifestForWebContents?: (
    id: number
  ) => Promise<import("../../../shared/types/actions.js").ActionManifestEntry[]>;
  dispatchActionForWebContents?: (
    id: number,
    actionId: string,
    args: unknown,
    confirmed?: boolean,
    contextOverride?: import("../../../shared/types/actions.js").ActionContext,
    sessionOrigin?: McpSessionOrigin,
    approval?: Pick<
      WorkspaceDispatchOptions,
      "approvalOnly" | "approvalReason" | "authorization" | "requester"
    >
  ) => Promise<import("./shared.js").DispatchEnvelope>;
  // Workspace-bound variants used for external sessions that named a workspace
  // at handshake (#11789) and for agent panes bound to their launch workspace
  // (#12486). They resolve the workspace's current view per call, so a session
  // survives its view being replaced and fails closed rather than following
  // focus when it can't. `preferredWebContentsId` is a pane's launch view,
  // preferred while it still shows the workspace. Optional for the same reason
  // as the pinned variants above: test fixtures that don't wire workspace
  // routing. A pane's dispatch also carries its launch context.
  requestManifestForWorkspace?: (
    workspaceId: string,
    preferredWebContentsId?: number
  ) => Promise<import("../../../shared/types/actions.js").ActionManifestEntry[]>;
  // Records the route a bound session's `tools/list` is answered from, so a
  // move tells its client (#13350). Optional like the routes it watches.
  noteToolListRoute?: (
    sessionId: string,
    workspaceId: string,
    preferredWebContentsId?: number
  ) => () => boolean;
  dispatchActionForWorkspace?: (
    workspaceId: string,
    actionId: string,
    args: unknown,
    confirmed?: boolean,
    sessionOrigin?: McpSessionOrigin,
    options?: WorkspaceDispatchOptions
  ) => Promise<import("./shared.js").DispatchEnvelope>;
  /** A help session with no view (#13511): the host's own form of the action, in its project. */
  dispatchActionWithoutView?: (
    workspaceId: string,
    actionId: string,
    args: unknown,
    confirmed?: boolean,
    sessionOrigin?: McpSessionOrigin,
    options?: WorkspaceDispatchOptions
  ) => Promise<import("./shared.js").DispatchEnvelope>;
  getCachedManifestForWorkspace?: (
    workspaceId: string,
    preferredWebContentsId?: number
  ) => import("../../../shared/types/actions.js").ActionManifestEntry[] | null;
  /**
   * Take the user to a run and bring its window with them (#12315).
   * `terminal.revealOwned` is the only caller. It is one call rather than a
   * dispatch plus a raise because both have to land on the same window, and
   * only the bridge can resolve that once and hold it across the await.
   */
  revealOwnedRun?: (
    workspaceId: string | undefined,
    actionId: string,
    args: unknown,
    confirmed: boolean,
    sessionOrigin: McpSessionOrigin,
    preferredWebContentsId?: number
  ) => Promise<{ envelope: import("./shared.js").DispatchEnvelope; raised: boolean }>;
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
  /** `visibility` is the session's bound project, resolved by {@link createSessionServerDeps}. */
  handleSkillsSearch: (
    rawArgs: unknown,
    visibility: import("../plugin/PluginSkillRegistry.js").SkillVisibility
  ) => import("../../../shared/types/skills.js").SkillSearchResult;
  handleSkillsLoad: (
    rawArgs: unknown,
    visibility: import("../plugin/PluginSkillRegistry.js").SkillVisibility
  ) => import("../../../shared/types/skills.js").SkillLoadResult;
  handleProjectRunCheck: (
    rawArgs: unknown,
    signal: AbortSignal,
    /** Asked once more right before the spawn; throws to refuse (#13493). */
    authorize?: () => void
  ) => Promise<import("../../../shared/types/projectCheck.js").ProjectCheckRunResult>;
  handleProjectRunCommand: (
    rawArgs: unknown,
    signal: AbortSignal,
    /** Asked once more right before the spawn; throws to refuse (#13493). */
    authorize?: () => void
  ) => Promise<import("../../../shared/types/projectCommand.js").ProjectCommandRunResult>;
  handleTerminalGetStatusViewless: import("./sessionServer.js").SessionServerDeps["handleTerminalGetStatusViewless"];
  handleTerminalReadLastMessageOwned: import("./sessionServer.js").OwnedMainExecutors["handleTerminalReadLastMessageOwned"];
  /** How this machine names itself to people, for the stamp on what its assistants send. */
  machineName?: () => string;
  /** This machine's Codex quota, as `agent.readQuota` reports it. */
  readCodexQuota?: import("./sessionServer.js").SessionServerDeps["readCodexQuota"];
  isTerminalIdInUse: (terminalId: string) => boolean;
  readTerminalCloseContext?: import("./sessionServer.js").SessionServerDeps["readTerminalCloseContext"];
  readClosedPanelProcess?: import("./sessionServer.js").SessionServerDeps["readClosedPanelProcess"];
  readTerminalProcesses?: import("./sessionServer.js").SessionServerDeps["readTerminalProcesses"];
  readWorktreeGit?: import("./sessionServer.js").SessionServerDeps["readWorktreeGit"];
  waitForClosedPanelExits?: import("./sessionServer.js").SessionServerDeps["waitForClosedPanelExits"];
  terminalGenerationOf?: import("./sessionServer.js").SessionServerDeps["terminalGenerationOf"];
  trackedTerminalIds?: import("./sessionServer.js").SessionServerDeps["trackedTerminalIds"];
  /**
   * Whether the pty-host's record places a terminal as an agent pane of this
   * workspace (#12883). `false` for anything it cannot place.
   */
  isAgentPaneInWorkspace?: (terminalId: string, workspaceId: string) => Promise<boolean>;
  /** Terminal notices. Absent, `terminal.notifyWhenIdle` and `notify: true` answer not-eligible. */
  terminalNotify?: import("./terminalNotify.js").TerminalNotifyHandlers;
  replyWaiter?: Pick<import("./replyWaiter.js").ReplyWaiterService, "wait">;
  getCachedManifest: () => import("../../../shared/types/actions.js").ActionManifestEntry[] | null;
  // Per-WebContents manifest cache read for pinned help sessions (#9887). Lets
  // the pinned `getCachedManifest` closure return the session's own window's
  // cached manifest instead of always re-fetching on every CallTool dispatch.
  // Optional for backward-compat with test fixtures that don't wire help
  // routing (mirrors `requestManifestForWebContents`).
  getCachedManifestForWebContents?: (
    id: number
  ) => import("../../../shared/types/actions.js").ActionManifestEntry[] | null;
}

/**
 * What a session's handshake settled, fixed for the session's life. The
 * factory snapshots the session store's pin, origin and help-session id beside
 * these, at the same moment and for the same reason.
 */
export interface SessionHandshakeCapture {
  readonly sessionId: string;
  readonly workspaceBinding?: McpWorkspaceBinding;
  readonly paneBinding?: PaneWorkspaceBinding;
  readonly ownPane?: import("./terminalNotify.js").OwnPane | null;
  readonly relay?: McpRelayCaller;
}

/**
 * HttpLifecycle state a session reads when a call needs it, never at build:
 * each can be set or replaced while sessions are already open.
 */
export interface SessionServerDepsHost {
  registry(): WindowRegistry | null;
  assistantControlBinding(): AssistantControlBinding | null;
  helpSessionTerminalResolver(): HelpSessionTerminalResolver | null;
  /** The external client behind a session, for the confirm dialog to name (#9157). */
  getBearerInfoForSession(sessionId: string): McpBearerIdentity | null;
  /** Stable; each of its methods reads the binding as the call finds it. */
  readonly assistantControl: AssistantControlBinding["control"];
}

/** The steer the binding holds as a call finds it; unbound, the call is refused, never widened. */
function boundSteer(
  host: Pick<SessionServerDepsHost, "assistantControlBinding">
): NonNullable<AssistantControlBinding["steer"]> {
  const steer = host.assistantControlBinding()?.steer;
  if (steer === undefined) {
    throw new AssistantTargetError(
      WORKER_STEER_REFUSALS.notFound,
      "This host can't reach its agents for you right now. Nothing was done."
    );
  }
  return steer;
}

/**
 * The renderer notices and denial bookkeeping. Each acts on the session its
 * payload names, so none of them reads what a handshake captured.
 */
function createSessionNotifiers(
  deps: Pick<SessionServerDepsSource, "sessionStore" | "abusePolicy">,
  host: Pick<SessionServerDepsHost, "helpSessionTerminalResolver">
): Pick<
  import("./sessionServer.js").SessionServerDeps,
  | "notifyTierMismatch"
  | "recordDenial"
  | "notifySessionRevoked"
  | "notifyToolCallStarted"
  | "notifyToolCallSettled"
  | "notifyDisplayImage"
> {
  /**
   * Whether this session's events belong in a Daintree assistant surface
   * (#11789).
   *
   * The five notification closures below all used to gate on "is there a
   * WebContents pinned to this session", which was an accidental proxy for
   * "is this one of ours" — accidental because external sessions were never
   * pinned. Workspace-bound external sessions have a renderer route and are
   * still not ours: `HelpPanel` is mounted unconditionally in `AppLayout`, so
   * these events would genuinely land, putting a third-party client's tool
   * calls in the Assistant's activity strip and offering its tier-mismatch
   * approval controls — controls whose `issueGrant` / `setSessionTier` calls
   * the origin gate then has to refuse.
   */
  const isRendererOwned = (notifiedSessionId: string): boolean =>
    deps.sessionStore.isRendererOwnedOrigin(notifiedSessionId);

  const notifyTierMismatch: import("./sessionServer.js").SessionServerDeps["notifyTierMismatch"] = (
    payload
  ) => {
    // Daintree's own assistant surfaces only — a third-party client has no
    // panel to show a banner in, and its denials are not the user's to
    // approve. Targeted at the pinned WebContents so the assistant panel
    // that triggered the call gets the event, even if a different project
    // view is currently focused.
    if (!isRendererOwned(payload.sessionId)) return false;
    const id = deps.sessionStore.sessionWebContentsMap.get(payload.sessionId);
    if (id === undefined) return false;
    return sendToPinnedView(
      id,
      CHANNELS.MCP_TIER_NOT_PERMITTED,
      () => ({
        sessionId: payload.sessionId,
        toolId: payload.toolId,
        tier: payload.tier,
        targetTier: payload.targetTier,
      }),
      "tier-not-permitted"
    );
  };

  const recordDenial: import("./sessionServer.js").SessionServerDeps["recordDenial"] = (
    sessionId,
    kind
  ) => {
    return deps.abusePolicy.recordDenial(sessionId, kind);
  };

  const notifySessionRevoked: import("./sessionServer.js").SessionServerDeps["notifySessionRevoked"] =
    (payload) => {
      // Prefer the caller's snapshot over a live read (#11789). This event
      // fires *after* `revokeSession`, which clears the origin along with
      // everything else — so re-reading it here would hit the fail-closed
      // `external` default and silently drop the recovery banner for a
      // genuine help session that tripped the abuse threshold. The caller
      // captured both fields before revoking for exactly this reason.
      if (!(payload.rendererOwned ?? isRendererOwned(payload.sessionId))) return;
      const id =
        payload.pinnedWebContentsId ??
        deps.sessionStore.sessionWebContentsMap.get(payload.sessionId);
      if (id === undefined) return;
      sendToPinnedView(
        id,
        CHANNELS.MCP_SESSION_REVOKED,
        () => ({
          sessionId: payload.sessionId,
          denialKind: payload.denialKind,
        }),
        "session-revoked"
      );
    };

  const notifyToolCallStarted: import("./sessionServer.js").SessionServerDeps["notifyToolCallStarted"] =
    (payload) => {
      // Daintree's own assistant surfaces only — targeted at the pinned
      // WebContents so the assistant panel that triggered the call gets the
      // live activity event, even if a different project view is focused. A
      // third-party client's calls do not belong in that strip.
      if (!isRendererOwned(payload.sessionId)) return;
      // A call that waits on the person is also an observation of its
      // assistant's (#14165), for Canopy and `host.list` to read; the dialog
      // stays the one place it is answered.
      const helpSessionId = deps.sessionStore.sessionHelpIdMap.get(payload.sessionId);
      const helpTerminalId =
        helpSessionId !== undefined
          ? (host.helpSessionTerminalResolver()?.(helpSessionId) ?? null)
          : null;
      if (payload.asks && helpSessionId !== undefined && helpTerminalId !== null) {
        // Announced just before it asks: the dialog's own deadline runs from
        // about now, not from the call's start, and a wait shown a moment
        // late is safer than a live decision hidden early.
        const waitingSince = Date.now();
        getAssistantConfirmations().begin(
          confirmationCallKey(payload.sessionId, payload.toolId, payload.startedAt),
          { helpSessionId, terminalId: helpTerminalId },
          {
            actionId: payload.toolId,
            since: waitingSince,
            // The latest the call can still be open (#14989); the marker's
            // settle is what normally clears it, well before.
            expiresAt: waitingSince + MCP_CONFIRMABLE_CALL_MAX_MS + CONFIRMATION_DEADLINE_GRACE_MS,
          }
        );
      }
      const id = deps.sessionStore.sessionWebContentsMap.get(payload.sessionId);
      if (id === undefined) return;
      // Redact args with the same pipeline the audit record uses so the strip
      // never shows raw bearer tokens or absolute paths (#9759). The turn id
      // is the snapshot the dispatch took at call-start (#10067) — not a fresh
      // read here, which could disagree with the settled/audit value if the
      // FSM transitioned mid-call.
      const turnId = payload.capturedTurnId;
      sendToPinnedView(
        id,
        CHANNELS.MCP_TOOL_CALL_STARTED,
        () => ({
          sessionId: payload.sessionId,
          toolId: payload.toolId,
          argsSummary: summarizeMcpArgs(
            projectAuditArgs(payload.toolId, payload.args),
            (s) => scrubSecrets(sanitizePath(s)),
            auditVerbatimArgKeys(payload.toolId)
          ),
          startedAt: payload.startedAt,
          danger: payload.danger,
          ...(turnId !== null ? { turnId } : {}),
        }),
        "tool-call-started"
      );
    };

  const notifyToolCallSettled: import("./sessionServer.js").SessionServerDeps["notifyToolCallSettled"] =
    (payload) => {
      // Before the origin check: a session torn down mid-call still settles its wait.
      if (payload.asks) {
        getAssistantConfirmations().settle(
          confirmationCallKey(payload.sessionId, payload.toolId, payload.startedAt)
        );
      }
      if (!isRendererOwned(payload.sessionId)) return;
      const id = deps.sessionStore.sessionWebContentsMap.get(payload.sessionId);
      if (id === undefined) return;
      // Derive result/errorCode/severity from the same classifier the audit
      // writer uses, so the strip's glyph and red-tint match the audit log.
      const { result, errorCode } = classifyMcpDispatchResult(payload.outcome);
      // Same snapshot the started event carried (#10067) — guarantees the
      // strip's in-flight row and its settled row resolve to one turn group.
      const turnId = payload.capturedTurnId;
      sendToPinnedView(
        id,
        CHANNELS.MCP_TOOL_CALL_SETTLED,
        () => ({
          sessionId: payload.sessionId,
          toolId: payload.toolId,
          durationMs: Math.max(0, Math.round(payload.durationMs)),
          result,
          ...(errorCode !== undefined ? { errorCode } : {}),
          severity: computeMcpAuditSeverity(result, errorCode),
          ...(turnId !== null ? { turnId } : {}),
        }),
        "tool-call-settled"
      );
    };

  const notifyDisplayImage: import("./sessionServer.js").SessionServerDeps["notifyDisplayImage"] = (
    payload
  ) => {
    // Daintree's own assistant surfaces only — targeted at the pinned
    // WebContents so the figure renders in the assistant panel that
    // triggered the call, even if a different project view is focused. The
    // tool is outside the external allowlist as well, so this is belt and
    // braces.
    if (!isRendererOwned(payload.sessionId)) return;
    const id = deps.sessionStore.sessionWebContentsMap.get(payload.sessionId);
    if (id === undefined) return;
    sendToPinnedView(
      id,
      CHANNELS.MCP_HELP_DISPLAY_IMAGE,
      () => ({
        sessionId: payload.sessionId,
        imageId: payload.imageId,
        figureNumber: payload.figureNumber,
        figureLabel: payload.figureLabel,
        url: payload.url,
        ...(payload.caption !== undefined ? { caption: payload.caption } : {}),
        ...(payload.altText !== undefined ? { altText: payload.altText } : {}),
      }),
      "help-display-image"
    );
  };

  return {
    notifyTierMismatch,
    recordDenial,
    notifySessionRevoked,
    notifyToolCallStarted,
    notifyToolCallSettled,
    notifyDisplayImage,
  };
}

/**
 * Builds per-session dispatch deps, routing on how the session was bound at
 * handshake. Three routes, in precedence order:
 *
 * 1. **Workspace-bound** (#11789) — an external session that named a
 *    workspace, or an agent pane bound to the workspace it was launched in
 *    (#12486). Every operation re-resolves that workspace's current view, so
 *    the session survives its view being replaced and fails closed rather
 *    than following focus when the workspace has no single live view. A
 *    pane's launch view is preferred while it still shows the workspace.
 * 2. **WebContents-pinned** (#7002) — help-session bearers, routed to the
 *    renderer that minted them, with a cache-free
 *    manifest lookup so window A's manifest can never be served to window B.
 * 3. **Unbound** — api-key tokens with no selector, which keep the shared
 *    dispatch and cached-manifest path and follow window focus, as
 *    documented.
 *
 * The two bound routes are mutually exclusive by construction: a selector
 * from a pinned bearer is refused at handshake, and a pane binding is only
 * looked up for a bearer the pin resolver didn't match.
 *
 * What the handshake settled arrives in `capture` and is snapshotted here,
 * once; what can change while the session lives is read through `host` when a
 * call needs it.
 */
export function createSessionServerDeps(
  deps: SessionServerDepsSource,
  host: SessionServerDepsHost,
  capture: SessionHandshakeCapture
): import("./sessionServer.js").SessionServerDeps {
  const { sessionId, workspaceBinding, paneBinding, ownPane, relay } = capture;
  const pinnedDispatch = deps.dispatchActionForWebContents;
  const pinnedManifest = deps.requestManifestForWebContents;
  const workspaceDispatch = deps.dispatchActionForWorkspace;
  const workspaceManifest = deps.requestManifestForWorkspace;
  const noteToolListRoute = deps.noteToolListRoute;
  // Snapshotted for the same reason as the pin below: a session torn down
  // mid-call must keep failing closed to its own workspace rather than
  // silently reverting to the focused-window path.
  const boundWorkspaceId = workspaceBinding?.workspaceId ?? null;
  // Only ever alongside a workspace binding: the handshake derives one from
  // the other. Undefined for an external bound session, whose route has no
  // launch view to prefer and nothing extra to carry. Captured with the
  // workspace, for the workspace's reason: a session torn down while a call
  // awaits its manifest must still dispatch against the pane's own worktree,
  // not drop its context and act on whatever the view has selected.
  // The bearer's own terminal, so a dialog can say which pane is asking
  // (#14992). Never the launch context's focused terminal, which is whatever
  // had focus when the pane started, and never a relayed pane, which lives on
  // the machine that relayed it.
  const paneRequester: McpRequester | undefined =
    paneBinding && ownPane && ownPane.relay === undefined
      ? { kind: "pane", terminalId: ownPane.terminalId }
      : undefined;
  const paneDispatchOptions: WorkspaceDispatchOptions | undefined = paneBinding
    ? {
        contextOverride: paneBinding.actionContext,
        preferredWebContentsId: paneBinding.launchWebContentsId,
        // A pane is the one session whose tier is an auto-approval line
        // rather than a ceiling (#12692), so its dialogs may offer to keep
        // allowing the tool for the rest of the session.
        offerSessionApproval: true,
        ...(paneRequester ? { requester: paneRequester } : {}),
      }
    : undefined;
  const preferredWebContentsId = paneBinding?.launchWebContentsId;
  // Captured at build time (both handshakes populate the map before calling
  // this) so an in-flight dispatch settling after teardown deletes the map
  // entry still stamps its audit record / resolves its turnId correctly.
  // The turn-id register in TurnOutcomeService is keyed by HELP session id,
  // not the MCP transport id `sessionId` — passing the transport id there
  // always missed, which broke same-turn coalescing and turnId stamping.
  const helpSessionId = deps.sessionStore.sessionHelpIdMap.get(sessionId) ?? null;
  // Snapshot the pin at build time (set at handshake before this runs, and
  // only ever deleted on teardown — never re-pointed). Capturing it makes the
  // `getCachedManifest` closure below read strictly this session's own
  // per-WebContents cache, so a session torn down mid-call can never flip to
  // the shared cache and leak another window's tool surface (#7003 / #9887).
  const pinnedWebContentsId = deps.sessionStore.sessionWebContentsMap.get(sessionId) ?? null;
  // A help session with no view (#13511) is bound to its project instead of
  // a pin, snapshotted for the pin's reason: torn down mid-call, it keeps
  // failing closed to its own project rather than following focus.
  const viewlessProjectId = deps.sessionStore.sessionViewlessHelpMap.get(sessionId) ?? null;
  // The global assistant is viewless too, but has no project's tools to describe (#14453).
  const viewlessBaseManifest = (): ActionManifestEntry[] =>
    viewlessProjectId !== null && isGlobalAssistantId(viewlessProjectId)
      ? getGlobalAssistantBaseManifest()
      : getViewlessHelpBaseManifest();
  const viewlessDispatch = deps.dispatchActionWithoutView;
  // Snapshotted for the same reason as the pin: `clearSessionBinding` deletes
  // the origin entry on teardown, and `getOrigin` fails closed to `external`
  // — so an in-flight dispatch settling after that would downgrade one of the
  // assistant's own spawns to "an external client did this" (#11808). Read
  // here, before the closure, never inside it.
  const sessionOrigin = deps.sessionStore.getOrigin(sessionId);
  // The Assistant tab asking (#14992), by the help session id its lane holds.
  // Only for the assistant's own session: a relayed call's tab is on the
  // machine that relayed it.
  const assistantRequester: McpRequester | undefined =
    sessionOrigin === "help" && helpSessionId !== null && relay === undefined
      ? { kind: "assistant", helpSessionId }
      : undefined;

  // The view captured with the pin, so a webContents id recycled after the
  // view is gone never resolves as the one the assistant was opened in.
  const pinnedWebContents =
    pinnedWebContentsId !== null ? webContentsModule.fromId(pinnedWebContentsId) : undefined;
  /**
   * Whether a terminal is in the workspace of this session's pinned view
   * (#12883) — the whole boundary for the assistant's reads of panes it did
   * not create, so every unknown refuses. Re-resolved per call rather than at
   * build: the view can be torn down, or the pin dropped, while the session
   * lives on. Only this view's own manager is asked; never the focused
   * window's or the active project's.
   */
  const pinnedWorkspaceId = (): string | null => {
    if (viewlessProjectId !== null) {
      return deps.sessionStore.sessionViewlessHelpMap.get(sessionId) === viewlessProjectId
        ? viewlessProjectId
        : null;
    }
    if (pinnedWebContentsId === null || !pinnedWebContents) return null;
    if (deps.sessionStore.sessionWebContentsMap.get(sessionId) !== pinnedWebContentsId) {
      return null;
    }
    const live = webContentsModule.fromId(pinnedWebContentsId);
    if (live !== pinnedWebContents || live.isDestroyed()) return null;
    return (
      host
        .registry()
        ?.getByWebContentsId(pinnedWebContentsId)
        ?.services.projectViewManager?.getWorkspaceRefForWebContents(pinnedWebContentsId)
        ?.workspaceId ?? null
    );
  };
  // The refusal the assistant sees is uniform, so which side failed is
  // recorded here: the view (pin, WebContents, workspace) or the pane's
  // record (none, another project's, or an unanswered lookup) (#13439).
  const refuseInPinnedView = (terminalId: string, reason: string): false => {
    pinnedViewLogger.info("Pinned-view read refused", { sessionId, terminalId, reason });
    return false;
  };
  const isTerminalInPinnedWorkspace = async (terminalId: string): Promise<boolean> => {
    try {
      const workspaceId = pinnedWorkspaceId();
      if (!workspaceId) return refuseInPinnedView(terminalId, "no-view-workspace");
      if (!deps.isAgentPaneInWorkspace) return refuseInPinnedView(terminalId, "unwired");
      if (!(await deps.isAgentPaneInWorkspace(terminalId, workspaceId))) {
        return refuseInPinnedView(terminalId, "not-in-workspace");
      }
      // The record lookup is a round trip, and the view can go, or be
      // repointed, while it is out.
      if (pinnedWorkspaceId() !== workspaceId) {
        return refuseInPinnedView(terminalId, "view-changed");
      }
      return true;
    } catch {
      return refuseInPinnedView(terminalId, "lookup-failed");
    }
  };

  /**
   * A remote view's pin is its endpoint handle, which no WebContents answers
   * to. Its sessions are revoked when the endpoint moves to another project,
   * so while the pin stands, the project the session was provisioned for is
   * the view's.
   */
  const remotePinnedProjectId = (): string | null => {
    if (pinnedWebContentsId === null || !isRemoteEndpointHandle(pinnedWebContentsId)) {
      return null;
    }
    if (helpSessionId === null) return null;
    if (deps.sessionStore.sessionWebContentsMap.get(sessionId) !== pinnedWebContentsId) {
      return null;
    }
    return host.assistantControlBinding()?.sessionProject(helpSessionId) ?? null;
  };

  /**
   * The project whose plugins' skills `skills.search` / `skills.load` may
   * return (#13831): the workspace the session is bound to, or for a help
   * session the one its own view, remote view or viewless binding names.
   * Never the focused window's, so an unbound session — and a scratch, or a
   * pin whose view is gone — reads as no project and sees installed plugins'
   * skills only.
   */
  const skillsProjectId = (): string | null => {
    const workspaceId = boundWorkspaceId ?? pinnedWorkspaceId() ?? remotePinnedProjectId();
    return workspaceId !== null && isProjectWorkspaceId(workspaceId) ? workspaceId : null;
  };

  /**
   * A bound session whose workspace route is unwired must fail, never fall
   * through (#11789). The helpers are individually optional for the same
   * reason the pinned ones are — test fixtures that don't wire routing — but
   * "bound, and quietly following focus instead" is the precise bug this
   * feature exists to remove, so it can never be a fallback.
   */
  const missingWorkspaceRoute = (): Error =>
    new WorkspaceBindingError(boundWorkspaceId ?? "", "not-found");

  /**
   * This session as an assistant addressing another (#13496), from its own
   * state alone: a relay principal in the project it was admitted for, or a
   * live help session in the project its lane is in. Null for every other
   * session, and for a help session whose bearer has since been unbound.
   */
  const assistantCallerFor = (): AssistantCaller | null => {
    if (host.assistantControlBinding() === null) return null;
    if (relay) {
      if (boundWorkspaceId === null) return null;
      return {
        kind: "relay",
        senderId: relay.senderId,
        linkSessionId: relay.linkSessionId,
        helpSessionId: relay.helpSessionId,
        projectId: boundWorkspaceId,
        machineName: relay.shellName,
      };
    }
    if (sessionOrigin !== "help" || helpSessionId === null) return null;
    if (deps.sessionStore.sessionHelpIdMap.get(sessionId) !== helpSessionId) return null;
    const projectId = host.assistantControlBinding()?.sessionProject(helpSessionId) ?? null;
    if (projectId === null) return null;
    return {
      kind: "local",
      helpSessionId,
      projectId,
      machineName: deps.machineName?.() ?? "this machine",
    };
  };

  /**
   * Pinned at handshake and torn down since — a take-over retiring the
   * assistant's transports (#13360), a revoke, an idle reap — while a call
   * was still on its way. Such a call fails closed, as a gone pin does,
   * rather than falling through to a route that follows focus.
   */
  const goneBinding = (): SessionBindingError | null => {
    if (pinnedWebContentsId !== null) {
      return deps.sessionStore.sessionWebContentsMap.has(sessionId)
        ? null
        : new SessionBindingError(pinnedWebContentsId);
    }
    if (viewlessProjectId !== null) {
      return deps.sessionStore.sessionViewlessHelpMap.has(sessionId)
        ? null
        : new SessionBindingError(NO_VIEW_HANDLE);
    }
    return null;
  };

  const requestManifest: import("./sessionServer.js").SessionServerDeps["requestManifest"] = () => {
    if (boundWorkspaceId !== null) {
      if (!workspaceManifest) return Promise.reject(missingWorkspaceRoute());
      const manifest = workspaceManifest(boundWorkspaceId, preferredWebContentsId);
      // This machine's assistant in another of its projects (#14024) runs a
      // call here in a project no view shows, as Host mode does for every
      // project: its tools are described by the base surface, not refused.
      return relay?.local === true
        ? manifest.catch((err: unknown) => {
            throw err instanceof WorkspaceBindingError &&
              err.reason === "not-found" &&
              !(err instanceof NoFrontendAttachedError)
              ? new NoFrontendAttachedError(boundWorkspaceId)
              : err;
          })
        : manifest;
    }
    // No view to describe one, so the host's own: a tool only a view can
    // run is still listed, and answers NO_FRONTEND_ATTACHED when called.
    if (viewlessProjectId !== null) {
      const gone = goneBinding();
      return gone ? Promise.reject(gone) : Promise.resolve(viewlessBaseManifest());
    }
    const id = deps.sessionStore.sessionWebContentsMap.get(sessionId);
    if (id !== undefined && pinnedManifest) {
      return pinnedManifest(id);
    }
    const gone = goneBinding();
    if (gone) return Promise.reject(gone);
    return deps.requestManifest();
  };

  /**
   * The reveal route (#12315). Built here rather than forwarded raw so it
   * carries the same captured `sessionOrigin` as `dispatchAction` below — the
   * origin is what keeps an external client's tool call out of the
   * assistant's provenance, and a route that skipped this closure would
   * silently drop it.
   *
   * Undefined when the bridge does not offer the route, which leaves the
   * reveal on the ordinary dispatch: the right target for every session
   * except a bound one, and no window raise.
   */
  // A relayed reveal takes the ordinary dispatch, and with it the relay's drive check.
  // One with no view has no window to raise, and takes the ordinary dispatch's refusal.
  const bridgeReveal = relay || viewlessProjectId !== null ? undefined : deps.revealOwnedRun;
  const revealOwnedRun: import("./sessionServer.js").SessionServerDeps["revealOwnedRun"] =
    bridgeReveal
      ? (workspaceId, actionId, args, confirmed) => {
          const gone = goneBinding();
          if (gone) return Promise.reject(gone);
          return bridgeReveal(
            workspaceId,
            actionId,
            args,
            confirmed ?? false,
            sessionOrigin,
            preferredWebContentsId
          );
        }
      : undefined;

  const dispatchAction: import("./sessionServer.js").SessionServerDeps["dispatchAction"] = (
    actionId,
    args,
    confirmed,
    authorization,
    relayCallId
  ) => {
    if (boundWorkspaceId !== null) {
      // A bound external session records no context: unlike a help session,
      // which replays the ActionContext snapshot taken when the user launched
      // it (#8317), it has no launch moment to replay, and the bound view's
      // own live context already describes the right workspace. An agent
      // pane does have one (#12486), so its snapshot rides along here.
      //
      // No `callerInfo` either: it exists solely to name the requesting client
      // in the confirm dialog (#9157). A bound external session's surface
      // excludes every confirm-gated tool, so nothing could ever read it, and
      // a pane's ladder-tier bearer has none to give — the bearer register
      // withholds it for every non-external tier, bound or not.
      //
      // `sessionOrigin` is threaded even though only `external` sessions may
      // bind — a selector from a pinned bearer is refused at handshake — so
      // the payload is built the same way on all three routes rather than one
      // of them relying on a default that a later binding rule could falsify.
      // A relayed call names who asked (#13493): anything but a read goes only
      // to that Shell's own driving view. A read is what the tool advertises as
      // one, so a query that writes a file counts as the write it is, and one
      // the cache can't describe is a write too. With no view to describe the
      // project at all, the host's generated catalog does, so a read on a
      // headless host is still a read.
      const relayEntry = relay
        ? (getCachedManifest() ?? getViewlessHelpBaseManifest()).find(
            (entry) => entry.id === actionId
          )
        : undefined;
      // Its confirmation, with no view here to raise one, is put to the
      // person at that Shell about this very call (#13501).
      const askShell = relay?.requestApproval;
      // Everything the call waits on ends inside its own deadline (#15699),
      // with room for the answer to reach it: a confirmation that outlasted
      // it could be approved after the caller was told the call failed.
      const callDeadline =
        relay !== undefined && relayCallId !== undefined
          ? relay.callDeadline?.(relayCallId)
          : undefined;
      if (
        relay?.callDeadline !== undefined &&
        relayCallId !== undefined &&
        callDeadline === undefined
      ) {
        // Its caller has already been answered, a timeout most likely, while
        // this call was still reading: nothing more of it may run.
        return Promise.reject(
          new Error(`Relayed call ${relayCallId} has already ended, so ${actionId} was not run`)
        );
      }
      const holdUntil =
        callDeadline !== undefined ? callDeadline - MCP_REMOTE_CONFIRM_MARGIN_MS : undefined;
      const relayOptions: WorkspaceDispatchOptions | undefined = relay
        ? {
            ...(holdUntil !== undefined ? { holdUntil } : {}),
            relay: {
              linkSessionId: relay.linkSessionId,
              readOnly:
                relayEntry !== undefined && buildAnnotations(relayEntry).readOnlyHint === true,
              ...(relay.local === true ? { local: true as const } : {}),
              ...(relayCallId !== undefined
                ? { call: { callId: relayCallId, helpSessionId: relay.helpSessionId } }
                : {}),
              ...(askShell !== undefined && relayCallId !== undefined
                ? {
                    requestApproval: (ask) =>
                      askShell({
                        ...ask,
                        callId: relayCallId,
                        ...(holdUntil !== undefined ? { holdUntil } : {}),
                      }),
                  }
                : {}),
            },
          }
        : undefined;
      const options = relayOptions ?? paneDispatchOptions;
      return workspaceDispatch
        ? workspaceDispatch(
            boundWorkspaceId,
            actionId,
            args,
            confirmed,
            sessionOrigin,
            authorization !== undefined ? { ...options, authorization } : options
          )
        : Promise.reject(missingWorkspaceRoute());
    }
    if (viewlessProjectId !== null) {
      const gone = goneBinding();
      if (gone) return Promise.reject(gone);
      // Never an unwired fallback to focus: no route is a dead binding.
      if (!viewlessDispatch) return Promise.reject(new SessionBindingError(NO_VIEW_HANDLE));
      const boundContext = deps.sessionStore.sessionContextMap.get(sessionId);
      return viewlessDispatch(viewlessProjectId, actionId, args, confirmed, sessionOrigin, {
        ...(boundContext ? { contextOverride: boundContext } : {}),
        ...(authorization !== undefined ? { authorization } : {}),
      });
    }
    const id = deps.sessionStore.sessionWebContentsMap.get(sessionId);
    if (id !== undefined && pinnedDispatch) {
      // Replay the provision-time context snapshot so the assistant's
      // tool call targets the worktree/terminal the user had focused
      // when they launched it — not wherever focus drifted to during
      // the model's turn (#8317). Absent for context-less sessions, in
      // which case pinned dispatch falls back to live renderer context.
      const boundContext = deps.sessionStore.sessionContextMap.get(sessionId);
      return authorization !== undefined || assistantRequester !== undefined
        ? pinnedDispatch(id, actionId, args, confirmed, boundContext, sessionOrigin, {
            ...(authorization !== undefined ? { authorization } : {}),
            ...(assistantRequester !== undefined ? { requester: assistantRequester } : {}),
          })
        : pinnedDispatch(id, actionId, args, confirmed, boundContext, sessionOrigin);
    }
    const gone = goneBinding();
    if (gone) return Promise.reject(gone);
    // Unpinned external/api-key dispatch — surface the requesting bearer's
    // identity so the confirm dialog can name the client (#9157). Returns
    // null (→ undefined) for help-session bearers, so callerInfo never
    // reaches the renderer for the assistant's own dispatches.
    const callerInfo = host.getBearerInfoForSession(sessionId) ?? undefined;
    return authorization !== undefined
      ? deps.dispatchAction(actionId, args, confirmed, callerInfo, sessionOrigin, authorization)
      : deps.dispatchAction(actionId, args, confirmed, callerInfo, sessionOrigin);
  };

  /**
   * Ask the user about a pane call above its tier, without running it
   * (#12692). Pane-only: every other session's tier is a ceiling, so there is
   * nothing to ask. Routed exactly as the pane's dispatches are, so the dialog
   * appears in the view the call would land in — and fails the same way when
   * that view is gone.
   */
  const requestApproval: import("./sessionServer.js").SessionServerDeps["requestApproval"] =
    paneDispatchOptions !== undefined && boundWorkspaceId !== null
      ? (actionId, args) =>
          workspaceDispatch
            ? workspaceDispatch(boundWorkspaceId, actionId, args, false, sessionOrigin, {
                ...paneDispatchOptions,
                approvalOnly: true,
              })
            : Promise.reject(missingWorkspaceRoute())
      : undefined;

  /**
   * Ask the user whether Daintree's own assistant may close panels it did not
   * open, or whose agent is busy, without closing anything yet (#12881).
   * Routed to the window the session is pinned to, where the close would
   * land. With no pin there is nobody to ask, so this rejects and the session
   * server refuses the close rather than running it unasked.
   */
  const requestCloseApproval: import("./sessionServer.js").SessionServerDeps["requestCloseApproval"] =
    (actionId, args) => {
      const id = deps.sessionStore.sessionWebContentsMap.get(sessionId);
      if (id === undefined || !pinnedDispatch) {
        return Promise.reject(
          new Error("No Daintree window is pinned to this session to ask the user.")
        );
      }
      return pinnedDispatch(
        id,
        actionId,
        args,
        false,
        deps.sessionStore.sessionContextMap.get(sessionId),
        sessionOrigin,
        {
          approvalOnly: true,
          approvalReason: "protected-close",
          ...(assistantRequester !== undefined ? { requester: assistantRequester } : {}),
        }
      );
    };

  const getCachedManifest: import("./sessionServer.js").SessionServerDeps["getCachedManifest"] =
    () => {
      // Pinned sessions never read the shared manifest cache (it could serve
      // another window's tool surface). Instead they read a per-WebContents
      // cache keyed by the build-time-captured pinned id (#9887), so the
      // per-call `lookupManifestEntry` hot path hits a warm cache rather than
      // re-fetching the full manifest on every dispatch — while still never
      // crossing windows. Reading the captured id (not a live map lookup)
      // means a session torn down mid-call stays pinned here and fails closed
      // to `null` (evicted cache) rather than flipping to the shared cache.
      // Workspace-bound sessions get the same treatment against the view that
      // currently owns their workspace (#11789).
      if (boundWorkspaceId !== null) {
        return (
          deps.getCachedManifestForWorkspace?.(boundWorkspaceId, preferredWebContentsId) ?? null
        );
      }
      if (pinnedWebContentsId !== null) {
        return deps.getCachedManifestForWebContents?.(pinnedWebContentsId) ?? null;
      }
      if (viewlessProjectId !== null) return viewlessBaseManifest();
      return deps.getCachedManifest();
    };

  const {
    notifyTierMismatch,
    recordDenial,
    notifySessionRevoked,
    notifyToolCallStarted,
    notifyToolCallSettled,
    notifyDisplayImage,
  } = createSessionNotifiers(deps, host);

  return {
    sessionStore: deps.sessionStore,
    // Forwarded so the session server can echo it in the `initialize` result
    // (#11789) — a client must be able to verify where its calls will land
    // before it issues the first mutation.
    ...(workspaceBinding ? { workspaceBinding } : {}),
    ...(preferredWebContentsId !== undefined ? { preferredWebContentsId } : {}),
    requestManifest,
    dispatchAction,
    revealOwnedRun,
    ...(requestApproval !== undefined ? { requestApproval } : {}),
    ...(requestApproval !== undefined && paneBinding?.skipConfirmations === true
      ? { paneSkipConfirmations: true }
      : {}),
    requestCloseApproval,
    handleWaitUntilIdle: deps.handleWaitUntilIdle,
    handleWaitUntilIdleBatch: deps.handleWaitUntilIdleBatch,
    handleSkillsSearch: (rawArgs) =>
      deps.handleSkillsSearch(rawArgs, { projectId: skillsProjectId() }),
    handleSkillsLoad: (rawArgs) => deps.handleSkillsLoad(rawArgs, { projectId: skillsProjectId() }),
    handleProjectRunCheck: deps.handleProjectRunCheck,
    handleProjectRunCommand: deps.handleProjectRunCommand,
    handleTerminalGetStatusViewless: deps.handleTerminalGetStatusViewless,
    handleTerminalReadLastMessageOwned: deps.handleTerminalReadLastMessageOwned,
    isTerminalIdInUse: deps.isTerminalIdInUse,
    ...(deps.readTerminalCloseContext !== undefined
      ? { readTerminalCloseContext: deps.readTerminalCloseContext }
      : {}),
    ...(deps.readClosedPanelProcess !== undefined
      ? { readClosedPanelProcess: deps.readClosedPanelProcess }
      : {}),
    ...(deps.readTerminalProcesses !== undefined
      ? { readTerminalProcesses: deps.readTerminalProcesses }
      : {}),
    ...(deps.readWorktreeGit !== undefined ? { readWorktreeGit: deps.readWorktreeGit } : {}),
    ...(deps.waitForClosedPanelExits !== undefined
      ? { waitForClosedPanelExits: deps.waitForClosedPanelExits }
      : {}),
    ...(deps.terminalGenerationOf !== undefined
      ? { terminalGenerationOf: deps.terminalGenerationOf }
      : {}),
    ...(deps.trackedTerminalIds !== undefined
      ? { trackedTerminalIds: deps.trackedTerminalIds }
      : {}),
    isTerminalInPinnedWorkspace,
    ...(deps.replyWaiter !== undefined ? { replyWaiter: deps.replyWaiter } : {}),
    ...(deps.terminalNotify !== undefined ? { terminalNotify: deps.terminalNotify } : {}),
    // A relayed session is never this machine's assistant: no lane, and no
    // hosts of its own to reach, so a call never chains (#13493).
    ...(relay
      ? {
          relay: {
            shellName: relay.shellName,
            ...(relay.global === true ? { global: true as const } : {}),
            refuseWrite: (projectId: string | undefined) => {
              if (boundWorkspaceId === null) return null;
              if (projectId !== undefined && projectId !== boundWorkspaceId) {
                return {
                  code: "VALIDATION_ERROR",
                  message: `This call can only act in project ${boundWorkspaceId}, the one it was made for. Nothing was run.`,
                };
              }
              // Run while nobody drives the project, or while the
              // requesting Shell's own view does (#13501): for this
              // machine's own assistant, any view of this machine's (#14024).
              const standing = relayWriteStanding(
                boundWorkspaceId,
                relay.linkSessionId,
                relay.local === true
              );
              if (standing.kind === "vacant" || standing.kind === "own-view") return null;
              const refused =
                standing.kind === "unavailable"
                  ? new DriveHolderUnavailableError(boundWorkspaceId)
                  : new RelayDrivenElsewhereError(boundWorkspaceId, standing.holderName, {
                      local: relay.local === true,
                    });
              return { code: "DRIVEN_ELSEWHERE", message: refused.message };
            },
          },
        }
      : {
          // A project's runner is a change this process makes itself, so one
          // with no view runs it only while nobody drives the project (#13511).
          ...(viewlessProjectId !== null
            ? {
                refuseWrite: (projectId: string | undefined) => {
                  if (projectId !== undefined && projectId !== viewlessProjectId) {
                    return {
                      code: "VALIDATION_ERROR",
                      message: `This assistant can only act in project ${viewlessProjectId}, its own, while no window shows it. Nothing was run.`,
                    };
                  }
                  const standing = relayWriteStanding(viewlessProjectId, null);
                  if (standing.kind === "vacant") return null;
                  const refused =
                    standing.kind === "unavailable"
                      ? new DriveHolderUnavailableError(viewlessProjectId)
                      : new RelayDrivenElsewhereError(
                          viewlessProjectId,
                          standing.kind === "elsewhere" ? standing.holderName : null,
                          { withoutView: true }
                        );
                  return { code: "DRIVEN_ELSEWHERE", message: refused.message };
                },
              }
            : {}),
          // Whichever help session this transport is bound to; the runtime decides if it may (#13493).
          hostControl: bindHostControl(() => deps.sessionStore.sessionHelpIdMap.get(sessionId)),
        }),
    assistantControl: host.assistantControl,
    // Only a session relayed for a Shell's global Assistant (#14551), read
    // from the binding as each call finds it.
    ...(relay?.global === true
      ? {
          globalSteer: {
            prompt: async (...args) => boundSteer(host).prompt(...args),
            keys: async (...args) => boundSteer(host).keys(...args),
            interrupt: async (...args) => boundSteer(host).interrupt(...args),
            reveal: async (target, show) => boundSteer(host).reveal(target, show),
          },
        }
      : {}),
    assistantCaller: () => assistantCallerFor(),
    ...(deps.readCodexQuota !== undefined ? { readCodexQuota: deps.readCodexQuota } : {}),
    // A pane bearer's own terminal is fixed for the bearer's life and was
    // resolved at handshake; a help lane's is read per call, because its
    // binding follows the PTY that currently serves it.
    resolveOwnPane: () => {
      if (relay) {
        // Its pane is on the Shell (#13500): notices go back to its sender,
        // held under the relay principal so neither this session closing
        // nor the link it came over ending loses them (#13930).
        const deliver = relay.deliverNotices;
        if (deliver === undefined || boundWorkspaceId === null) return null;
        return relayNoticePane(relayOwnershipPrincipal(relay.senderId, relay.helpSessionId), {
          projectId: boundWorkspaceId,
          helpSessionId: relay.helpSessionId,
          deliver,
        });
      }
      if (ownPane) return ownPane;
      if (helpSessionId === null) return null;
      const terminalId = host.helpSessionTerminalResolver()?.(helpSessionId) ?? null;
      return terminalId === null ? null : { key: helpNotifyKey(helpSessionId), terminalId };
    },
    appendAuditRecord: (input) => {
      // Scrub structural secrets BEFORE the truncation step inside
      // `summarizeMcpArgs` — running the scrubber after truncation would
      // miss bearer tokens whose body got cut below the scrubber's
      // 8-char minimum match length.
      // Stamp the turn id from the dispatch-start snapshot (#10067), never a
      // fresh read at write time — by the time the audit lands the FSM may
      // have cleared the turn, which would split this call away from the
      // started/settled strip events that already carry it.
      // `capturedTurnId` is the transport-only carrier — peel it off so it
      // never lands in the persisted record (the stamped `turnId` is the
      // public field).
      const { capturedTurnId, relayCallId, ...recordInput } = input;
      const turnId = capturedTurnId ?? null;
      // A relayed call's output is the asking machine's to keep (#13493).
      const resultSummary = relay
        ? null
        : summarizeAuditOutcome(input.toolId, input.outcome, (s) => scrubSecrets(sanitizePath(s)));
      // `summarizeAuditOutcome` returns null for all gate outcomes by
      // contract — the wait-time hint for `rate_limited` reaches the audit
      // record through `resultMeta` instead, so the recent-calls popover
      // can surface the integer-seconds value the agent already received
      // in the JSON-RPC error (`details: { retryAfter }`) without
      // re-scrubbing display text or polluting the tool-output summary
      // (#10014).
      const resultMeta =
        input.outcome.kind === "rate_limited"
          ? { retryAfter: input.outcome.retryAfter }
          : undefined;
      deps.auditService.appendRecord({
        ...recordInput,
        argsSummary: summarizeMcpArgs(
          relay
            ? projectRelayedAuditArgs(input.toolId, input.args)
            : projectAuditArgs(input.toolId, input.args),
          (s) => scrubSecrets(sanitizePath(s)),
          auditVerbatimArgKeys(input.toolId)
        ),
        ...(turnId !== null ? { turnId } : {}),
        ...(helpSessionId !== null ? { helpSessionId } : {}),
        ...(resultSummary !== null ? { resultSummary } : {}),
        ...(resultMeta !== undefined ? { resultMeta } : {}),
        // Who asked from another machine, told apart from this machine's own calls (#13493).
        ...(relay
          ? {
              relay: {
                shellName: relay.shellName,
                sender: relay.senderId.slice(0, 16),
                helpSessionId: relay.helpSessionId,
                ...(relayCallId !== undefined ? { callId: relayCallId } : {}),
              },
            }
          : {}),
      });
    },
    getCachedManifest,
    notifyTierMismatch,
    recordDenial,
    notifySessionRevoked,
    clearDenialState: (sessionId) => {
      deps.abusePolicy.dropSession(sessionId);
    },
    // Single live read of the turn register, called once per dispatch from
    // sessionServer (#10067). Closes over the build-time `helpSessionId` so
    // the snapshot it returns is the turn this session's call is part of.
    getCurrentTurnId: () =>
      helpSessionId !== null
        ? deps.turnOutcomeService.getCurrentTurnIdForSession(helpSessionId)
        : null,
    // Live, never snapshotted (#12874): "Always ask" takes effect on the
    // assistant's next call. sessionServer consults it for help sessions only.
    // The default follows the skip setting of the agent this session runs,
    // else the assistant's chosen agent (#14141).
    readAssistantConfirmationsSkipped: () =>
      readAssistantConfirmationsSkipped(
        (helpSessionId !== null
          ? host.assistantControlBinding()?.sessionAgent?.(helpSessionId)
          : null) ?? null
      ),
    notifyToolCallStarted,
    notifyToolCallSettled,
    notifyDisplayImage,
    ...(boundWorkspaceId !== null && noteToolListRoute
      ? {
          noteToolListRoute: () =>
            noteToolListRoute(sessionId, boundWorkspaceId, preferredWebContentsId),
        }
      : {}),
  };
}
