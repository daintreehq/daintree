import { isRemoteWindow } from "@/hooks/useHostPlatform";
import type { SettingsTab } from "./settingsTabIds";

// Pages about work that runs on this machine: a window driving a Remote Host's
// project has none of it to show (#15973), so it never lists or opens them.
const LOCAL_ONLY_SETTINGS_TABS: ReadonlySet<SettingsTab> = new Set<SettingsTab>([
  "project:schedules",
]);

/** Whether this window shows `tab` at all: in its nav, its search, or a targeted open. */
export function isSettingsTabAvailable(tab: SettingsTab): boolean {
  return !LOCAL_ONLY_SETTINGS_TABS.has(tab) || !isRemoteWindow();
}

// Sections of a page both windows show, about agents launched on this machine:
// a remote window's agents are the Host's, so Decisions' Agents isn't drawn there.
const LOCAL_ONLY_SETTINGS_SECTIONS: ReadonlySet<string> = new Set(["decisions-agents"]);

/**
 * The search entries this window can open. Filtered before ranking, so a page
 * or section it never shows can't push the fuzzy rows that can be opened out
 * of the results.
 */
export function availableSearchEntries<T extends { tab: SettingsTab; id: string }>(
  index: readonly T[]
): T[] {
  const remote = isRemoteWindow();
  return index.filter(
    (entry) =>
      isSettingsTabAvailable(entry.tab) && !(remote && LOCAL_ONLY_SETTINGS_SECTIONS.has(entry.id))
  );
}
