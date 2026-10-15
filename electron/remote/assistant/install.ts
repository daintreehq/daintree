import type Database from "better-sqlite3";
import type { HostId } from "../../../shared/types/remoteHosts.js";
import { CHANNELS } from "../../ipc/channels.js";
import { broadcastToRenderer } from "../../ipc/utils.js";
import { peekDriveLeaseService } from "../../services/DriveLeaseService.js";
import { helpSessionService } from "../../services/HelpSessionService.js";
import { setAssistantMessagingRuntime } from "../../services/mcp-server/assistantMessagingTools.js";
import { getSharedDb, getSharedSqlite } from "../../services/persistence/db.js";
import type { PtyClient } from "../../services/PtyClient.js";
import { getPtyClient } from "../../window/serviceRefs.js";
import { AssistantExchangeJournal } from "../exchange/AssistantExchangeJournal.js";
import {
  AssistantExchangeStore,
  EXCHANGE_RETRY_WINDOW_MS,
} from "../exchange/AssistantExchangeStore.js";
import type { LinkSession } from "../link/session.js";
import { callerDrives, type FleetCaller } from "../metrics/hostOps.js";
import { getRemoteService, registerRemoteService } from "../runtime.js";
import { AssistantExchangeClient, type MovedExchange } from "./AssistantExchangeClient.js";
import { AssistantInbox } from "./AssistantInbox.js";
import { AssistantLaneWaker } from "./AssistantLaneWaker.js";
import { AssistantMessagingPolicy, type MessagingShell } from "./AssistantMessagingPolicy.js";
import { AssistantMessagingRuntime } from "./AssistantMessagingRuntime.js";

/** What the messaging controls need beyond the policy itself. */
export interface AssistantMessagingSurface {
  /** Whether this Shell has any host: the controls stay hidden until it does. */
  hasHosts(): boolean;
  /** Increases on every change pushed to views. */
  revision(): number;
}

declare module "../runtime.js" {
  interface RemoteServices {
    assistantMessagingPolicy: AssistantMessagingPolicy;
    assistantMessagingSurface: AssistantMessagingSurface;
    assistantLaneWaker: AssistantLaneWaker;
  }
}

export interface AssistantMessagingPolicyInstallDeps {
  /** This Shell's per-host opt-in, read from the host list at each check. */
  isHostMessagingEnabled(hostId: HostId): boolean;
  hasHosts(): boolean;
  onHostsChanged(listener: () => void): () => void;
  /** Told whenever a lane may have gained or lost its inbox tools. */
  onAvailabilityChanged?(): void;
}

function openExchangeDatabase(): Database.Database | null {
  try {
    if (getSharedSqlite() === null) getSharedDb();
    return getSharedSqlite();
  } catch (err) {
    console.error("[AssistantMessaging] Exchange records are unavailable:", err);
    return null;
  }
}

function fleetCallerFor(shell: MessagingShell): FleetCaller {
  return shell.kind === "local"
    ? { kind: "local" }
    : { kind: "remote", sessionId: shell.linkSessionId };
}

/**
 * Registers the process's one messaging policy, its lane waker, and the
 * runtime an enrolled lane's own tools run against; the returned teardown
 * disposes them all.
 */
export function installAssistantMessagingPolicy(
  deps: AssistantMessagingPolicyInstallDeps
): () => void {
  const store = new AssistantExchangeStore(openExchangeDatabase());
  const policy = new AssistantMessagingPolicy({
    getRunningLaneSession: (projectId, slot) =>
      helpSessionService.getRunningLaneSession(projectId, slot),
    getLiveGeneration: (terminalId) => getPtyClient()?.getLiveGeneration(terminalId) ?? null,
    isHostMessagingEnabled: deps.isHostMessagingEnabled,
    onSessionEnded: (listener) => helpSessionService.addSessionEndedListener(listener),
  });
  let revision = 0;
  let hadHosts = deps.hasHosts();
  const push = () => {
    revision += 1;
    broadcastToRenderer(CHANNELS.ASSISTANT_MESSAGING_CHANGED, { revision });
  };
  // A spawn is when a run can be replaced in place. The client may not exist
  // yet, but nothing can be enrolled without a running PTY, so every change
  // tries again.
  const reconcile = () => policy.reconcile();
  let watched: PtyClient | null = null;
  const watchPty = () => {
    if (watched) return;
    watched = getPtyClient();
    watched?.on("spawn-result", reconcile);
  };
  watchPty();
  const offPolicy = policy.onChange(() => {
    watchPty();
    push();
  });
  // Only the first host arriving or the last one going changes what views show.
  const offHosts = deps.onHostsChanged(() => {
    const hasHosts = deps.hasHosts();
    if (hasHosts === hadHosts) return;
    hadHosts = hasHosts;
    push();
  });
  const waker = new AssistantLaneWaker({
    policy,
    shellDrives: (projectId, shell) =>
      callerDrives(peekDriveLeaseService()?.getHolder(projectId) ?? null, fleetCallerFor(shell)),
    // Loaded on use, as elsewhere in remote code; enqueueing rechecks the lane itself.
    queue: (lane, wake) => {
      void import("../../services/McpServerService.js")
        .then(({ mcpServerService }) => mcpServerService.queueLaneWake(lane, wake))
        .catch((err: unknown) => {
          console.error("[AssistantLaneWaker] queueing a wake failed:", err);
          try {
            wake.report({ kind: "unavailable", reason: "notices-off" });
          } catch (reportErr) {
            console.error("[AssistantLaneWaker] recording a wake outcome failed:", reportErr);
          }
        });
    },
  });
  const unregisterPolicy = registerRemoteService("assistantMessagingPolicy", policy);
  const unregisterWaker = registerRemoteService("assistantLaneWaker", waker);
  helpSessionService.setMessagingReach(() => policy.isSupported());
  const unregisterSurface = registerRemoteService("assistantMessagingSurface", {
    hasHosts: deps.hasHosts,
    revision: () => revision,
  });
  const runtime = new AssistantMessagingRuntime({
    policy,
    store,
    inbox: new AssistantInbox(),
    getSessionLane: (helpSessionId) => helpSessionService.getSessionLane(helpSessionId),
  });
  const onAvailabilityChanged = deps.onAvailabilityChanged;
  const stopListening = onAvailabilityChanged
    ? runtime.onAvailabilityChanged(onAvailabilityChanged)
    : () => {};
  const unregisterRuntime = setAssistantMessagingRuntime(runtime);
  // A view that mounted before the policy existed read it as unavailable.
  push();
  return () => {
    stopListening();
    unregisterRuntime();
    unregisterSurface();
    helpSessionService.setMessagingReach(null);
    unregisterWaker();
    unregisterPolicy();
    offHosts();
    offPolicy();
    watched?.off("spawn-result", reconcile);
    watched = null;
    runtime.dispose();
    policy.dispose();
    onAvailabilityChanged?.();
  };
}

declare module "../runtime.js" {
  interface RemoteServices {
    assistantExchangeClient: AssistantExchangeClient;
  }
}

/**
 * Tells this Shell's hub that exchanges it sent moved on their host (#13337),
 * through the same guarded wake a receiving lane gets. Only the hub that sent
 * them: a lane enrolled since is a different participant and hears nothing.
 */
export function wakeHubForMoved(
  moved: readonly MovedExchange[],
  policy: Pick<AssistantMessagingPolicy, "getHub"> | undefined,
  waker: Pick<AssistantLaneWaker, "wake"> | undefined
): void {
  const hub = policy?.getHub();
  if (!hub || !waker) return;
  for (const { record, hubGeneration } of moved) {
    if (hubGeneration !== hub.generation) continue;
    waker.wake({
      lane: { projectId: hub.projectId, slot: hub.slot },
      generation: hub.generation,
      shell: { kind: "local" },
      exchangeId: record.taskId,
      kind: "update",
      // The host's record holds what happened; telling the hub twice costs nothing.
      sink: { beforeType: () => true, report: () => {} },
    });
  }
}

export interface AssistantExchangeClientInstallDeps {
  /** The host's open session, connecting it if need be; null when it can't be reached. */
  session(hostId: HostId): Promise<LinkSession | null>;
  onSessionOpened(listener: (hostId: HostId, session: LinkSession) => void): () => void;
  /** Hosts this Shell still knows; a removed host's journal goes with it. */
  knownHosts(): HostId[];
  onHostsChanged(listener: () => void): () => void;
  /** Keeps a host's connection open while the check says so; asked on every idle sweep. */
  addUseCheck?(check: (hostId: HostId) => boolean): () => void;
}

/**
 * Registers the Shell's assistant exchange client over the app's database.
 * Without a database nothing is registered: a send that couldn't be
 * journalled could never be reconciled.
 */
export function installAssistantExchangeClient(
  deps: AssistantExchangeClientInstallDeps
): () => void {
  const sqlite = getSharedSqlite();
  if (!sqlite) {
    console.warn("[AssistantExchanges] No database; this Shell can't send assistant exchanges");
    return () => {};
  }
  const journal = new AssistantExchangeJournal(sqlite);
  const forgetRemovedHosts = (): void => {
    const known = new Set(deps.knownHosts());
    for (const hostId of journal.hosts()) {
      if (!known.has(hostId)) journal.forgetHost(hostId);
    }
  };
  // On change only: a host leaves the list through a removal this process sees.
  const offHosts = deps.onHostsChanged(forgetRemovedHosts);
  const client = new AssistantExchangeClient({
    journal,
    session: deps.session,
    onSessionOpened: deps.onSessionOpened,
    policy: () => getRemoteService("assistantMessagingPolicy"),
    onExchangesMoved: (_hostId, moved) =>
      wakeHubForMoved(
        moved,
        getRemoteService("assistantMessagingPolicy"),
        getRemoteService("assistantLaneWaker")
      ),
  });
  client.start();
  // Bounded by each exchange's expiry. Holding the link never keeps the host awake.
  const offUseCheck =
    deps.addUseCheck?.((hostId) => journal.hasOpen(hostId, EXCHANGE_RETRY_WINDOW_MS)) ??
    (() => {});
  const unregister = registerRemoteService("assistantExchangeClient", client);
  return () => {
    offUseCheck();
    unregister();
    client.dispose();
    offHosts();
  };
}
