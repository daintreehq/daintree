import type Database from "better-sqlite3";
import type { HostProjectSummary } from "../../../shared/types/ipc/remoteHosts.js";
import type { HostId } from "../../../shared/types/remoteHosts.js";
import { CHANNELS } from "../../ipc/channels.js";
import { isRemoteEndpointHandle } from "../../ipc/endpoint.js";
import { getEndpointRegistry } from "../../ipc/endpointRegistry.js";
import { broadcastToRenderer } from "../../ipc/utils.js";
import { peekDriveLeaseService } from "../../services/DriveLeaseService.js";
import { helpSessionService } from "../../services/HelpSessionService.js";
import { setAssistantMessagingRuntime } from "../../services/mcp-server/assistantMessagingTools.js";
import { setHostMessagingRuntime } from "../../services/mcp-server/hostMessagingTools.js";
import { getSharedDb, getSharedSqlite } from "../../services/persistence/db.js";
import type { PtyClient } from "../../services/PtyClient.js";
import { getPtyClient } from "../../window/serviceRefs.js";
import { getProjectForWebContents } from "../../window/webContentsRegistry.js";
import { AssistantExchangeJournal } from "../exchange/AssistantExchangeJournal.js";
import {
  AssistantExchangeStore,
  closeExchangesLeftOpen,
  EXCHANGE_RETRY_WINDOW_MS,
} from "../exchange/AssistantExchangeStore.js";
import type { LinkSession } from "../link/session.js";
import { callerDrives, type FleetCaller } from "../metrics/hostOps.js";
import { getRemoteService, registerRemoteService } from "../runtime.js";
import { exchangeWakeSink } from "../exchange/wakeSink.js";
import { AssistantExchangeClient, type MovedExchange } from "./AssistantExchangeClient.js";
import { AssistantHubReceiver } from "./AssistantHubReceiver.js";
import {
  HostAssistantStarter,
  type HostAssistantStarterDeps,
  type HostStartRefusal,
} from "./HostAssistantStarter.js";
import { AssistantInbox } from "./AssistantInbox.js";
import { AssistantLaneWaker } from "./AssistantLaneWaker.js";
import { AssistantMessagingDefaults } from "./AssistantMessagingDefaults.js";
import { AssistantMessagingPolicy, type MessagingShell } from "./AssistantMessagingPolicy.js";
import { AssistantMessagingRuntime } from "./AssistantMessagingRuntime.js";
import { HubMessagingRuntime, type ObservedHost } from "./HubMessagingRuntime.js";

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
    assistantMessagingRuntime: AssistantMessagingRuntime;
    assistantHubReceiver: AssistantHubReceiver;
  }
}

/** How long a lane that got its view back stays owed a re-announcement its Shell can't take yet. */
const REANNOUNCE_OWED_MS = 10 * 60_000;
/** When to give enrolled lanes their views back after a session opens: windows restore after the link does. */
const REATTACH_DELAYS_MS = [3_000, 10_000, 30_000, 90_000];
/** What a later pass may still fix: a window that wasn't back yet, or one busy opening the project. */
const REATTACH_RETRY: ReadonlySet<HostStartRefusal> = new Set([
  "no-window",
  "busy",
  "no-room",
  // An old session of this Shell's own, still held for resume, may hold the lease for a while.
  "driven-elsewhere",
]);

export interface AssistantMessagingPolicyInstallDeps {
  /** This Shell's per-host opt-in, read from the host list at each check. */
  isHostMessagingEnabled(hostId: HostId): boolean;
  hasHosts(): boolean;
  onHostsChanged(listener: () => void): () => void;
  /** Told whenever a lane may have gained or lost its inbox or hub tools. */
  onAvailabilityChanged?(): void;
  /** Every host this Shell knows, as last observed; what the hub's `host.list` reads. */
  observeHosts?(): ObservedHost[];
  /** A connected host's projects, for naming what its assistants work in. */
  listHostProjects?(hostId: HostId): Promise<readonly HostProjectSummary[]>;
  /** The person's consent to the hub starting assistants on a host, read at each call. */
  isHostStartEnabled?(hostId: HostId): boolean;
  /** A session to a host opened (or reopened): lanes enrolled there may need their views back. */
  onHostSessionOpened?(listener: (hostId: HostId) => void): () => void;
  /** What starting an assistant in a host's project takes from the windows here. */
  hostAssistants?: Omit<HostAssistantStarterDeps, "listLanes" | "enrollStarted" | "sleep" | "now">;
  /**
   * This machine's saved default for its assistants accepting messages from
   * other machines, read at each pass. Absent, nothing is enrolled by default.
   */
  acceptsByDefault?(): boolean;
  onDefaultChanged?(listener: () => void): () => void;
  /** Whether this Shell has messaging on for any host. */
  hasMessagingHost?(): boolean;
}

/** The Shell whose view a run is pinned to; see `AssistantMessagingDefaultsDeps.viewShell`. */
function viewShellOf(
  running: { projectViewWebContentsId: number },
  projectId: string
): MessagingShell | null {
  const handle = running.projectViewWebContentsId;
  if (isRemoteEndpointHandle(handle)) {
    const endpoint = getEndpointRegistry().getByHandle(handle);
    const linkSessionId = endpoint?.linkSessionId;
    return endpoint?.kind === "remote-view" &&
      !endpoint.isClosed() &&
      endpoint.projectId === projectId &&
      linkSessionId
      ? { kind: "remote", linkSessionId }
      : null;
  }
  // Only one of this machine's project views showing the run's own project.
  return getProjectForWebContents(handle) === projectId ? { kind: "local" } : null;
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
  closeExchangesLeftOpen(store);
  const policy = new AssistantMessagingPolicy({
    getRunningLaneSession: (projectId, slot) =>
      helpSessionService.getRunningLaneSession(projectId, slot),
    listRunningLanes: () => helpSessionService.listRunningLanes(),
    startedThrough: (running, linkSessionId) =>
      getEndpointRegistry()
        .getRemote()
        .some(
          (endpoint) =>
            endpoint.handle === running.projectViewWebContentsId &&
            endpoint.linkSessionId === linkSessionId &&
            !endpoint.isClosed()
        ),
    getLiveGeneration: (terminalId) => getPtyClient()?.getLiveGeneration(terminalId) ?? null,
    isHostMessagingEnabled: deps.isHostMessagingEnabled,
    onSessionEnded: (listener) => helpSessionService.addSessionEndedListener(listener),
  });
  const acceptsByDefault = deps.acceptsByDefault;
  const defaults = new AssistantMessagingDefaults({
    policy,
    listRunningLanes: () => helpSessionService.listRunningLanes(),
    getRunningLaneSession: (projectId, slot) =>
      helpSessionService.getRunningLaneSession(projectId, slot),
    viewShell: viewShellOf,
    acceptsByDefault: () => acceptsByDefault?.() === true,
    hasMessagingHost: () => deps.hasMessagingHost?.() === true,
  });
  let revision = 0;
  let hadHosts = deps.hasHosts();
  const push = () => {
    revision += 1;
    broadcastToRenderer(CHANNELS.ASSISTANT_MESSAGING_CHANGED, { revision });
  };
  // A spawn is when a run can be replaced in place, and when one starts. The
  // client may not exist yet, but nothing can be enrolled without a running
  // PTY, so every change tries again.
  const reconcile = () => {
    policy.reconcile();
    defaults.schedule();
  };
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
    defaults.schedule();
  });
  const offDefault = deps.onDefaultChanged?.(() => defaults.schedule()) ?? (() => {});
  // Only the first host arriving or the last one going changes what views
  // show, and whether the hub is offered its host tools.
  const offHosts = deps.onHostsChanged(() => {
    // Any host's opt-in may have turned on, which gives the hub a host to hear from.
    defaults.schedule();
    const hasHosts = deps.hasHosts();
    if (hasHosts === hadHosts) return;
    hadHosts = hasHosts;
    push();
    deps.onAvailabilityChanged?.();
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
    // The host side installs it with its server, which may come later or not at all.
    outbox: () => getRemoteService("assistantHostOutbox"),
    hasHosts: deps.hasHosts,
    // Outside the exchange's one reserved wake, so it records nothing on the exchange.
    rewake: (enrollment, record, stillOwed) =>
      getRemoteService("assistantLaneWaker")?.wake({
        lane: { projectId: enrollment.projectId, slot: enrollment.slot },
        generation: record.receiver.enrollmentGeneration,
        shell: enrollment.enrolledBy,
        exchangeId: record.taskId,
        // Asked again just before typing: the lane may have answered it meanwhile.
        sink: { beforeType: stillOwed, report: () => {} },
      }),
  });
  // A lane whose assistant got its view back may have given up on a message
  // while its tools were gone: tell it again what it still owes an answer.
  // Owed until it can be woken: a view can take a detached assistant over
  // before its Shell has proved itself on the new session, and the policy
  // changing (that rebind, an unpause) is when to try again.
  const owedReannounce = new Map<
    string,
    { lane: { projectId: string; slot: number }; at: number }
  >();
  const payReannounce = (): void => {
    const now = Date.now();
    for (const [key, owed] of owedReannounce) {
      if (now - owed.at > REANNOUNCE_OWED_MS || runtime.reannounce(owed.lane) !== null) {
        owedReannounce.delete(key);
      }
    }
  };
  const offReattached = helpSessionService.addSessionReattachedListener(({ projectId, slot }) => {
    owedReannounce.set(`${projectId}\0${slot}`, { lane: { projectId, slot }, at: Date.now() });
    payReannounce();
    // Its new view may belong to a Shell whose default now applies.
    defaults.schedule();
  });
  const offPolicyReannounce = policy.onChange(payReannounce);
  const onAvailabilityChanged = deps.onAvailabilityChanged;
  const stopListening = onAvailabilityChanged
    ? runtime.onAvailabilityChanged(onAvailabilityChanged)
    : () => {};
  const unregisterRuntime = setAssistantMessagingRuntime(runtime);
  const exchangeClient = (): AssistantExchangeClient => {
    const client = getRemoteService("assistantExchangeClient");
    if (!client) throw new Error("Assistant exchanges aren't available");
    return client;
  };
  const hostAssistants = deps.hostAssistants;
  const starter = hostAssistants
    ? new HostAssistantStarter({
        ...hostAssistants,
        listLanes: (hostId) => exchangeClient().listLanes(hostId),
        listOwnLanes: (hostId) => exchangeClient().listOwnLanes(hostId),
        enrollStarted: (hostId, payload) => exchangeClient().enrollStarted(hostId, payload),
      })
    : null;
  const hub = new HubMessagingRuntime({
    policy,
    getSessionLane: (helpSessionId) => helpSessionService.getSessionLane(helpSessionId),
    client: () => getRemoteService("assistantExchangeClient") ?? null,
    hosts: () => deps.observeHosts?.() ?? [],
    listHostProjects: deps.listHostProjects,
    startEnabled: (hostId) => deps.isHostStartEnabled?.(hostId) === true,
    starter: () => starter,
  });
  const unregisterHub = setHostMessagingRuntime(hub);
  // An assistant the hub started works through a hidden view of its project,
  // which no window restores after a restart: give each enrolled lane's project
  // a view again once the link is back, retrying while windows come back too.
  // Each session opening starts a new round for its host; a pass from an
  // older round stops at its next step and never reschedules.
  let reattachDisposed = false;
  const reattachTimers = new Map<HostId, ReturnType<typeof setTimeout>>();
  const reattachRounds = new Map<HostId, number>();
  const attemptReattach = (hostId: HostId, round: number, attempt: number): void => {
    const delay = REATTACH_DELAYS_MS[attempt];
    if (reattachDisposed || !starter || delay === undefined) return;
    if (reattachRounds.get(hostId) !== round) return;
    clearTimeout(reattachTimers.get(hostId));
    const timer = setTimeout(() => {
      reattachTimers.delete(hostId);
      const authorized = () =>
        !reattachDisposed &&
        reattachRounds.get(hostId) === round &&
        deps.isHostStartEnabled?.(hostId) === true;
      if (!authorized()) return;
      const again = () => attemptReattach(hostId, round, attempt + 1);
      starter.reattach(hostId, authorized).then((left) => {
        if (left.some((project) => REATTACH_RETRY.has(project.reason))) again();
      }, again);
    }, delay);
    timer.unref?.();
    reattachTimers.set(hostId, timer);
  };
  const reattach = (hostId: HostId): void => {
    const round = (reattachRounds.get(hostId) ?? 0) + 1;
    reattachRounds.set(hostId, round);
    attemptReattach(hostId, round, 0);
  };
  const offSessionOpened = deps.onHostSessionOpened?.((hostId) => reattach(hostId)) ?? (() => {});
  // What a host's assistants send this hub (#13338), admitted through the same policy.
  const receiver = new AssistantHubReceiver({
    policy,
    store,
    runtime,
    hostName: (hostId) =>
      deps.observeHosts?.().find((host) => host.hostId === hostId)?.name ?? "Remote host",
    wake: (record, enrolled) =>
      waker.wake({
        lane: { projectId: enrolled.projectId, slot: enrolled.slot },
        generation: enrolled.generation,
        shell: { kind: "local" },
        exchangeId: record.taskId,
        sink: exchangeWakeSink(
          store,
          { kind: "receiver", ...record.receiver },
          { senderId: record.senderId, messageId: record.messageId }
        ),
      }),
    tellHost: (hostId, messageId) =>
      getRemoteService("assistantExchangeClient")?.tellHost(hostId, messageId),
  });
  const unregisterReceiver = registerRemoteService("assistantHubReceiver", receiver);
  // The host's link calls hand accepted exchanges to the inbox through it.
  const unregisterRuntimeService = registerRemoteService("assistantMessagingRuntime", runtime);
  // A view that mounted before the policy existed read it as unavailable.
  push();
  // Runs that started before the policy existed.
  defaults.schedule();
  return () => {
    defaults.dispose();
    offDefault();
    offReattached();
    offPolicyReannounce();
    owedReannounce.clear();
    offSessionOpened();
    reattachDisposed = true;
    for (const timer of reattachTimers.values()) clearTimeout(timer);
    reattachTimers.clear();
    stopListening();
    unregisterReceiver();
    receiver.dispose();
    unregisterHub();
    hub.dispose();
    unregisterRuntimeService();
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
  /** Told, at most once a tick per host, that the journal's exchanges for it changed. */
  onExchangesChanged?(hostId: HostId): void;
  /** This Shell's per-host opt-in for assistant messaging. */
  messagingEnabled?(hostId: HostId): boolean;
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
  // Turning messaging on for a connected host proves this Shell's sender there now.
  let client: AssistantExchangeClient | null = null;
  const offHosts = deps.onHostsChanged(() => {
    forgetRemovedHosts();
    for (const hostId of deps.knownHosts()) {
      if (deps.messagingEnabled?.(hostId) === true) client?.authenticateOpen(hostId);
    }
  });
  client = new AssistantExchangeClient({
    journal,
    session: deps.session,
    onSessionOpened: deps.onSessionOpened,
    policy: () => getRemoteService("assistantMessagingPolicy"),
    hubReceiver: () => getRemoteService("assistantHubReceiver"),
    messagingEnabled: deps.messagingEnabled,
    onExchangesMoved: (_hostId, moved) =>
      wakeHubForMoved(
        moved,
        getRemoteService("assistantMessagingPolicy"),
        getRemoteService("assistantLaneWaker")
      ),
  });
  // Subscribed before the first reconcile, so nothing it records goes unannounced.
  const pending = new Set<HostId>();
  let flushQueued = false;
  let disposed = false;
  const offJournal = deps.onExchangesChanged
    ? client.onJournalChanged((hostId) => {
        pending.add(hostId);
        if (flushQueued) return;
        flushQueued = true;
        queueMicrotask(() => {
          flushQueued = false;
          const hosts = [...pending];
          pending.clear();
          if (disposed) return;
          for (const hostId of hosts) {
            try {
              deps.onExchangesChanged?.(hostId);
            } catch (error) {
              console.error("[AssistantExchanges] Announcing a journal change failed:", error);
            }
          }
        });
      })
    : () => {};
  client.start();
  // Bounded by each exchange's expiry. Holding the link never keeps the host awake.
  const offUseCheck =
    deps.addUseCheck?.((hostId) => journal.hasOpen(hostId, EXCHANGE_RETRY_WINDOW_MS)) ?? (() => {});
  const unregister = registerRemoteService("assistantExchangeClient", client);
  return () => {
    disposed = true;
    pending.clear();
    offJournal();
    offUseCheck();
    unregister();
    client.dispose();
    offHosts();
  };
}
