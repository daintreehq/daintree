import type { HostId } from "../../../shared/types/remoteHosts.js";
import { CHANNELS } from "../../ipc/channels.js";
import { broadcastToRenderer } from "../../ipc/utils.js";
import { helpSessionService } from "../../services/HelpSessionService.js";
import type { PtyClient } from "../../services/PtyClient.js";
import { getPtyClient } from "../../window/serviceRefs.js";
import { getSharedSqlite } from "../../services/persistence/db.js";
import { AssistantExchangeJournal } from "../exchange/AssistantExchangeJournal.js";
import type { LinkSession } from "../link/session.js";
import { getRemoteService, registerRemoteService } from "../runtime.js";
import { AssistantExchangeClient } from "./AssistantExchangeClient.js";
import { AssistantMessagingPolicy } from "./AssistantMessagingPolicy.js";

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
  }
}

export interface AssistantMessagingPolicyInstallDeps {
  /** This Shell's per-host opt-in, read from the host list at each check. */
  isHostMessagingEnabled(hostId: HostId): boolean;
  hasHosts(): boolean;
  onHostsChanged(listener: () => void): () => void;
}

/** Registers the process's one messaging policy; the returned teardown disposes it. */
export function installAssistantMessagingPolicy(
  deps: AssistantMessagingPolicyInstallDeps
): () => void {
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
  const unregister = registerRemoteService("assistantMessagingPolicy", policy);
  const unregisterSurface = registerRemoteService("assistantMessagingSurface", {
    hasHosts: deps.hasHosts,
    revision: () => revision,
  });
  // A view that mounted before the policy existed read it as unavailable.
  push();
  return () => {
    unregisterSurface();
    unregister();
    offHosts();
    offPolicy();
    watched?.off("spawn-result", reconcile);
    watched = null;
    policy.dispose();
  };
}

declare module "../runtime.js" {
  interface RemoteServices {
    assistantExchangeClient: AssistantExchangeClient;
  }
}

export interface AssistantExchangeClientInstallDeps {
  /** The host's open session, connecting it if need be; null when it can't be reached. */
  session(hostId: HostId): Promise<LinkSession | null>;
  onSessionOpened(listener: (hostId: HostId, session: LinkSession) => void): () => void;
  /** Hosts this Shell still knows; a removed host's journal goes with it. */
  knownHosts(): HostId[];
  onHostsChanged(listener: () => void): () => void;
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
  });
  client.start();
  const unregister = registerRemoteService("assistantExchangeClient", client);
  return () => {
    unregister();
    client.dispose();
    offHosts();
  };
}
