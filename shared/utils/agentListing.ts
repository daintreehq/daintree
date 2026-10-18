import {
  isAssistantOnlyAgentId,
  isBuiltInAgentId,
  LAUNCHABLE_AGENT_IDS,
} from "../config/agentIds.js";
import type { AgentSettings } from "../types/agentSettings.js";
import type { AgentAvailabilityState } from "../types/ipc/system.js";
import { isAgentInstalled, isAgentLaunchable } from "./agentAvailability.js";
import { isAgentToolbarVisible } from "./agentPinned.js";

/** The agents a listing reports, in the launcher's order. */
export function listedAgentIds(registry: Readonly<Record<string, unknown>>): string[] {
  return [
    ...LAUNCHABLE_AGENT_IDS.filter((id) => Object.hasOwn(registry, id)),
    ...Object.keys(registry)
      .filter((id) => !isBuiltInAgentId(id) && !isAssistantOnlyAgentId(id))
      .sort(),
  ];
}

export interface AvailableAgentListingSources {
  registry: Readonly<Record<string, { name?: string } | undefined>>;
  userRegistry: Readonly<Record<string, unknown>>;
  settings: AgentSettings | null | undefined;
  availability: Readonly<Record<string, AgentAvailabilityState | undefined>>;
  /** Whether a live CLI probe has completed, rather than a cache hydrating. */
  availabilityLive: boolean;
}

export interface AvailableAgentListing {
  complete: true;
  availabilityComplete: boolean;
  agents: Array<{
    id: string;
    displayName: string;
    source: "built-in" | "user" | "plugin";
    launchable?: boolean;
    availability?: AgentAvailabilityState;
    installed?: boolean;
    pinned?: boolean;
    toolbarVisible?: boolean;
  }>;
}

/**
 * The `agent.listAvailable` answer, from whichever side holds the sources: a
 * view's stores, or the host's own services when no view is open (#13495).
 */
export function buildAvailableAgentListing({
  registry,
  userRegistry,
  settings,
  availability,
  availabilityLive,
}: AvailableAgentListingSources): AvailableAgentListing {
  const registryIds = listedAgentIds(registry);
  return {
    complete: true,
    // Only certify completeness once a live probe has run: a hydrating cache
    // synthesizes "missing" for unprobed agents, which would otherwise pass
    // the own-key check and mislabel a never-checked agent as uninstalled.
    availabilityComplete:
      availabilityLive && registryIds.every((id) => Object.hasOwn(availability, id)),
    agents: registryIds.map((id) => {
      // `rawState` mirrors what the toolbar renders (used for toolbarVisible);
      // `probedState` is the authoritative probe result we're willing to
      // report as availability/installed/launchable — undefined until live.
      const rawState = availability[id];
      const probedState = availabilityLive ? rawState : undefined;
      const builtIn = isBuiltInAgentId(id);
      const entry = builtIn ? settings?.agents?.[id] : undefined;
      return {
        id,
        displayName: registry[id]?.name ?? id,
        source: builtIn
          ? ("built-in" as const)
          : Object.prototype.hasOwnProperty.call(userRegistry, id)
            ? ("user" as const)
            : ("plugin" as const),
        ...(probedState
          ? {
              availability: probedState,
              installed: isAgentInstalled(probedState),
              launchable: isAgentLaunchable(probedState),
            }
          : {}),
        ...(builtIn && typeof entry?.pinned === "boolean" ? { pinned: entry.pinned } : {}),
        ...(builtIn ? { toolbarVisible: isAgentToolbarVisible(entry, rawState) } : {}),
      };
    }),
  };
}
