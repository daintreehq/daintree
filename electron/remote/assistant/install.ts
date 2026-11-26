import type Database from "better-sqlite3";
import type { HostProjectSummary } from "../../../shared/types/ipc/remoteHosts.js";
import { LOCAL_HOST_ID, type HostId } from "../../../shared/types/remoteHosts.js";
import { isRemoteEndpointHandle, NO_VIEW_HANDLE } from "../../ipc/endpoint.js";
import { getLocalAgentDirectory } from "../../services/assistants/localAgentDirectory.js";
import { events } from "../../services/events.js";
import {
  loadedHelpSessionService,
  whenHelpSessionServiceLoads,
} from "../../services/helpSessionRuntime.js";
import {
  globalAssistantCoordinatorSlot,
  onGlobalAssistantStandDown,
  peekGlobalAssistantService,
} from "../../services/globalAssistant.js";
import { isProjectlessAppView } from "../../window/projectlessViews.js";
import {
  GLOBAL_ASSISTANT_SLOT,
  isGlobalAssistantId,
  isGlobalAssistantSlot,
} from "../../../shared/config/globalAssistant.js";
import { setHostControlRuntime } from "../../services/mcp-server/hostControlTools.js";
import {
  keptLocalRelayConversations,
  noteLocalRelayCall,
} from "../../services/mcp-server/assistantPaneCreations.js";
import {
  prepareAssistantDelegation,
  readAssistantChecksNextFallback,
  readAssistantConfirmationsSkipped,
} from "../../services/mcp-server/assistantConfirmationsPreference.js";
import type { LaneWake } from "../../services/mcp-server/terminalNotify.js";
import { getSharedDb, getSharedSqlite } from "../../services/persistence/db.js";
import { machineDisplayName } from "../../utils/machineName.js";
import { getPtyClient } from "../../window/serviceRefs.js";
import {
  getProjectForWebContents,
  getShownAppWebContents,
  getWindowForWebContents,
} from "../../window/webContentsRegistry.js";
import type { LinkSession } from "../link/session.js";
import { getLocalSummaryLoop } from "../metrics/localLoop.js";
import { agentWaitingOf, type AgentWaitingListener } from "../metrics/agentWaiting.js";
import { getRemoteService, registerRemoteService } from "../runtime.js";
import {
  HostCallRuntime,
  type HostCallerRefusal,
  type HostCallRuntimeDeps,
  type ObservedHost,
  type OpenRun,
} from "./HostCallRuntime.js";
import { HostControlLinkClient } from "./HostControlLinkClient.js";
import {
  noteAssistantToolAnswer,
  workerLaunchesIn,
} from "../../services/scheduledRuns/assistantWorkerLaunches.js";
import {
  createLocalMcpRelay,
  LOCAL_RELAY_LINK_SESSION_ID,
  LOCAL_RELAY_SENDER_ID,
} from "./localMcpRelay.js";
import { withLocalPluginTools } from "./localPluginTools.js";
import { relayCallerOf } from "./mcpRelayExecutor.js";
import { forgetRetiredSends, readRetiredSends } from "./retiredSends.js";
import { AssistantSenderCredentials } from "./senderCredentials.js";
import { AppError } from "../../utils/errorTypes.js";
import { createLogger } from "../../utils/logger.js";

const logger = createLogger("main:install");

declare module "../runtime.js" {
  interface RemoteServices {
    /** What a host's dialogs are checked against: whether this Shell has a call out to it. */
    hostCallRelayClient: Pick<
      HostCallRuntime,
      | "hasCallInFlight"
      | "skipsRelayedDispatch"
      | "cancelledRelayedCall"
      | "relayedDelegation"
      | "offersNextFallback"
      | "awaitsNotices"
      | "holdsThrowawayRuns"
      | "holdsLaunchedAgents"
      | "receiveNotices"
      | "noticeCalls"
      | "receiveNoticeStatus"
      | "receiveApproval"
    >;
    hostControlLinkClient: HostControlLinkClient;
  }
}

/**
 * The session service's lookups, read without loading it: Remote Hosts starts
 * at launch, and a help session id exists only once the service has minted
 * it, so until then each answers as it would for an unknown session.
 */
const helpSessions = {
  getScheduledRunOf: (sessionId: string) =>
    loadedHelpSessionService()?.getScheduledRunOf(sessionId) ?? null,
  getSessionLane: (sessionId: string) =>
    loadedHelpSessionService()?.getSessionLane(sessionId) ?? null,
  getRunningLaneSession: (projectId: string, slot: number) =>
    loadedHelpSessionService()?.getRunningLaneSession(projectId, slot) ?? null,
  getWebContentsIdForSessionId: (sessionId: string) =>
    loadedHelpSessionService()?.getWebContentsIdForSessionId(sessionId) ?? null,
  getSessionAgent: (sessionId: string) =>
    loadedHelpSessionService()?.getSessionAgent(sessionId) ?? null,
  listRunningLanes: () => loadedHelpSessionService()?.listRunningLanes() ?? [],
  getConversationOwnershipId: (sessionId: string) =>
    loadedHelpSessionService()?.getConversationOwnershipId(sessionId) ?? null,
};

/**
 * Whether a help session belongs to no view yet because this machine's own
 * schedule started it (#16169): main's, like the global assistant, until one
 * of this machine's views takes it over. One a remote Shell's view holds
 * never counts.
 */
function isOwnScheduledWithoutView(helpSessionId: string, handle: number): boolean {
  return handle === NO_VIEW_HANDLE && helpSessions.getScheduledRunOf(helpSessionId) !== null;
}

/**
 * Whether a view is in front of the person: its window's current app view,
 * never a cached project view, in a window that is visible and not minimized.
 */
function isOnScreen(webContentsId: number): boolean {
  const view = getShownAppWebContents().find((contents) => contents.id === webContentsId);
  if (!view) return false;
  const win = getWindowForWebContents(view);
  return win !== null && !win.isDestroyed() && win.isVisible() && !win.isMinimized();
}

/** How long a host's project listing may take to name a worker's project before it goes unnamed. */
const HOST_PROJECT_NAME_WAIT_MS = 2_000;

/**
 * A call an assistant made through `host.call` was answered (#16169). A
 * launch it names is recorded on the schedule's run that started that
 * assistant, if one did; a host's project is named from the host's own
 * listing when it answers in time, this machine's from its own projects.
 */
function noteHostCallAnswer(
  answer: Parameters<NonNullable<HostCallRuntimeDeps["noteAnswered"]>>[0],
  listHostProjects: ((hostId: HostId) => Promise<readonly HostProjectSummary[]>) | undefined
): void {
  const runId = helpSessions.getScheduledRunOf(answer.helpSessionId)?.runId;
  if (runId === undefined) return;
  if (workerLaunchesIn(answer.tool, answer.args, answer.structured).terminalIds.length === 0) {
    return;
  }
  const local = answer.hostId === LOCAL_HOST_ID;
  const note = (projectName: string | null) =>
    noteAssistantToolAnswer({
      helpSessionId: answer.helpSessionId,
      tool: answer.tool,
      args: answer.args,
      result: answer.structured,
      hostId: local ? null : answer.hostId,
      hostName: answer.hostName,
      projectId: answer.projectId,
      projectName,
      askedAt: answer.askedAt,
      runId,
    });
  if (local || listHostProjects === undefined) {
    note(null);
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  void Promise.race([
    listHostProjects(answer.hostId).then(
      (projects) => projects.find((project) => project.id === answer.projectId)?.name ?? null,
      () => null
    ),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), HOST_PROJECT_NAME_WAIT_MS);
    }),
  ]).then((name) => {
    clearTimeout(timer);
    note(name);
  });
}

/**
 * The run a help session answers in, when one of this machine's own views
 * shows it, or when it is this machine's global assistant (#14161), which
 * main owns and no view holds, or one of its schedules' assistants no view
 * has taken over yet (#16169). Otherwise, what it lacks (#18164).
 */
function localCallerOf(helpSessionId: string): OpenRun | HostCallerRefusal {
  const lane = helpSessions.getSessionLane(helpSessionId);
  if (lane === null) return "ended";
  const running = helpSessions.getRunningLaneSession(lane.projectId, lane.slot);
  if (running === null || running.sessionId !== helpSessionId) return "replaced";
  // An assistant a remote Shell's view runs here is that Shell's, never this one's.
  const handle = running.projectViewWebContentsId;
  if (!isGlobalAssistantId(lane.projectId) && !isOwnScheduledWithoutView(helpSessionId, handle)) {
    if (isRemoteEndpointHandle(handle)) return "remote-view";
    if (getProjectForWebContents(handle) !== lane.projectId) return "no-window";
  }
  const launchGeneration = getPtyClient()?.getLiveGeneration(running.terminalId) ?? null;
  if (launchGeneration === null) return "terminal-down";
  // A global session that isn't coordinating names no conversation (#18143):
  // the one it ran under while it coordinated is the coordinator's now.
  const standby =
    isGlobalAssistantId(lane.projectId) && globalAssistantCoordinatorSlot() !== lane.slot;
  const conversationOwnershipId = standby
    ? null
    : helpSessions.getConversationOwnershipId(running.sessionId);
  return {
    projectId: lane.projectId,
    slot: lane.slot,
    sessionId: running.sessionId,
    terminalId: running.terminalId,
    launchGeneration,
    ...(conversationOwnershipId !== null ? { conversationOwnershipId } : {}),
    ...(standby ? { standby: true as const } : {}),
  };
}

function localRunOf(helpSessionId: string): OpenRun | null {
  const found = localCallerOf(helpSessionId);
  return typeof found === "string" ? null : found;
}

let localMachineName: string | undefined;
let mcpServerModule: Promise<typeof import("../../services/McpServerService.js")> | undefined;
/** Loaded once: a session's end releases and retires through the same load, in order. */
function mcpServer(): Promise<typeof import("../../services/McpServerService.js")> {
  mcpServerModule ??= import("../../services/McpServerService.js").catch((error: unknown) => {
    mcpServerModule = undefined;
    throw error;
  });
  return mcpServerModule;
}

/** Queues a line on a run's own notice line, the one writer that types into its prompt. */
function queueOnNoticeLine(
  lane: { helpSessionId: string; terminalId: string; projectId: string },
  wake: LaneWake
): void {
  void import("../../services/McpServerService.js")
    .then(({ mcpServerService }) => mcpServerService.queueLaneWake(lane, wake))
    .catch((err: unknown) => {
      console.error("[HostControl] Queueing a line for an assistant failed:", err);
      try {
        wake.report({ kind: "unavailable", reason: "notices-off" });
      } catch (reportErr) {
        console.error("[HostControl] Recording a line's outcome failed:", reportErr);
      }
    });
}

export interface HostControlInstallDeps {
  /** Every host this Shell knows, as last observed; what `host.list` reads. */
  observeHosts(): ObservedHost[];
  /** A connected host's projects, for `host.list` to name. */
  listHostProjects?(hostId: HostId): Promise<readonly HostProjectSummary[]>;
  /** Dials a host this Shell holds no link to, for `host.list` to observe it connected. */
  connect?(hostId: HostId, timeoutMs: number): Promise<unknown>;
  /** The Shell's attempt to bring back a host whose link is down (#16170). */
  bringBack?: HostCallRuntimeDeps["bringBack"];
  /** The person's "assistant control" switch for a host: whether its assistant reaches it (#13493). */
  isHostControlEnabled(hostId: HostId): boolean;
  /**
   * Hears what hosts already report, for `host.watch` (#14463): links, the
   * host list and summaries. Held only while a watch is armed, or while
   * `host.list` waits for a host it dialed to send its first summary.
   */
  watchHosts?: HostCallRuntimeDeps["watchHosts"];
  /**
   * Hears hosts' agents starting to wait as they report it, for an agent
   * `host.watch` (#16188); held only while one is armed, and never dials.
   */
  watchHostAgents?(listener: AgentWaitingListener): () => void;
  /**
   * A host's agent terminals as it lists them, over a link already up and
   * never dialing (#16492): how a host's link held for agents its assistant
   * launched there is let go once they have ended.
   */
  listAgentTargets?: HostCallRuntimeDeps["listAgentTargets"];
}

/**
 * This machine's agents and its hosts' starting to wait (#16188): this one's
 * straight off its own transitions, the hosts' as they report them.
 */
function watchAgentsHere(
  listener: AgentWaitingListener,
  hosts: HostControlInstallDeps["watchHostAgents"]
): () => void {
  const offLocal = events.on("agent:state-changed", (payload) => {
    const seen = agentWaitingOf(payload, getPtyClient());
    if (seen !== null) listener(LOCAL_HOST_ID, { ...seen, source: "event" });
  });
  const offHosts = hosts?.(listener);
  return () => {
    offLocal();
    offHosts?.();
  };
}

/**
 * Registers the Shell's `host.list` and `host.call` runtime, and what runbook
 * search is told of this machine's hosts; the returned teardown removes them.
 */
export function installHostControl(deps: HostControlInstallDeps): () => void {
  const machineName = (): string => (localMachineName ??= machineDisplayName());
  // The global Assistant's reach into a project's plugin agent tools (#18254),
  // loaded by its first list or call.
  let pluginTools:
    | Promise<
        import("../../services/pluginAgentMcp/globalAssistantTools.js").GlobalAssistantPluginTools
      >
    | undefined;
  const globalPluginTools = () =>
    (pluginTools ??= Promise.all([
      import("../../services/pluginAgentMcp/globalAssistantTools.js"),
      mcpServer(),
      import("../../services/mcp-server/relayWriteRule.js"),
      import("../../services/mcp-server/rendererBridge.js"),
    ]).then(
      ([
        { createGlobalAssistantPluginTools },
        { mcpServerService },
        { relayWriteStanding },
        { DriveHolderUnavailableError, RelayDrivenElsewhereError },
      ]) =>
        createGlobalAssistantPluginTools({
          activatePlugin: (pluginInstanceId) =>
            mcpServerService.activateAgentMcpPlugin(pluginInstanceId),
          // Its acting calls stop when coordination leaves it (#18143), so a
          // session in standby starts nothing here either.
          isSessionLive: (helpSessionId) => {
            const run = localRunOf(helpSessionId);
            return run !== null && isGlobalAssistantId(run.projectId) && run.standby !== true;
          },
          // A plugin's tool may change the project, so it runs only while
          // another machine doesn't drive it, as any other relayed change.
          refuseWrite: (projectId) => {
            const standing = relayWriteStanding(projectId, LOCAL_RELAY_LINK_SESSION_ID, true);
            if (standing.kind === "vacant" || standing.kind === "own-view") return null;
            return standing.kind === "unavailable"
              ? new DriveHolderUnavailableError(projectId).message
              : new RelayDrivenElsewhereError(projectId, standing.holderName, { local: true })
                  .message;
          },
        }),
      (error: unknown) => {
        pluginTools = undefined;
        throw error;
      }
    ));
  // This machine's other projects, reached under its own id (#14024): admitted
  // as a host admits another machine's calls, and answered back into the
  // runtime as a host's notices and questions are.
  const local = createLocalMcpRelay({
    machineName,
    hasProject: async (projectId) => {
      const { projectStore } = await import("../../services/ProjectStore.js");
      return projectStore.getProjectById(projectId) !== null;
    },
    openSession: async (spec) => {
      const [{ mcpServerService }, { helpSessionService }] = await Promise.all([
        import("../../services/McpServerService.js"),
        import("../../services/HelpSessionService.js"),
      ]);
      await helpSessionService.ensureAssistantControl();
      const session = await mcpServerService.openRelaySession({
        tier: spec.tier,
        workspaceId: spec.projectId,
        caller: relayCallerOf(spec),
      });
      return session === null ? null : withLocalPluginTools(session, spec, globalPluginTools);
    },
    // Nor anything the person handed it (#14161), even before its first call.
    releaseHandOvers: (helpSessionId) => {
      void mcpServer()
        .then(({ mcpServerService }) =>
          mcpServerService.releaseRelayAdoptions(LOCAL_RELAY_SENDER_ID, helpSessionId)
        )
        .catch((error: unknown) => {
          logger.warn("Couldn't release what was handed to an ended assistant", { error });
        });
    },
    endHeldSends: (helpSessionId) => {
      void mcpServer()
        .then(({ mcpServerService }) =>
          mcpServerService.endRelayHeldSends(LOCAL_RELAY_SENDER_ID, helpSessionId)
        )
        .catch((error: unknown) => {
          logger.warn("Couldn't drop what an ended assistant held for busy agents", { error });
        });
    },
    retirePrincipal: (senderId, helpSessionId, keepConversation) => {
      void mcpServer()
        .then(({ mcpServerService }) =>
          mcpServerService.retireRelayPrincipal(senderId, helpSessionId, keepConversation)
        )
        .catch((error: unknown) => {
          logger.warn("Couldn't retire a local relay principal", { error });
        });
    },
    forgetConversation: (senderId, conversationId) => {
      void mcpServer()
        .then(({ mcpServerService }) =>
          mcpServerService.forgetRelayConversation(senderId, conversationId)
        )
        .catch((error: unknown) => {
          logger.warn("Couldn't forget a local relay conversation", { error });
        });
    },
    // What a conversation here launched before a restart keeps the day its
    // caller would have had (#16845).
    keptConversations: () =>
      keptLocalRelayConversations()?.map((kept) => ({
        senderId: LOCAL_RELAY_SENDER_ID,
        ...kept,
      })) ?? null,
    noteConversationCall: (_senderId, conversationId, at) => noteLocalRelayCall(conversationId, at),
    receiveNotices: (payload) => runtime.receiveNotices(LOCAL_HOST_ID, payload),
    receiveApproval: (payload) => runtime.receiveApproval(LOCAL_HOST_ID, payload),
    nextFallback: (dispatch) => runtime.offersNextFallback(LOCAL_HOST_ID, dispatch),
    throwawayRuns: () => getRemoteService("hostThrowawayRuns") ?? null,
    readAgents: (options) => getLocalAgentDirectory().read(options),
  });
  // A global assistant session has no window of its own: it is asked in one
  // that shows that session, never the focused one, and not at all while none does.
  // `eligible` narrows the views that may answer, inside the global choice.
  const askingWindow = (
    helpSessionId: string,
    eligible: (webContentsId: number) => boolean = () => true
  ): number | null => {
    const lane = helpSessions.getSessionLane(helpSessionId);
    const webContentsId =
      lane !== null && isGlobalAssistantId(lane.projectId)
        ? (peekGlobalAssistantService(
            isGlobalAssistantSlot(lane.slot) ? lane.slot : GLOBAL_ASSISTANT_SLOT
          )?.presenterWebContentsId(
            // The Canopy window shows the assistant but mounts no approval dialog.
            (id) => !isProjectlessAppView(id) && eligible(id)
          ) ?? null)
        : helpSessions.getWebContentsIdForSessionId(helpSessionId);
    if (webContentsId === null || isRemoteEndpointHandle(webContentsId)) return null;
    return eligible(webContentsId) ? webContentsId : null;
  };
  const runtime = new HostCallRuntime({
    getSessionLane: (helpSessionId) => helpSessions.getSessionLane(helpSessionId),
    callerRun: localCallerOf,
    client: () => getRemoteService("hostControlLinkClient") ?? null,
    hosts: () => deps.observeHosts(),
    listHostProjects: deps.listHostProjects,
    connect: deps.connect,
    ...(deps.bringBack ? { bringBack: deps.bringBack } : {}),
    // The same reader Settings → Hosts reads a host's SSH keys through (#18258).
    sshHostKeys: () => getRemoteService("hostSshHostKeys") ?? null,
    // From provisioning, before the run is confirmed: the view a session was opened in.
    // The global assistant (#14161) is this machine's own with no view at all.
    inLocalView: (helpSessionId) => {
      const lane = helpSessions.getSessionLane(helpSessionId);
      if (lane !== null && isGlobalAssistantId(lane.projectId)) return true;
      const handle = helpSessions.getWebContentsIdForSessionId(helpSessionId);
      // A live session with no view answers null here; a schedule's is this machine's own.
      if (handle === null) {
        return lane !== null && helpSessions.getScheduledRunOf(helpSessionId) !== null;
      }
      return !isRemoteEndpointHandle(handle);
    },
    controlEnabled: (hostId) => deps.isHostControlEnabled(hostId),
    // Workers a schedule's assistant launched elsewhere, for its run (#16169).
    noteAnswered: (answer) => noteHostCallAnswer(answer, deps.listHostProjects),
    ...(deps.watchHosts ? { watchHosts: deps.watchHosts } : {}),
    watchAgents: (listener) => watchAgentsHere(listener, deps.watchHostAgents),
    pluginNotifications: async () =>
      (
        await import("../../services/assistantPluginNotifications.js")
      ).assistantPluginNotifications(),
    ...(deps.listAgentTargets ? { listAgentTargets: deps.listAgentTargets } : {}),
    // A host's question about a call it would run itself goes to the person in
    // the window of the assistant that made the call (#13501), never the
    // focused one: an assistant a remote Shell's view runs here has none.
    askApproval: async (ask) => {
      const webContentsId = askingWindow(ask.helpSessionId);
      if (webContentsId === null) return null;
      const { askHostApprovalInWindow } = await import("../client/viewRequests.js");
      return askHostApprovalInWindow(webContentsId, ask);
    },
    // This machine's own preference for the assistant that made the call, never
    // the host's (#15698), for the tool it called (#16752).
    confirmationsSkipped: (helpSessionId, calledActionId) =>
      readAssistantConfirmationsSkipped(
        helpSessions.getSessionAgent(helpSessionId),
        calledActionId
      ),
    // The same preference, ticked from the dialog that asks (#16752).
    prepareDelegation: (helpSessionId, calledActionId) =>
      prepareAssistantDelegation(helpSessions.getSessionAgent(helpSessionId), calledActionId),
    checksNextFallback: (helpSessionId, calledActionId) =>
      readAssistantChecksNextFallback(helpSessions.getSessionAgent(helpSessionId), calledActionId),
    // A host's settings, read and changed by name with no view there (#14167).
    settingsClient: () => getRemoteService("settingsControlClient") ?? null,
    askSettingsApproval: async ({ helpSessionId, ...ask }) => {
      const webContentsId = askingWindow(helpSessionId);
      if (webContentsId === null) return null;
      const { askSettingsApprovalInWindow } = await import("../client/viewRequests.js");
      return askSettingsApprovalInWindow(webContentsId, ask);
    },
    // An agent CLI's sign-in on a host, started for the window showing the
    // assistant and answered once that window opens it (#18197). Only a view
    // on screen counts: a cached project view or a hidden window shows nobody.
    startAgentSignIn: async ({ helpSessionId, hostId, hostName, agentId, signal }) => {
      const webContentsId = askingWindow(helpSessionId, isOnScreen);
      if (webContentsId === null) return "no_window";
      const canopyHosts = getRemoteService("canopyHosts");
      if (!canopyHosts) return "unsupported";
      return canopyHosts.offerSignIn(webContentsId, hostId, agentId, {
        hostName,
        // Told only while that view still shows the assistant on screen: a global
        // one moved to another window during the start isn't there any more.
        canDeliver: () =>
          askingWindow(helpSessionId, (id) => id === webContentsId && isOnScreen(id)) ===
          webContentsId,
        // Once its dialog is open there, being on screen is enough: the person
        // may be using it, wherever the assistant has gone since.
        stillShown: () => isOnScreen(webContentsId),
        ...(signal ? { signal } : {}),
      });
    },
    // A host's notice rides its run's own notice line (#13500).
    queueNotice: queueOnNoticeLine,
    // Through the Shell's switch service, with no window (#14140).
    ensureProject: (request) => {
      const service = getRemoteService("hostSwitchService");
      if (!service) {
        return Promise.reject(
          new AppError({ code: "UNSUPPORTED", message: "No host switch service" })
        );
      }
      return service.ensureForAssistant(request);
    },
    local: {
      name: machineName,
      projects: async () => {
        const [{ projectStore }, { isProjectFrontendAttached }] = await Promise.all([
          import("../../services/ProjectStore.js"),
          import("../../services/mcp-server/frontendAttachment.js"),
        ]);
        return projectStore.getProjectSummaries().map((project) => ({
          ...project,
          frontendAttached: isProjectFrontendAttached(project.id),
        }));
      },
      // The assistant's host contract names macOS and Linux, so this Windows
      // machine has no summary to offer in it.
      latestSummary: () => (process.platform === "win32" ? null : getLocalSummaryLoop().latest()),
      summaryReceipt: (summary) => getLocalSummaryLoop().receiptOf(summary),
      relayCall: (payload) => local.relayCall(payload),
      cancelCall: (helpSessionId, callId) => local.cancelCall(helpSessionId, callId),
      throwawayCall: (payload) => local.throwawayCall(payload),
      agents: (options) => getLocalAgentDirectory().read(options),
      status: (payload) => local.status(payload),
    },
  });
  // A help session that won't run again holds nothing it made in another
  // project; one relaunched onto a new PTY is the same assistant and keeps it.
  // Watched from the moment the service loads, before it can hold a session.
  let offSessionEnded: (() => void) | null = null;
  const cancelSessionWatch = whenHelpSessionServiceLoads((helpSessionService) => {
    offSessionEnded = helpSessionService.addSessionEndedListener(({ sessionId, reason }) => {
      // Its watches were the earlier run's, whichever way it ended (#14463).
      runtime.retireWatches(sessionId);
      if (reason === "relaunched") return;
      local.endHelpSession(sessionId);
      runtime.endHelpSession(sessionId);
      void pluginTools?.then((tools) => tools.endSession(sessionId)).catch(() => {});
    });
  });
  // Coordination left a global session (#18143): what it still had in flight stops.
  const offStandDown = onGlobalAssistantStandDown((sessionId) => runtime.standDown(sessionId));
  const unregisterRuntime = setHostControlRuntime(runtime);
  const unregisterCallRelay = registerRemoteService("hostCallRelayClient", runtime);
  return () => {
    cancelSessionWatch();
    offSessionEnded?.();
    offStandDown();
    unregisterCallRelay();
    unregisterRuntime();
    runtime.dispose();
    local.dispose();
    void pluginTools?.then((tools) => tools.dispose()).catch(() => {});
  };
}

/** How often a Shell with sends the retired inbox left open looks for an assistant to tell. */
const RETIRED_SENDS_RETRY_MS = 30_000;
const RETIRED_SENDS_WAKE_ID = "retired-exchanges";

/**
 * Tells one of this Shell's own assistants, once, which messages it sent
 * through the retired inbox will get no reply (#13496), then forgets them.
 * Which run sent each lived only in the process that sent it, so the line
 * goes to the first assistant here able to take it. Until one has, the
 * records stay, so a restart before then tells the next run instead.
 */
export function installRetiredSendsNotice(
  sqlite: Database.Database,
  deps: { hostName(hostId: HostId): string }
): () => void {
  let pending: Array<{ hostId: string; count: number }>;
  try {
    pending = readRetiredSends(sqlite);
    if (pending.length === 0) forgetRetiredSends(sqlite);
  } catch (error) {
    logger.warn("Couldn't read the retired inbox's sends", { error });
    return () => {};
  }
  if (pending.length === 0) return () => {};
  let disposed = false;
  let inFlight = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const finish = (): void => {
    disposed = true;
    if (timer !== undefined) clearInterval(timer);
  };
  const attempt = (): void => {
    if (disposed || inFlight) return;
    const run = helpSessions
      .listRunningLanes()
      .filter((lane) => lane.attached !== false)
      .map((lane) => helpSessions.getRunningLaneSession(lane.projectId, lane.slot))
      .map((running) => (running ? localRunOf(running.sessionId) : null))
      .find((found): found is OpenRun => found !== null);
    if (!run) return;
    inFlight = true;
    queueOnNoticeLine(
      { helpSessionId: run.sessionId, terminalId: run.terminalId, projectId: run.projectId },
      {
        id: RETIRED_SENDS_WAKE_ID,
        kind: "retired",
        retired: pending.map(({ hostId, count }) => ({ hostName: deps.hostName(hostId), count })),
        recheck: () => {
          const now = localRunOf(run.sessionId);
          return now?.terminalId === run.terminalId && now.launchGeneration === run.launchGeneration
            ? { kind: "ready" }
            : { kind: "unavailable", reason: "relaunched" };
        },
        beforeType: () => !disposed,
        report: (outcome) => {
          if (outcome.kind === "held") return;
          inFlight = false;
          // A line that may have been typed is not typed again.
          if (outcome.kind === "delivered" || outcome.kind === "ambiguous") {
            try {
              forgetRetiredSends(sqlite);
            } catch (error) {
              logger.warn("Couldn't forget the retired inbox's sends", { error });
            }
            finish();
          }
        },
      }
    );
  };
  attempt();
  if (!disposed) {
    timer = setInterval(attempt, RETIRED_SENDS_RETRY_MS);
    timer.unref?.();
  }
  return finish;
}

export interface HostControlLinkClientInstallDeps {
  /** The host's open session, connecting it if need be; null when it can't be reached. */
  session(hostId: HostId): Promise<LinkSession | null>;
  /** The host's session if one is open now, never connecting it or marking it used. */
  openSession?(hostId: HostId): LinkSession | null;
  onSessionOpened(listener: (hostId: HostId, session: LinkSession) => void): () => void;
  /** Hosts this Shell still knows; a removed host's credential goes with it. */
  knownHosts(): HostId[];
  onHostsChanged(listener: () => void): () => void;
  /** Keeps a host's connection open while the check says so; asked on every idle sweep. */
  addUseCheck?(check: (hostId: HostId) => boolean): () => void;
  /** A host's name as this Shell shows it, for the line about retired sends. */
  hostName(hostId: HostId): string;
  /**
   * Whether the host is being removed or re-pointed: no credential is minted
   * or presented for it meanwhile, since a link still up reaches the machine
   * it named until now (#17207).
   */
  isRetiring?(hostId: HostId): boolean;
}

function retiringHost(hostId: HostId): AppError {
  return new AppError({
    code: "HOST_DISCONNECTED",
    message: `Host ${hostId} is being removed or re-pointed`,
    userMessage: "Couldn't reach this host while it is being changed. Try again in a moment.",
  });
}

function openDatabase(): Database.Database | null {
  try {
    if (getSharedSqlite() === null) getSharedDb();
    return getSharedSqlite();
  } catch (err) {
    console.error("[HostControl] The database is unavailable:", err);
    return null;
  }
}

/**
 * Whether this Shell's assistants still use `hostId`'s link: a relayed call
 * running, the notices those calls armed until their host has nothing more
 * for them (#13500, #13930), a throwaway run one of them launched that may
 * still be going, which the host ends with the link (#15878), or agents one
 * of them launched there that the host still lists, so every window here
 * shows the host's counts of them (#16492). Holding the link never keeps
 * the host awake.
 */
export function assistantsUseHost(hostId: HostId): boolean {
  const relay = getRemoteService("hostCallRelayClient");
  return (
    relay?.hasCallInFlight(hostId) === true ||
    relay?.awaitsNotices(hostId) === true ||
    relay?.holdsThrowawayRuns(hostId) === true ||
    relay?.holdsLaunchedAgents(hostId) === true
  );
}

/**
 * Registers the Shell's link client for `host.call` over the app's database,
 * which keeps the sender credential it proves to each host. Without a
 * database nothing is registered: a sender this Shell can't keep would be a
 * stranger to its hosts on every start.
 */
export function installHostControlLinkClient(deps: HostControlLinkClientInstallDeps): () => void {
  const sqlite = openDatabase();
  if (!sqlite) {
    logger.warn("No database; this Shell's assistants can't reach its hosts");
    return () => {};
  }
  const credentials = new AssistantSenderCredentials(sqlite);
  const forgetRemovedHosts = (): void => {
    const known = new Set(deps.knownHosts());
    for (const hostId of credentials.hosts()) {
      if (!known.has(hostId)) credentials.forget(hostId);
    }
  };
  const offHosts = deps.onHostsChanged(forgetRemovedHosts);
  const retiring = (hostId: HostId): boolean => deps.isRetiring?.(hostId) === true;
  const client = new HostControlLinkClient({
    credential: (hostId) => {
      if (retiring(hostId)) throw retiringHost(hostId);
      return credentials.credential(hostId);
    },
    existingCredential: (hostId) => (retiring(hostId) ? null : credentials.existing(hostId)),
    forgetCredential: (hostId) => credentials.forget(hostId),
    session: deps.session,
    ...(deps.openSession ? { openSession: deps.openSession } : {}),
    onSessionOpened: deps.onSessionOpened,
    noticeReceiver: () => getRemoteService("hostCallRelayClient"),
    approvalReceiver: () => getRemoteService("hostCallRelayClient"),
  });
  client.start();
  const offUseCheck = deps.addUseCheck?.(assistantsUseHost) ?? (() => {});
  const unregister = registerRemoteService("hostControlLinkClient", client);
  const stopRetiredNotice = installRetiredSendsNotice(sqlite, { hostName: deps.hostName });
  return () => {
    stopRetiredNotice();
    offUseCheck();
    unregister();
    client.dispose();
    offHosts();
  };
}
