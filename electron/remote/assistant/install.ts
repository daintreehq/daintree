import type Database from "better-sqlite3";
import type { HostProjectSummary } from "../../../shared/types/ipc/remoteHosts.js";
import type { HostId } from "../../../shared/types/remoteHosts.js";
import { isRemoteEndpointHandle } from "../../ipc/endpoint.js";
import { helpSessionService } from "../../services/HelpSessionService.js";
import type { RunbooksHostsState } from "../../services/helpSessionRunbooks.js";
import { setHostControlRuntime } from "../../services/mcp-server/hostControlTools.js";
import type { LaneWake } from "../../services/mcp-server/terminalNotify.js";
import { getSharedDb, getSharedSqlite } from "../../services/persistence/db.js";
import { getPtyClient } from "../../window/serviceRefs.js";
import { getProjectForWebContents } from "../../window/webContentsRegistry.js";
import type { LinkSession } from "../link/session.js";
import { getRemoteService, registerRemoteService } from "../runtime.js";
import { HostCallRuntime, type ObservedHost, type OpenRun } from "./HostCallRuntime.js";
import { HostControlLinkClient } from "./HostControlLinkClient.js";
import { forgetRetiredSends, readRetiredSends } from "./retiredSends.js";
import { AssistantSenderCredentials } from "./senderCredentials.js";

declare module "../runtime.js" {
  interface RemoteServices {
    /** What a host's dialogs are checked against: whether this Shell has a call out to it. */
    hostCallRelayClient: Pick<
      HostCallRuntime,
      "hasCallInFlight" | "awaitsNotices" | "receiveNotices" | "receiveApproval"
    >;
    hostControlLinkClient: HostControlLinkClient;
  }
}

/**
 * This machine's hosts as runbook search is told them (#13411), from what
 * `host.list` reads: connected means a host this Shell's assistant controls
 * is connected right now. Hosts this Shell can't observe are unreported
 * rather than guessed down to "none connected".
 */
export function observedRunbooksHostsState(
  hasHosts: boolean,
  observed: readonly ObservedHost[] | null,
  controlEnabled: (hostId: HostId) => boolean
): RunbooksHostsState | null {
  if (!hasHosts) return "none";
  if (observed === null) return null;
  return observed.some(
    (host) => controlEnabled(host.hostId) && host.connection.status === "connected"
  )
    ? "connected"
    : "configured";
}

/** The run a help session answers in, when one of this machine's own views shows it. */
function localRunOf(helpSessionId: string): OpenRun | null {
  const lane = helpSessionService.getSessionLane(helpSessionId);
  if (lane === null) return null;
  const running = helpSessionService.getRunningLaneSession(lane.projectId, lane.slot);
  if (running === null || running.sessionId !== helpSessionId) return null;
  // An assistant a remote Shell's view runs here is that Shell's, never this one's.
  const handle = running.projectViewWebContentsId;
  if (isRemoteEndpointHandle(handle) || getProjectForWebContents(handle) !== lane.projectId) {
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
  hasHosts(): boolean;
  /** A connected host's projects, for `host.list` to name. */
  listHostProjects?(hostId: HostId): Promise<readonly HostProjectSummary[]>;
  /** The person's "assistant control" switch for a host: whether its assistant reaches it (#13493). */
  isHostControlEnabled(hostId: HostId): boolean;
}

/**
 * Registers the Shell's `host.list` and `host.call` runtime, and what runbook
 * search is told of this machine's hosts; the returned teardown removes them.
 */
export function installHostControl(deps: HostControlInstallDeps): () => void {
  const runtime = new HostCallRuntime({
    getSessionLane: (helpSessionId) => helpSessionService.getSessionLane(helpSessionId),
    callerRun: localRunOf,
    client: () => getRemoteService("hostControlLinkClient") ?? null,
    hosts: () => deps.observeHosts(),
    listHostProjects: deps.listHostProjects,
    // From provisioning, before the run is confirmed: the view a session was opened in.
    inLocalView: (helpSessionId) => {
      const handle = helpSessionService.getWebContentsIdForSessionId(helpSessionId);
      return handle !== null && !isRemoteEndpointHandle(handle);
    },
    controlEnabled: (hostId) => deps.isHostControlEnabled(hostId),
    // A host's question about a call it would run itself goes to the person in
    // the window of the assistant that made the call (#13501), never the
    // focused one: an assistant a remote Shell's view runs here has none.
    askApproval: async (ask) => {
      const webContentsId = helpSessionService.getWebContentsIdForSessionId(ask.helpSessionId);
      if (webContentsId === null || isRemoteEndpointHandle(webContentsId)) return null;
      const { askHostApprovalInWindow } = await import("../client/viewRequests.js");
      return askHostApprovalInWindow(webContentsId, ask);
    },
    // A host's notice rides its run's own notice line (#13500).
    queueNotice: queueOnNoticeLine,
  });
  const unregisterRuntime = setHostControlRuntime(runtime);
  const unregisterCallRelay = registerRemoteService("hostCallRelayClient", runtime);
  // Read at each provision and held for that session; a host that connects later counts from the next.
  helpSessionService.setRunbooksHostState(() =>
    observedRunbooksHostsState(deps.hasHosts(), deps.observeHosts(), deps.isHostControlEnabled)
  );
  return () => {
    helpSessionService.setRunbooksHostState(null);
    unregisterCallRelay();
    unregisterRuntime();
    runtime.dispose();
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
    console.warn("[HostControl] Couldn't read the retired inbox's sends:", error);
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
              console.warn("[HostControl] Couldn't forget the retired inbox's sends:", error);
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
 * Registers the Shell's link client for `host.call` over the app's database,
 * which keeps the sender credential it proves to each host. Without a
 * database nothing is registered: a sender this Shell can't keep would be a
 * stranger to its hosts on every start.
 */
export function installHostControlLinkClient(deps: HostControlLinkClientInstallDeps): () => void {
  const sqlite = openDatabase();
  if (!sqlite) {
    console.warn("[HostControl] No database; this Shell's assistants can't reach its hosts");
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
    session: deps.session,
    onSessionOpened: deps.onSessionOpened,
    noticeReceiver: () => getRemoteService("hostCallRelayClient"),
    approvalReceiver: () => getRemoteService("hostCallRelayClient"),
  });
  client.start();
  // Bounded by each relayed call while it runs, and by the notices those
  // calls armed (#13500). Holding the link never keeps the host awake.
  const offUseCheck =
    deps.addUseCheck?.((hostId) => {
      const relay = getRemoteService("hostCallRelayClient");
      return relay?.hasCallInFlight(hostId) === true || relay?.awaitsNotices(hostId) === true;
    }) ?? (() => {});
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
