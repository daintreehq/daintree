import { AlertCircle, ArrowUpCircle, RotateCw } from "lucide-react";
import type { LoadedPluginInfo } from "@shared/types/plugin";

/**
 * The one operational signal a plugin's row or card shows, in precedence
 * order — only the worst one renders.
 *
 * Status and provenance answer different questions and only one of them is ever
 * urgent, so status takes the line a healthy plugin spends on its blurb, and
 * provenance stays a quiet trailing pill. Shared by the master list and the
 * catalog so the two presentations of one inventory can't disagree about which
 * plugins are in trouble.
 */
export type PluginSignal = {
  label: string;
  icon: typeof AlertCircle;
  /** Tailwind text colour for the whole signal. */
  tone: string;
};

export function pluginSignalFor(plugin: LoadedPluginInfo): PluginSignal | null {
  if (plugin.blocklisted === true) {
    return { label: "Blocked", icon: AlertCircle, tone: "text-status-danger" };
  }
  // A load failure outranks the user's own off switch: "I turned this off" and
  // "this could not start" have completely different recoveries, and only the
  // second one is a surprise.
  if (plugin.loadError) {
    return { label: "Failed to load", icon: AlertCircle, tone: "text-status-danger" };
  }
  // Ahead of `disabled` deliberately: a pending restart means the switch the
  // user just flipped has NOT taken effect yet. Reporting a plain "Off" for a
  // plugin that is still loaded is precisely the toggle-that-lies failure.
  if (plugin.pendingRestart === true) {
    return { label: "Restart required", icon: RotateCw, tone: "text-status-warning" };
  }
  if (plugin.updateAvailable) {
    return {
      label: `Update available · ${plugin.updateAvailable.version}`,
      icon: ArrowUpCircle,
      tone: "text-status-warning",
    };
  }
  // No signal for a plain "disabled". The switch beside the row already states
  // it, textually and through `aria-checked`. Status here is reserved for states
  // the switch CANNOT express.
  return null;
}
