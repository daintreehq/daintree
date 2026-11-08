import { usePluginUnsavedPanelsReporter } from "@/hooks/app/usePluginUnsavedPanelsReporter";
import { usePluginIcons } from "@/hooks/usePluginIcons";

/**
 * What a plugin's view in this window leans on beyond its own loader, mounted
 * only while some plugin offers one: its rows' custom icons, and its unsaved
 * work told to main, so the plugin manager in any window asks before
 * disabling, updating or removing the plugin under it.
 */
export function CanopyPluginSupport() {
  usePluginIcons();
  usePluginUnsavedPanelsReporter();
  return null;
}
