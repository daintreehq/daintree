// eager-import-allow: reads this machine's switch via store.get synchronously, so a follow and the check that admits it share one turn
import { store } from "../../store.js";
import { CHANNELS } from "../../ipc/channels.js";
import { broadcastToRenderer } from "../../ipc/utils.js";
import { peekAgentUsageWatch } from "./AgentUsageWatch.js";
import type { AgentUsageTrackingSnapshot } from "../../../shared/types/ipc/agentUsage.js";
import { createLogger } from "../../utils/logger.js";

const logger = createLogger("main:agentUsage");

type Listener = (enabled: boolean) => void;

let revision = 0;
const listeners = new Set<Listener>();

/**
 * Whether this machine tracks its agents' usage (#17981). Off, no window drawn
 * here shows Usage, nothing here watches usage, and no host is asked to; a
 * host's own switch off keeps it from reading usage for any Shell.
 */
export function isAgentUsageTrackingEnabled(): boolean {
  return store.get("agentUsageTrackingEnabled") !== false;
}

export function readAgentUsageTracking(): AgentUsageTrackingSnapshot {
  return { enabled: isAgentUsageTrackingEnabled(), revision };
}

/** Told after the switch changed, before any view hears of it. */
export function onAgentUsageTrackingChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setAgentUsageTracking(enabled: boolean): AgentUsageTrackingSnapshot {
  if (typeof enabled !== "boolean") throw new Error("Invalid enabled value");
  if (isAgentUsageTrackingEnabled() === enabled) return readAgentUsageTracking();
  store.set("agentUsageTrackingEnabled", enabled);
  revision += 1;
  const snapshot = { enabled, revision };
  if (!enabled) peekAgentUsageWatch()?.trackingTurnedOff();
  for (const listener of [...listeners]) {
    try {
      listener(enabled);
    } catch (error) {
      logger.warn("An agent usage tracking listener threw", { error });
    }
  }
  broadcastToRenderer(CHANNELS.AGENT_USAGE_TRACKING_CHANGED, snapshot);
  return snapshot;
}

export function _resetAgentUsageTrackingForTests(): void {
  revision = 0;
  listeners.clear();
}
