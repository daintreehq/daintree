import type Database from "better-sqlite3";
import type { HostProjectSummary } from "../../../shared/types/ipc/remoteHosts.js";
import { LOCAL_HOST_ID, type HostId } from "../../../shared/types/remoteHosts.js";
import { isRemoteEndpointHandle } from "../../ipc/endpoint.js";
import { getLocalAgentDirectory } from "../../services/assistants/localAgentDirectory.js";
import { helpSessionService } from "../../services/HelpSessionService.js";
import { peekGlobalAssistantService } from "../../services/globalAssistant.js";
import { isGlobalAssistantId } from "../../../shared/config/globalAssistant.js";
import { setHostControlRuntime } from "../../services/mcp-server/hostControlTools.js";
import { readAssistantConfirmationsSkipped } from "../../services/mcp-server/assistantConfirmationsPreference.js";
import type { LaneWake } from "../../services/mcp-server/terminalNotify.js";
import { getSharedDb, getSharedSqlite } from "../../services/persistence/db.js";
import { machineDisplayName } from "../../utils/machineName.js";
import { getPtyClient } from "../../window/serviceRefs.js";
import { getProjectForWebContents } from "../../window/webContentsRegistry.js";
import type { LinkSession } from "../link/session.js";
import { getLocalSummaryLoop } from "../metrics/localLoop.js";
import { getRemoteService, registerRemoteService } from "../runtime.js";
import {
  HostCallRuntime,
  type HostCallRuntimeDeps,
  type ObservedHost,
  type OpenRun,
} from "./HostCallRuntime.js";
import { HostControlLinkClient } from "./HostControlLinkClient.js";
import { createLocalMcpRelay, LOCAL_RELAY_SENDER_ID } from "./localMcpRelay.js";
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
      | "awaitsNotices"
      | "holdsThrowawayRuns"
      | "receiveNotices"
      | "noticeCalls"
      | "receiveNoticeStatus"
      | "receiveApproval"
    >;
    hostControlLinkClient: HostControlLinkClient;
  }
}

/**
 * The run a help session answers in, when one of this machine's own views
 * shows it, or when it is this machine's global assistant (#14161), which
 * main owns and no view holds.
 */
function localRunOf(helpSessionId: string): OpenRun | null {
  const lane = helpSessionService.getSessionLane(helpSessionId);
  if (lane === null) return null;
  const running = helpSessionService.getRunningLaneSession(lane.projectId, lane.slot);
  if (running === null || running.sessionId !== helpSessionId) return null;
  // An assistant a remote Shell's view runs here is that Shell's, never this one's.
  const handle = running.projectViewWebContentsId;
  if (
    !isGlobalAssistantId(lane.projectId) &&
    (isRemoteEndpointHandle(handle) || getProjectForWebContents(handle) !== lane.projectId)
  ) {
    return null;
  }
  const launchGeneration = getPtyClient()?.getLiveGeneration(running.terminalId) ?? null;
  if (launchGeneration === null) return null;
  return {
    projectId: lane.projectId,
    slot: lane.slot,
    sessionId: running.sessionId,
    terminalId: running.terminalId,
    launchGeneration,
  };
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
  /** The person's "assistant control" switch for a host: whether its assistant reaches it (#13493). */
  isHostControlEnabled(hostId: HostId): boolean;
  /**
   * Hears what hosts already report, for `host.watch` (#14463): links, the
   * host list and summaries. Held only while a watch is armed, or while
   * `host.list` waits for a host it dialed to send its first summary.
   */
  watchHosts?: HostCallRuntimeDeps["watchHosts"];
}

/**
 * Registers the Shell's `host.list` and `host.call` runtime, and what runbook
 * search is told of this machine's hosts; the returned teardown removes them.
 */
export function installHostControl(deps: HostControlInstallDeps): () => void {
  const machineName = (): string => (localMachineName ??= machineDisplayName());
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
      const { mcpServerService } = await import("../../services/McpServerService.js");
      await helpSessionService.ensureAssistantControl();
      return mcpServerService.openRelaySession({
        tier: spec.tier,
        workspaceId: spec.projectId,
        caller: relayCallerOf(spec),
      });
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
    retirePrincipal: (senderId, helpSessionId) => {
      void mcpServer()
        .then(({ mcpServerService }) =>
          mcpServerService.retireRelayPrincipal(senderId, helpSessionId)
        )
        .catch((error: unknown) => {
          logger.warn("Couldn't retire a local relay principal", { error });
        });
    },
    receiveNotices: (payload) => runtime.receiveNotices(LOCAL_HOST_ID, payload),
    receiveApproval: (payload) => runtime.receiveApproval(LOCAL_HOST_ID, payload),
    throwawayRuns: () => getRemoteService("hostThrowawayRuns") ?? null,
  });
  // The global assistant has no window of its own: it is asked in one that
  // shows it, never the focused one, and not at all while none does.
  const askingWindow = (helpSessionId: string): number | null => {
    const webContentsId = isGlobalAssistantId(
      helpSessionService.getSessionLane(helpSessionId)?.projectId ?? ""
    )
      ? (peekGlobalAssistantService()?.presenterWebContentsId() ?? null)
      : helpSessionService.getWebContentsIdForSessionId(helpSessionId);
    return webContentsId === null || isRemoteEndpointHandle(webContentsId) ? null : webContentsId;
  };
  const runtime = new HostCallRuntime({
    getSessionLane: (helpSessionId) => helpSessionService.getSessionLane(helpSessionId),
    callerRun: localRunOf,
    client: () => getRemoteService("hostControlLinkClient") ?? null,
    hosts: () => deps.observeHosts(),
    listHostProjects: deps.listHostProjects,
    connect: deps.connect,
    // From provisioning, before the run is confirmed: the view a session was opened in.
    // The global assistant (#14161) is this machine's own with no view at all.
    inLocalView: (helpSessionId) => {
      const lane = helpSessionService.getSessionLane(helpSessionId);
      if (lane !== null && isGlobalAssistantId(lane.projectId)) return true;
      const handle = helpSessionService.getWebContentsIdForSessionId(helpSessionId);
      return handle !== null && !isRemoteEndpointHandle(handle);
    },
    controlEnabled: (hostId) => deps.isHostControlEnabled(hostId),
    ...(deps.watchHosts ? { watchHosts: deps.watchHosts } : {}),
    // A host's question about a call it would run itself goes to the person in
    // the window of the assistant that made the call (#13501), never the
    // focused one: an assistant a remote Shell's view runs here has none.
    askApproval: async (ask) => {
      const webContentsId = askingWindow(ask.helpSessionId);
      if (webContentsId === null) return null;
      const { askHostApprovalInWindow } = await import("../client/viewRequests.js");
      return askHostApprovalInWindow(webContentsId, ask);
    },
    // This machine's own preference for the assistant that made the call, never the host's (#15698).
    confirmationsSkipped: (helpSessionId) =>
      readAssistantConfirmationsSkipped(helpSessionService.getSessionAgent(helpSessionId)),
    // A host's settings, read and changed by name with no view there (#14167).
    settingsClient: () => getRemoteService("settingsControlClient") ?? null,
    askSettingsApproval: async ({ helpSessionId, ...ask }) => {
      const webContentsId = askingWindow(helpSessionId);
      if (webContentsId === null) return null;
      const { askSettingsApprovalInWindow } = await import("../client/viewRequests.js");
      return askSettingsApprovalInWindow(webContentsId, ask);
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
      // The sampler reads macOS and treats everything else as Linux, so a
      // Windows machine has no measurement to offer rather than a borrowed one.
      latestSummary: () => (process.platform === "win32" ? null : getLocalSummaryLoop().latest()),
      summaryReceipt: (summary) => getLocalSummaryLoop().receiptOf(summary),
      relayCall: (payload) => local.relayCall(payload),
      throwawayCall: (payload) => local.throwawayCall(payload),
      agents: (options) => getLocalAgentDirectory().read(options),
    },
  });
  // A help session that won't run again holds nothing it made in another
  // project; one relaunched onto a new PTY is the same assistant and keeps it.
  const offSessionEnded = helpSessionService.addSessionEndedListener(({ sessionId, reason }) => {
    // Its watches were the earlier run's, whichever way it ended (#14463).
    runtime.retireWatches(sessionId);
    if (reason === "relaunched") return;
    local.endHelpSession(sessionId);
    runtime.endHelpSession(sessionId);
  });
  const unregisterRuntime = setHostControlRuntime(runtime);
  const unregisterCallRelay = registerRemoteService("hostCallRelayClient", runtime);
  return () => {
    offSessionEnded();
    unregisterCallRelay();
    unregisterRuntime();
    runtime.dispose();
    local.dispose();
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
    const run = helpSessionService
      .listRunningLanes()
      .filter((lane) => lane.attached !== false)
      .map((lane) => helpSessionService.getRunningLaneSession(lane.projectId, lane.slot))
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
  onSessionOpened(listener: (hostId: HostId, session: LinkSession) => void): () => void;
  /** Hosts this Shell still knows; a removed host's credential goes with it. */
  knownHosts(): HostId[];
  onHostsChanged(listener: () => void): () => void;
  /** Keeps a host's connection open while the check says so; asked on every idle sweep. */
  addUseCheck?(check: (hostId: HostId) => boolean): () => void;
  /** A host's name as this Shell shows it, for the line about retired sends. */
  hostName(hostId: HostId): string;
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
 * for them (#13500, #13930), or a throwaway run one of them launched that may
 * still be going, which the host ends with the link (#15878). Holding the
 * link never keeps the host awake.
 */
export function assistantsUseHost(hostId: HostId): boolean {
  const relay = getRemoteService("hostCallRelayClient");
  return (
    relay?.hasCallInFlight(hostId) === true ||
    relay?.awaitsNotices(hostId) === true ||
    relay?.holdsThrowawayRuns(hostId) === true
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
  const client = new HostControlLinkClient({
    credential: (hostId) => credentials.credential(hostId),
    existingCredential: (hostId) => credentials.existing(hostId),
    session: deps.session,
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
