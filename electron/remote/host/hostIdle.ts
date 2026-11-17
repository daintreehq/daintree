import { ACTIVE_AGENT_STATES } from "../../../shared/types/agent.js";
import { hostIdleMinutesOf } from "../../../shared/types/hostIdle.js";
import { events } from "../../services/events.js";
import { getSharedTerminalSnapshot } from "../../services/sharedTerminalSnapshot.js";
import { store } from "../../store.js";
import { getPtyClient } from "../../window/serviceRefs.js";
import { registerRemoteService } from "../runtime.js";
import { HostIdleTracker, agentWorkOf, type HostWorkReading } from "./HostIdleTracker.js";

declare module "../runtime.js" {
  interface RemoteServices {
    hostIdle: HostIdleTracker;
  }
}

async function readAgentWork(): Promise<HostWorkReading["agents"]> {
  const pty = getPtyClient();
  if (!pty) return null;
  const { terminals, degraded } = await getSharedTerminalSnapshot(pty);
  return degraded ? null : agentWorkOf(terminals);
}

/**
 * Start this host's idle clock for as long as it listens, and register it
 * for whatever acts on idleness here. The disposer stops it.
 */
export function installHostIdle(sessionHost: { readonly servesViews: boolean }): () => void {
  const tracker = new HostIdleTracker({
    read: async () => {
      const agents = await readAgentWork();
      return { agents, shellViews: sessionHost.servesViews };
    },
    idleAfterMinutes: () => hostIdleMinutesOf(store.get("hostIdle")?.idleAfterMinutes),
  });
  const offAgents = events.on("agent:state-changed", (payload) => {
    if (ACTIVE_AGENT_STATES.has(payload.state)) tracker.noteWork();
  });
  const unregister = registerRemoteService("hostIdle", tracker);
  tracker.start();
  return () => {
    offAgents();
    unregister();
    tracker.dispose();
  };
}
