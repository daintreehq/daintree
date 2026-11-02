import { openWithDefaultApp } from "../../utils/openPath.js";
import { defineIpcNamespace, op } from "../define.js";
import { HELP_METHOD_CHANNELS } from "./help.preload.js";
import type * as HelpServiceModule from "../../services/HelpService.js";
import type * as HelpSessionServiceModule from "../../services/HelpSessionService.js";
import { getAgentAvailabilityStore } from "../../services/AgentAvailabilityStore.js";
import { webContents } from "electron";
import { getWindowForWebContents } from "../../window/webContentsRegistry.js";
import {
  isRemoteEndpointHandle,
  type ClientEndpoint,
  type RemoteEndpointCloseCause,
} from "../endpoint.js";
import { getEndpointRegistry } from "../endpointRegistry.js";
import { peekDriveLeaseService } from "../../services/DriveLeaseService.js";
import * as globalAssistant from "./helpGlobalAssistant.js";
import { installDetachedAdoption } from "./helpDetachedAdoption.js";
import { createLogger } from "../../utils/logger.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import type { HelpAssistantTier } from "../../../shared/types/ipc/maps.js";
import type { ActionContext } from "../../../shared/types/actions.js";
import {
  HELP_PAST_SESSIONS_LIMIT,
  type HelpAdoptResult,
  type HelpPastSession,
  type HelpPastSessionsListing,
  type PinnedActionContextSnapshot,
} from "../../../shared/types/ipc/help.js";
import { getPtyClient } from "../../window/serviceRefs.js";
import {
  DEFAULT_ASSISTANT_SLOT,
  isValidAssistantSlot,
} from "../../../shared/config/assistantSlots.js";

/**
 * Resolve a renderer-supplied slot (#12108). Absent means slot 0 — an older
 * renderer, or a caller that only ever had the one lane. Present but invalid
 * returns null so the handler refuses: clamping would silently act on a lane
 * the caller never named, and every one of these ops either displaces a
 * backend or consumes a resume token.
 */
function resolveSlot(value: unknown): number | null {
  // Only ABSENT means slot 0. An explicit `null` from an untyped renderer is a
  // supplied-but-invalid lane, and treating it as 0 would displace lane 0's
  // backend or consume its resume token on a caller that never named a lane.
  if (value === undefined) return DEFAULT_ASSISTANT_SLOT;
  return isValidAssistantSlot(value) ? value : null;
}

let cachedHelpService: typeof HelpServiceModule | null = null;
async function getHelpService(): Promise<typeof HelpServiceModule> {
  if (!cachedHelpService) {
    cachedHelpService = await import("../../services/HelpService.js");
  }
  return cachedHelpService;
}

let cachedHelpSessionService: typeof HelpSessionServiceModule | null = null;
async function getHelpSessionService(): Promise<typeof HelpSessionServiceModule> {
  if (!cachedHelpSessionService) {
    cachedHelpSessionService = await import("../../services/HelpSessionService.js");
  }
  return cachedHelpSessionService;
}

/** The session service if something has loaded it; nothing can be detached before then. */
function helpSessionServiceIfLoaded(): HelpSessionServiceModule.HelpSessionService | null {
  return cachedHelpSessionService?.helpSessionService ?? null;
}

async function handleGetFolderPath(): Promise<string | null> {
  const HelpService = await getHelpService();
  return HelpService.getHelpFolderPath();
}

/**
 * Scaffolds the global assistant content folder (~/.daintree/assistant —
 * README plus the .claude/.agents layout) and opens it in the OS file
 * manager. Returns null when scaffolding failed; otherwise the path plus
 * whether the OS opener accepted it (a broken file-manager association fails
 * silently apart from its error string), so the renderer can tell the user
 * where the folder is instead of showing nothing.
 */
async function handleOpenAssistantContentFolder(): Promise<{
  path: string;
  opened: boolean;
} | null> {
  const { ensureAssistantContentDir } = await import("../../services/AssistantContentMirror.js");
  let dir: string;
  try {
    dir = await ensureAssistantContentDir();
  } catch (err) {
    console.warn("[help] Failed to prepare the assistant content folder:", err);
    return null;
  }
  const openError = await openWithDefaultApp(dir);
  if (openError) {
    console.warn("[help] Failed to open the assistant content folder:", openError);
  }
  return { path: dir, opened: openError === "" };
}

function handleMarkTerminal(terminalId: string): void {
  getAgentAvailabilityStore().markAsHelp(terminalId);
}

function handleUnmarkTerminal(terminalId: string): void {
  getAgentAvailabilityStore().unmarkAsHelp(terminalId);
}

async function handleProvisionSession(
  ctx: import("../types.js").IpcContext,
  input: {
    projectId: string;
    projectPath: string;
    agentId: string;
    /**
     * Renderer `ActionContext` snapshot captured synchronously when the
     * user launched the assistant. Bound to the MCP session so pinned tool
     * dispatch targets the worktree/terminal focused at launch (#8317).
     */
    context?: ActionContext;
    /** Assistant lane to provision into (#12108). Absent means slot 0. */
    slot?: number;
    /** Refuse rather than displace a session already in that lane. */
    vacantOnly?: boolean;
  }
): Promise<{
  sessionId: string;
  sessionPath: string;
  token: string;
  tier: HelpAssistantTier;
  mcpUrl: string | null;
  windowId: number;
} | null> {
  const remote = ctx.senderWindow ? null : ctx.endpoint;
  if (!ctx.senderWindow && remote?.kind !== "remote-view") {
    console.warn("[help] provisionSession invoked without a senderWindow — skipping");
    return null;
  }
  const slot = resolveSlot(input.slot);
  if (slot === null) {
    console.warn("[help] provisionSession: slot out of range — refusing", { slot: input.slot });
    return null;
  }
  const { helpSessionService } = await getHelpSessionService();
  if (remote) return provisionForRemoteView(helpSessionService, remote, input, slot);
  return helpSessionService.provisionSession({
    projectId: input.projectId,
    projectPath: input.projectPath,
    agentId: input.agentId,
    windowId: ctx.senderWindow!.id,
    projectViewWebContentsId: ctx.webContentsId,
    actionContext: input.context,
    slot,
    vacantOnly: input.vacantOnly === true,
  });
}

/**
 * The project each remote view's help sessions were provisioned for. A
 * session is pinned to the view's endpoint handle, and an endpoint can be
 * rebound to another project without closing: its sessions go when it moves,
 * so an assistant launched for one project never acts in another. When it
 * closes they are detached instead, and outlive it (#13360).
 */
const remoteSessionProjects = new WeakMap<ClientEndpoint, { projectId: string | null }>();

const logger = createLogger("main:Help");

/**
 * Why a remote view's assistant is going. The kill that follows logs only a
 * terminal id and a graceful shutdown, which reads like a user closing an
 * agent; this line names the endpoint, its link session and the cause.
 */
type RemoteViewRevokeCause =
  | { cause: RemoteEndpointCloseCause | null }
  | { cause: "project-rebound"; previousProjectId: string | null };

function remoteViewFields(endpoint: ClientEndpoint, why: RemoteViewRevokeCause) {
  return {
    sessionId: endpoint.linkSessionId ?? null,
    clientId: endpoint.clientId,
    endpointId: endpoint.endpointId,
    handle: endpoint.handle,
    projectId: endpoint.projectId,
    ...why,
  };
}

function revokeRemoteViewSessions(
  helpSessionService: HelpSessionServiceModule.HelpSessionService,
  endpoint: ClientEndpoint,
  why: RemoteViewRevokeCause
): Promise<void> {
  const view = remoteViewFields(endpoint, why);
  const helpSessions = helpSessionService.helpSessionRefsForWebContentsId(endpoint.handle);
  if (helpSessions.length > 0) {
    logger.info("Revoking a remote view's help sessions", { ...view, helpSessions });
  }
  return helpSessionService.revokeByWebContentsId(endpoint.handle).catch((err: unknown) => {
    logger.warn("Revoking a remote view's help sessions failed", {
      ...view,
      reason: formatErrorMessage(err, "revoke failed"),
    });
  });
}

/**
 * The view went, and its running assistants outlive it (#13360). Logged like a
 * revoke, so the trail says they were kept rather than leaving their absence
 * from the kill log to be inferred.
 */
function detachRemoteViewSessions(
  helpSessionService: HelpSessionServiceModule.HelpSessionService,
  endpoint: ClientEndpoint,
  why: { cause: RemoteEndpointCloseCause | null }
): Promise<void> {
  const view = remoteViewFields(endpoint, why);
  const helpSessions = helpSessionService.helpSessionRefsForWebContentsId(endpoint.handle);
  if (helpSessions.length > 0) {
    logger.info("Detaching a remote view's help sessions", { ...view, helpSessions });
  }
  return helpSessionService.detachByWebContentsId(endpoint.handle).catch((err: unknown) => {
    logger.warn("Detaching a remote view's help sessions failed", {
      ...view,
      reason: formatErrorMessage(err, "detach failed"),
    });
  });
}

function trackRemoteViewSessions(
  helpSessionService: HelpSessionServiceModule.HelpSessionService,
  endpoint: ClientEndpoint,
  projectId: string
): void {
  const existing = remoteSessionProjects.get(endpoint);
  if (existing) {
    existing.projectId = projectId;
    return;
  }
  const tracked = { projectId: projectId as string | null };
  remoteSessionProjects.set(endpoint, tracked);
  const offChange = getEndpointRegistry().onChange(() => {
    if (endpoint.isClosed() || endpoint.projectId === tracked.projectId) return;
    const previousProjectId = tracked.projectId;
    tracked.projectId = endpoint.projectId;
    void revokeRemoteViewSessions(helpSessionService, endpoint, {
      cause: "project-rebound",
      previousProjectId,
    });
  });
  // A remote view has no WebContents here to be destroyed or evicted; its
  // endpoint closing is that moment. The assistant it launched is a process on
  // this host, though, and keeps running like the host's grid agents do: the
  // next view of the project takes it over (#13360).
  endpoint.onClose(() => {
    offChange();
    void detachRemoteViewSessions(helpSessionService, endpoint, {
      cause: endpoint.closeCause ?? null,
    });
  });
}

/**
 * Whether the PTY behind a detached assistant still runs, and what a pane
 * needs to show it. `hasTerminal` is main's own spawn registry, the same
 * liveness the eviction and idle-sweep floors read; the pty-host's record only
 * fills in the display fields, so a slow answer never reads as an exit.
 */
async function probeAssistantTerminal(
  terminalId: string
): Promise<HelpSessionServiceModule.HelpAdoptProbe | null> {
  const ptyClient = getPtyClient();
  if (!ptyClient?.hasTerminal(terminalId)) return null;
  const info = await ptyClient.getTerminalAsync(terminalId);
  // It can exit while the record is fetched; main's registry is the answer.
  if (info?.hasPty === false || !ptyClient.hasTerminal(terminalId)) return null;
  return {
    cwd: info?.cwd,
    title: info?.title,
    agentState: info?.agentState,
    waitingReason: info?.waitingReason,
    lastStateChange: info?.lastStateChange,
    cols: info?.ptyCols,
    rows: info?.ptyRows,
  };
}

function isAssistantTerminalLive(terminalId: string): boolean {
  return getPtyClient()?.hasTerminal(terminalId) === true;
}

/**
 * A view taking over the running assistant of its own project's lane
 * (#13360), ahead of any launch that would displace it: another machine's, or
 * since #13511 one of this machine's own windows. The project is the one the
 * view is bound to on this host, never the caller's word, so a view can only
 * ever reach its own project's assistant.
 */
async function handleAdoptDetachedSession(
  ctx: import("../types.js").IpcContext,
  projectId: string,
  rawSlot?: number
): Promise<HelpAdoptResult | null> {
  if (typeof projectId !== "string" || !projectId) return null;
  const slot = resolveSlot(rawSlot);
  if (slot === null) return null;
  if (ctx.senderWindow) return adoptForLocalView(ctx, ctx.senderWindow.id, projectId, slot);
  const endpoint = ctx.endpoint;
  if (endpoint?.kind !== "remote-view") return { status: "absent" };
  if (endpoint.projectId === null || endpoint.projectId !== projectId) {
    console.warn("[help] adoptDetachedSession: project is not the remote view's — refusing", {
      requested: projectId,
      fromView: endpoint.projectId,
    });
    return null;
  }
  const { helpSessionService } = await getHelpSessionService();
  trackRemoteViewSessions(helpSessionService, endpoint, projectId);
  const result = await helpSessionService.adoptDetachedSession(
    projectId,
    slot,
    endpoint.handle,
    probeAssistantTerminal
  );
  if (result.status !== "adopted") return result;
  // The view went while this ran. Closed, its close already found nothing
  // pinned to it, so hand the assistant back to the detached state; moved to
  // another project, it must not keep an assistant of this one.
  if (endpoint.isClosed()) {
    await detachRemoteViewSessions(helpSessionService, endpoint, {
      cause: endpoint.closeCause ?? null,
    });
    return null;
  }
  if (endpoint.projectId !== projectId) {
    await helpSessionService.revokeSession(result.lane.sessionId);
    return null;
  }
  return result;
}

/**
 * One of this machine's own windows taking over its project's assistant
 * (#13511). Its WebContents going is when the assistant is left with no view
 * again (`revokeByWebContentsId`), so a view torn down while this ran hands
 * it straight back.
 */
async function adoptForLocalView(
  ctx: import("../types.js").IpcContext,
  windowId: number,
  projectId: string,
  slot: number
): Promise<HelpAdoptResult | null> {
  if (!ctx.projectId || ctx.projectId !== projectId) {
    console.warn("[help] adoptDetachedSession: project is not the view's — refusing", {
      requested: projectId,
      fromView: ctx.projectId,
    });
    return null;
  }
  const { helpSessionService } = await getHelpSessionService();
  const result = await helpSessionService.adoptDetachedSession(
    projectId,
    slot,
    ctx.webContentsId,
    probeAssistantTerminal,
    { windowId }
  );
  if (result.status !== "adopted") return result;
  if (ctx.endpoint.isClosed()) {
    await helpSessionService.revokeByWebContentsId(ctx.webContentsId);
    return null;
  }
  return result;
}

/**
 * The assistant for a view on another machine runs here, as an agent PTY on
 * this host: the session directory, the bearer and the MCP config are this
 * host's own, written under its own userData and pointing at its own MCP
 * server, which is where the assistant's process will run. The project is the
 * one the endpoint is bound to, read from this host's records; the view names
 * it but cannot choose another, nor where it lives. The endpoint's handle
 * stands in for both the window and the view the session is pinned to, so the
 * assistant's tool calls go back to that view through its endpoint.
 */
async function provisionForRemoteView(
  helpSessionService: HelpSessionServiceModule.HelpSessionService,
  endpoint: ClientEndpoint,
  input: { projectId: string; agentId: string; context?: ActionContext; vacantOnly?: boolean },
  slot: number
): Promise<HelpSessionServiceModule.ProvisionResult | null> {
  // Loaded on use: the project store reads Electron's paths as it loads.
  const { projectStore } = await import("../../services/ProjectStore.js");
  const project =
    endpoint.projectId !== null && endpoint.projectId === input.projectId
      ? projectStore.getProjectById(endpoint.projectId)
      : null;
  if (!project) {
    console.warn("[help] provisionSession: project is not the remote view's — refusing", {
      requested: input.projectId,
      fromView: endpoint.projectId,
    });
    return null;
  }
  trackRemoteViewSessions(helpSessionService, endpoint, project.id);
  const result = await helpSessionService.provisionSession({
    projectId: project.id,
    projectPath: project.path,
    agentId: input.agentId,
    windowId: endpoint.handle,
    projectViewWebContentsId: endpoint.handle,
    actionContext: input.context,
    slot,
    vacantOnly: input.vacantOnly === true,
  });
  // The view closed or moved while this ran: the revoke for that found no
  // session yet, so this one would be left live with nobody to end it.
  if (result && (endpoint.isClosed() || endpoint.projectId !== project.id)) {
    await helpSessionService.revokeSession(result.sessionId);
    return null;
  }
  return result;
}

/**
 * Projects an `ActionContext` onto the narrow, display-only snapshot the
 * HelpPanel footer renders (#8772). Always reads the *active* worktree triple
 * together — `ActionContext` only carries name/branch for the active worktree,
 * so mixing in `focusedWorktreeId` would yield an id that doesn't match the
 * name/branch beside it. The session's tool calls target the active worktree
 * anyway. Returns null when the snapshot carries no identifying target (neither
 * worktree nor terminal), so the chip is suppressed rather than rendered empty.
 */
export function pinnedSnapshotFromContext(
  context: ActionContext | null
): PinnedActionContextSnapshot | null {
  if (!context) return null;
  const worktreeId = context.activeWorktreeId ?? null;
  const worktreeName = context.activeWorktreeName ?? null;
  const worktreeBranch = context.activeWorktreeBranch ?? null;
  const terminalId = context.focusedTerminalId ?? null;
  if (worktreeId === null && terminalId === null) return null;
  return { worktreeId, worktreeName, worktreeBranch, terminalId };
}

async function handleGetPinnedActionContext(
  ctx: import("../types.js").IpcContext,
  sessionId: string
): Promise<PinnedActionContextSnapshot | null> {
  if (typeof sessionId !== "string" || !sessionId) return null;
  const { helpSessionService } = await getHelpSessionService();
  // Per-window pin (#7002): only the renderer that minted the session may
  // read its pinned context. The data is display-only (no token), but
  // refusing cross-window reads keeps the namespace consistent with the rest
  // of the per-view isolation discipline.
  const ownerWebContentsId = helpSessionService.getWebContentsIdForSessionId(sessionId);
  if (ownerWebContentsId !== null && ownerWebContentsId !== ctx.webContentsId) {
    console.warn(
      "[help] getPinnedActionContext: webContents mismatch — refusing cross-window read",
      { fromWebContents: ctx.webContentsId, owner: ownerWebContentsId }
    );
    return null;
  }
  return pinnedSnapshotFromContext(helpSessionService.getActionContextForSessionId(sessionId));
}

async function handleRevokeSession(sessionId: string): Promise<void> {
  const { helpSessionService } = await getHelpSessionService();
  await helpSessionService.revokeSession(sessionId);
}

async function handlePeekPendingHibernation(
  ctx: import("../types.js").IpcContext,
  projectId: string,
  rawSlot?: number
): Promise<{
  agentId: string;
  agentSessionId: string;
  cwd: string;
  // #10815: in-memory-only flag stamped on eviction capture. Drives the
  // renderer's pull-on-mount cold switch-back auto-resume; disk-loaded
  // prior-session entries lack it (→ false) so app restart never auto-resumes.
  panelWasOpen: boolean;
  // #13360: the lane's assistant is still running, detached from the view that
  // went; the renderer takes it over rather than resuming a transcript.
  live?: boolean;
} | null> {
  if (typeof projectId !== "string" || !projectId) return null;
  // Same cross-project guard as the take handler below: a pending entry holds
  // an agent's resume token, so refuse reads for any project other than the
  // one bound to this renderer's webContents.
  if (!ctx.projectId || ctx.projectId !== projectId) {
    console.warn(
      "[help] peekPendingHibernation: projectId mismatch — refusing cross-project read",
      { requested: projectId, fromView: ctx.projectId, webContentsId: ctx.webContentsId }
    );
    return null;
  }
  const slot = resolveSlot(rawSlot);
  if (slot === null) return null;
  const { helpSessionService } = await getHelpSessionService();
  return helpSessionService.peekPendingHibernation(projectId, slot, liveLaneOptions(ctx));
}

/**
 * A view is also told about its project's assistants that outlived their last
 * view (#13360), so a cold one can bring them back rather than launch beside
 * them: another machine's view, and since #13511 one of this machine's own.
 */
function liveLaneOptions(
  ctx: import("../types.js").IpcContext
): { isTerminalLive: (terminalId: string) => boolean; viewHandle: number } | undefined {
  if (ctx.senderWindow) {
    return { isTerminalLive: isAssistantTerminalLive, viewHandle: ctx.webContentsId };
  }
  return ctx.endpoint.kind === "remote-view"
    ? { isTerminalLive: isAssistantTerminalLive, viewHandle: ctx.endpoint.handle }
    : undefined;
}

/**
 * Which lanes of this project hold an eviction-captured resume entry (#12108).
 *
 * A cold renderer has no memory of lanes 1+, so without this their captured
 * conversations would be stranded on disk with no tab to reach them from.
 * Same cross-project guard as the rest of the hibernation namespace; the reply
 * carries only slot numbers, never entry data.
 */
async function handleListPendingHibernationSlots(
  ctx: import("../types.js").IpcContext,
  projectId: string
): Promise<number[]> {
  if (typeof projectId !== "string" || !projectId) return [];
  if (!ctx.projectId || ctx.projectId !== projectId) {
    console.warn(
      "[help] listPendingHibernationSlots: projectId mismatch — refusing cross-project read",
      { requested: projectId, fromView: ctx.projectId, webContentsId: ctx.webContentsId }
    );
    return [];
  }
  const { helpSessionService } = await getHelpSessionService();
  return helpSessionService.listPendingHibernationSlots(projectId, liveLaneOptions(ctx));
}

/**
 * Past assistant conversations for this project (#13206), read from the agents'
 * own transcript stores. Same cross-project guard as the hibernation reads:
 * titles are conversation text, so only the view bound to the project may ask.
 *
 * Bare rows unless the caller asks for the listing (#14984): a shell on an
 * older build reaches this host over a remote link and expects an array.
 */
export async function handleListPastSessions(
  ctx: import("../types.js").IpcContext,
  projectId: string,
  options?: { listing?: boolean }
): Promise<HelpPastSessionsListing | HelpPastSession[]> {
  const listing = await listPastSessionsFor(ctx, projectId);
  return options?.listing === true ? listing : listing.sessions;
}

async function listPastSessionsFor(
  ctx: import("../types.js").IpcContext,
  projectId: string
): Promise<HelpPastSessionsListing> {
  // A refusal reads as no history at all, never as history that failed to load.
  const nothing: HelpPastSessionsListing = { sessions: [], unreadable: [], truncated: false };
  if (typeof projectId !== "string" || !projectId) return nothing;
  if (!ctx.projectId || ctx.projectId !== projectId) {
    console.warn("[help] listPastSessions: projectId mismatch — refusing cross-project read", {
      requested: projectId,
      fromView: ctx.projectId,
      webContentsId: ctx.webContentsId,
    });
    return nothing;
  }
  const [{ helpSessionService }, lister, claudeStore, codex, { projectStore }, { scratchStore }] =
    await Promise.all([
      getHelpSessionService(),
      import("../../services/helpPastSessions.js"),
      import("../../services/claude/ClaudeSessionStore.js"),
      import("../../services/codex/CodexSubagentService.js"),
      import("../../services/ProjectStore.js"),
      import("../../services/ScratchStore.js"),
    ]);
  // The path comes from main's own record of the view's workspace, never the
  // renderer: a path it supplied could name another project's history.
  const projectPath =
    projectStore.getProjectById(projectId)?.path ?? scratchStore.getScratchById(projectId)?.path;
  if (!projectPath) return nothing;
  const codexPath = helpSessionService.getSessionPathForProject(projectPath, "codex");
  const legacyPath = helpSessionService.getLegacySessionPathForProject(projectPath);
  const paths = {
    claude: helpSessionService.getSessionPathForProject(projectPath, "claude"),
    codex: codexPath === legacyPath ? [codexPath] : [codexPath, legacyPath],
  };
  return lister.listHelpPastSessions(paths, {
    claudeProjectsRoot:
      claudeStore.resolvePaneClaudeProjectsRoot() ?? lister.defaultClaudeProjectsRoot(),
    listCodexSessions: (cwd) =>
      codex.listCodexSessionsForCwd(cwd, undefined, HELP_PAST_SESSIONS_LIMIT),
  });
}

/**
 * The project's own starter prompts for the assistant's empty state. The path
 * comes from main's record of the view's workspace, never the renderer, and a
 * view may only ask about the project it is bound to.
 */
async function handleGetStarterPrompts(
  ctx: import("../types.js").IpcContext,
  projectId: string
): Promise<string[]> {
  if (typeof projectId !== "string" || !projectId) return [];
  if (!ctx.projectId || ctx.projectId !== projectId) return [];
  const [{ loadProjectStarterPrompts }, { projectStore }, { scratchStore }] = await Promise.all([
    import("../../services/AssistantUserConfig.js"),
    import("../../services/ProjectStore.js"),
    import("../../services/ScratchStore.js"),
  ]);
  const projectPath =
    projectStore.getProjectById(projectId)?.path ?? scratchStore.getScratchById(projectId)?.path;
  if (!projectPath) return [];
  return loadProjectStarterPrompts(projectPath);
}

async function handleTakePendingHibernation(
  ctx: import("../types.js").IpcContext,
  projectId: string,
  rawSlot?: number
): Promise<{
  agentId: string;
  agentSessionId: string;
  cwd: string;
  // #11477: opaque handle for putting this entry back if the launch aborts.
  claimId: string;
} | null> {
  if (typeof projectId !== "string" || !projectId) return null;
  // Derive the calling project from the renderer's webContents binding and
  // refuse cross-project pulls. Pending entries hold an agent's resume token
  // — leaking another project's token across processes would let a
  // compromised renderer continue a stranger's conversation. The renderer
  // still passes its projectId (for shape parity with the rest of the
  // namespace), but it must match the view-mapped id or we drop the call.
  if (!ctx.projectId || ctx.projectId !== projectId) {
    console.warn(
      "[help] takePendingHibernation: projectId mismatch — refusing cross-project pull",
      { requested: projectId, fromView: ctx.projectId, webContentsId: ctx.webContentsId }
    );
    return null;
  }
  const slot = resolveSlot(rawSlot);
  if (slot === null) return null;
  const { helpSessionService } = await getHelpSessionService();
  // The owner is the view's own id from context, never renderer-supplied — it
  // binds the resulting claim to this view so no other can release it (#11477).
  // With lanes the claim is keyed by (slot, claimId, owner), so one view
  // holding claims on several lanes keeps them independent.
  return helpSessionService.takePendingHibernation(projectId, slot, ctx.webContentsId);
}

async function handleRestorePendingHibernation(
  ctx: import("../types.js").IpcContext,
  projectId: string,
  claimId: string,
  rawSlot?: number
): Promise<boolean> {
  if (typeof projectId !== "string" || !projectId) return false;
  if (typeof claimId !== "string" || !claimId) return false;
  // Same cross-project guard as the peek/take handlers. The entry itself never
  // crosses the bridge — main restores from its own take-side stash — so this
  // only has to establish that the caller is the view that took it.
  if (!ctx.projectId || ctx.projectId !== projectId) {
    console.warn(
      "[help] restorePendingHibernation: projectId mismatch — refusing cross-project restore",
      { requested: projectId, fromView: ctx.projectId, webContentsId: ctx.webContentsId }
    );
    return false;
  }
  const slot = resolveSlot(rawSlot);
  if (slot === null) return false;
  const { helpSessionService } = await getHelpSessionService();
  return helpSessionService.restorePendingHibernation(projectId, slot, claimId, ctx.webContentsId);
}

/**
 * The user explicitly discarded a lane's conversation — Stop, Restart
 * conversation, or closing its tab (#13205). The only renderer path that clears
 * a lane's durable resume pointer; CLI exits and crashes leave it in place.
 */
async function handleDiscardConversation(
  ctx: import("../types.js").IpcContext,
  projectId: string,
  rawSlot?: number
): Promise<void> {
  if (typeof projectId !== "string" || !projectId) return;
  if (!ctx.projectId || ctx.projectId !== projectId) {
    console.warn(
      "[help] discardConversation: projectId mismatch — refusing cross-project discard",
      { requested: projectId, fromView: ctx.projectId, webContentsId: ctx.webContentsId }
    );
    return;
  }
  const slot = resolveSlot(rawSlot);
  if (slot === null) return;
  const { helpSessionService } = await getHelpSessionService();
  await helpSessionService.discardConversation(projectId, slot);
}

async function handleReportPanelOpen(
  ctx: import("../types.js").IpcContext,
  projectId: string,
  isOpen: boolean,
  /**
   * Whether the panel is actually ON SCREEN. Focus mode parks it off-canvas
   * with `isOpen` left true, and a parked assistant is one the project tallies
   * must stop reporting. Optional so an older renderer (or a caller that has
   * only the one fact) still reports exactly what it always did.
   */
  isVisible?: boolean
): Promise<void> {
  if (typeof projectId !== "string" || !projectId) return;
  if (typeof isOpen !== "boolean") return;
  const visible = typeof isVisible === "boolean" ? isVisible : isOpen;
  // Same cross-project guard as the hibernation handlers: only the renderer
  // bound to this project's webContents may report its panel state. A
  // mismatched report would let one view's open-state drive another's
  // cold-resume decision (#10815).
  if (!ctx.projectId || ctx.projectId !== projectId) {
    console.warn("[help] reportPanelOpen: projectId mismatch — refusing cross-project report", {
      requested: projectId,
      fromView: ctx.projectId,
      webContentsId: ctx.webContentsId,
    });
    return;
  }
  const { helpSessionService } = await getHelpSessionService();
  if (!helpSessionService.reportPanelOpen(projectId, isOpen, visible)) return;
  // Visibility moved, and nothing else will notice: the stats poll is driven by
  // agent, terminal and snooze events, none of which fire when a panel slides
  // away. Without this the row keeps reporting a hidden assistant until the
  // next tick — and a switcher opened inside that window freezes its band
  // membership around the stale answer.
  const { getProjectStatsService } = await import("./projectCrud/stats.js");
  const stats = getProjectStatsService();
  if (stats?.isStarted) stats.refresh();
}

export const helpNamespace = defineIpcNamespace({
  name: "help",
  ops: {
    getFolderPath: op(HELP_METHOD_CHANNELS.getFolderPath, handleGetFolderPath),
    openAssistantContentFolder: op(
      HELP_METHOD_CHANNELS.openAssistantContentFolder,
      handleOpenAssistantContentFolder
    ),
    markTerminal: op(HELP_METHOD_CHANNELS.markTerminal, handleMarkTerminal),
    unmarkTerminal: op(HELP_METHOD_CHANNELS.unmarkTerminal, handleUnmarkTerminal),
    provisionSession: op(HELP_METHOD_CHANNELS.provisionSession, handleProvisionSession, {
      withContext: true,
    }),
    revokeSession: op(HELP_METHOD_CHANNELS.revokeSession, handleRevokeSession),
    ensureGlobalAssistant: op(
      HELP_METHOD_CHANNELS.ensureGlobalAssistant,
      globalAssistant.handleEnsureGlobalAssistant,
      { withContext: true }
    ),
    getGlobalAssistantState: op(
      HELP_METHOD_CHANNELS.getGlobalAssistantState,
      globalAssistant.handleGetGlobalAssistantState
    ),
    attachGlobalAssistant: op(
      HELP_METHOD_CHANNELS.attachGlobalAssistant,
      globalAssistant.handleAttachGlobalAssistant,
      { withContext: true }
    ),
    detachGlobalAssistant: op(
      HELP_METHOD_CHANNELS.detachGlobalAssistant,
      globalAssistant.handleDetachGlobalAssistant,
      { withContext: true }
    ),
    claimGlobalAssistantInput: op(
      HELP_METHOD_CHANNELS.claimGlobalAssistantInput,
      globalAssistant.handleClaimGlobalAssistantInput,
      { withContext: true }
    ),
    releaseGlobalAssistantInput: op(
      HELP_METHOD_CHANNELS.releaseGlobalAssistantInput,
      globalAssistant.handleReleaseGlobalAssistantInput,
      { withContext: true }
    ),
    setGlobalAssistantInputEligible: op(
      HELP_METHOD_CHANNELS.setGlobalAssistantInputEligible,
      globalAssistant.handleSetGlobalAssistantInputEligible,
      { withContext: true }
    ),
    restartGlobalAssistant: op(
      HELP_METHOD_CHANNELS.restartGlobalAssistant,
      globalAssistant.handleRestartGlobalAssistant,
      { withContext: true }
    ),
    discardGlobalAssistant: op(
      HELP_METHOD_CHANNELS.discardGlobalAssistant,
      globalAssistant.handleDiscardGlobalAssistant,
      { withContext: true }
    ),
    getPinnedActionContext: op(
      HELP_METHOD_CHANNELS.getPinnedActionContext,
      handleGetPinnedActionContext,
      { withContext: true }
    ),
    peekPendingHibernation: op(
      HELP_METHOD_CHANNELS.peekPendingHibernation,
      handlePeekPendingHibernation,
      { withContext: true }
    ),
    takePendingHibernation: op(
      HELP_METHOD_CHANNELS.takePendingHibernation,
      handleTakePendingHibernation,
      { withContext: true }
    ),
    listPendingHibernationSlots: op(
      HELP_METHOD_CHANNELS.listPendingHibernationSlots,
      handleListPendingHibernationSlots,
      { withContext: true }
    ),
    adoptDetachedSession: op(
      HELP_METHOD_CHANNELS.adoptDetachedSession,
      handleAdoptDetachedSession,
      { withContext: true }
    ),
    restorePendingHibernation: op(
      HELP_METHOD_CHANNELS.restorePendingHibernation,
      handleRestorePendingHibernation,
      { withContext: true }
    ),
    discardConversation: op(HELP_METHOD_CHANNELS.discardConversation, handleDiscardConversation, {
      withContext: true,
    }),
    listPastSessions: op(HELP_METHOD_CHANNELS.listPastSessions, handleListPastSessions, {
      withContext: true,
    }),
    getStarterPrompts: op(HELP_METHOD_CHANNELS.getStarterPrompts, handleGetStarterPrompts, {
      withContext: true,
    }),
    reportPanelOpen: op(HELP_METHOD_CHANNELS.reportPanelOpen, handleReportPanelOpen, {
      withContext: true,
    }),
  },
});

function localViewIsUp(handle: number): boolean {
  const view = webContents.fromId(handle);
  return (
    view !== undefined && !view.isDestroyed() && !view.isCrashed() && !view.isLoadingMainFrame()
  );
}

/**
 * A view of a project coming back takes over that project's detached
 * assistants at once (#13389), its panel open or not: another machine's, or
 * since #13511 one of this machine's own windows. Until then the assistant's
 * Daintree tools run on the host with no view, and a change is refused while
 * someone drives the project, so an assistant left working, or one other
 * machines' assistants are messaging, would be held back until someone opened
 * its panel. Nothing launches. Only the view that drives the project takes
 * one (see `adoptForReturningViews`), and the service re-checks everything
 * under the lane's lock.
 */
function installDetachedAssistantAdoption(): () => void {
  // The lease service exists only once Host mode is installed, which may be
  // after this runs; its changes matter too, since a returning Shell gets the
  // lease back after its view attaches.
  let offLease: (() => void) | null = null;
  return installDetachedAdoption({
    detachedProjects: () => helpSessionServiceIfLoaded()?.detachedProjectIds() ?? [],
    // A window here whose renderer crashed or is reloading keeps its id, but
    // has nothing to run the assistant's calls yet; its load finishing runs
    // this again (`noteViewReady`).
    endpointsFor: (projectId) =>
      getEndpointRegistry()
        .getForProject(projectId)
        .filter((endpoint) => endpoint.kind === "remote-view" || localViewIsUp(endpoint.handle)),
    drivingEndpointId: (projectId) =>
      peekDriveLeaseService()?.getHolderEndpoint(projectId)?.endpointId ?? null,
    detachedSlots: (projectId) => helpSessionServiceIfLoaded()?.detachedSlots(projectId) ?? [],
    adopt: async (projectId, slot, endpoint) => {
      const { helpSessionService } = await getHelpSessionService();
      const view = isRemoteEndpointHandle(endpoint.handle)
        ? undefined
        : webContents.fromId(endpoint.handle);
      const windowId = view ? getWindowForWebContents(view)?.id : undefined;
      return helpSessionService.adoptDetachedSession(
        projectId,
        slot,
        endpoint.handle,
        probeAssistantTerminal,
        { keepRestoreIntent: true, ...(windowId !== undefined ? { windowId } : {}) }
      );
    },
    release: async (endpoint, projectId, adopted) => {
      const { helpSessionService } = await getHelpSessionService();
      // As the IPC path does: closed, back to detached; moved, never kept by another project.
      if (endpoint.kind !== "remote-view") {
        if (endpoint.isClosed()) await helpSessionService.revokeByWebContentsId(endpoint.handle);
      } else if (endpoint.isClosed()) {
        await detachRemoteViewSessions(helpSessionService, endpoint, {
          cause: endpoint.closeCause ?? null,
        });
      } else if (endpoint.projectId !== projectId) {
        await helpSessionService.revokeSession(adopted.lane.sessionId);
      }
    },
    adopted: (endpoint, projectId, slot, adopted) => {
      // A window here going is its WebContents going, which main already
      // follows; a remote view's endpoint is watched from here.
      const service = helpSessionServiceIfLoaded();
      if (service && endpoint.kind === "remote-view") {
        trackRemoteViewSessions(service, endpoint, projectId);
      }
      logger.info("A returning view took over its project's running assistant", {
        ...remoteViewFields(endpoint, { cause: null }),
        slot,
        helpSessionId: adopted.lane.sessionId,
      });
    },
    onChange: (listener) => {
      const watchLease = (): void => {
        if (offLease) return;
        const lease = peekDriveLeaseService();
        if (lease) offLease = lease.onChange(listener);
      };
      watchLease();
      const offRegistry = getEndpointRegistry().onChange(() => {
        watchLease();
        listener();
      });
      // An assistant left with no view while someone already drives its project.
      let disposed = false;
      let offDetached: (() => void) | null = null;
      void getHelpSessionService()
        .then(({ helpSessionService }) => {
          if (!disposed) offDetached = helpSessionService.addLaneDetachedListener(listener);
        })
        .catch((err: unknown) => {
          logger.warn("Watching for assistants left with no view failed", {
            reason: formatErrorMessage(err, "subscribe failed"),
          });
        });
      return () => {
        disposed = true;
        offRegistry();
        offLease?.();
        offLease = null;
        offDetached?.();
      };
    },
    onFailure: (err) => {
      logger.warn("Taking over a returning view's assistant failed", {
        reason: formatErrorMessage(err, "adopt failed"),
      });
    },
  });
}

export function registerHelpHandlers(): () => void {
  const unregister = helpNamespace.register();
  const offAdoption = installDetachedAssistantAdoption();
  return () => {
    offAdoption();
    unregister();
  };
}
