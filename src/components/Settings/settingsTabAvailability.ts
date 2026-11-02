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
