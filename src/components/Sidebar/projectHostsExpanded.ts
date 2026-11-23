import { useSyncExternalStore } from "react";
import { devicePreference } from "@/lib/devicePreference";

/**
 * The section's disclosures: one preference each for the whole machine,
 * deliberately not host-scoped or per-project, so the section reads the same
 * from every window on every host. Every project view shares one storage
 * partition, so the key alone is enough.
 */
export const PROJECT_HOSTS_EXPANDED_KEY = "daintree_project_hosts_expanded";
/** Whether the hosts past the first few are shown. */
export const PROJECT_HOSTS_ALL_SHOWN_KEY = "daintree_project_hosts_all_shown";

const expanded = devicePreference(PROJECT_HOSTS_EXPANDED_KEY, true);
const allShown = devicePreference(PROJECT_HOSTS_ALL_SHOWN_KEY, false);

/** Open by default; a view that can't read storage stays open. */
export function useProjectHostsExpanded(): boolean {
  return useSyncExternalStore(expanded.subscribe, expanded.read, () => true);
}

export function setProjectHostsExpanded(value: boolean): void {
  expanded.set(value);
}

/** Folded by default: the first few hosts, then one row for the rest. */
export function useProjectHostsAllShown(): boolean {
  return useSyncExternalStore(allShown.subscribe, allShown.read, () => false);
}

export function setProjectHostsAllShown(value: boolean): void {
  allShown.set(value);
}
