import { useSyncExternalStore } from "react";
import { devicePreference } from "@/lib/devicePreference";

/**
 * Whether the sidebar's Usage section is open: one preference for the whole
 * machine, deliberately not host-scoped or per-project, so the section reads
 * the same from every window and survives a restart.
 */
export const AGENT_USAGE_EXPANDED_KEY = "daintree_agent_usage_expanded";

const expanded = devicePreference(AGENT_USAGE_EXPANDED_KEY, true);

/** Open by default; a view that can't read storage stays open. */
export function useAgentUsageExpanded(): boolean {
  return useSyncExternalStore(expanded.subscribe, expanded.read, () => true);
}

export function setAgentUsageExpanded(value: boolean): void {
  expanded.set(value);
}
