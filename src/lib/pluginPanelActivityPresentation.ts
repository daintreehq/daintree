import { getPanelKindConfig, type PanelKindConfig } from "@shared/config/panelKindRegistry";
import type { PluginPanelActivityReport } from "@shared/types/plugin";

/** What a plugin's report draws as: a finished report reads unread until seen. */
export type PluginPanelActivityShown = "working" | "waiting" | "unread" | "finished" | "failed";

export interface PluginPanelActivityPresentation {
  pluginId: string;
  shown: PluginPanelActivityShown;
  /** "Reported by <Plugin>: <state>", plus the plugin's reason when it gave one. */
  description: string;
}

const LABELS: Record<PluginPanelActivityShown, string> = {
  working: "Working",
  waiting: "Waiting",
  unread: "Finished, unread",
  finished: "Finished",
  failed: "Failed",
};

export function describePluginPanelActivity(
  pluginId: string,
  report: PluginPanelActivityReport,
  seen: boolean,
  pluginName: string
): PluginPanelActivityPresentation {
  const shown: PluginPanelActivityShown =
    report.state === "finished" ? (seen ? "finished" : "unread") : report.state;
  const stated = `Reported by ${pluginName}: ${LABELS[shown]}`;
  return {
    pluginId,
    shown,
    description: report.reason ? `${stated} — ${report.reason}` : stated,
  };
}

/**
 * The plugin a panel's kind belongs to, when that kind declares
 * `reportsActivity`; otherwise null. A PTY-backed plugin panel is a `terminal`
 * that keeps its plugin kind apart, so that is read first (#13213).
 */
export function resolveActivityReporter(
  config: Pick<PanelKindConfig, "reportsActivity" | "extensionId"> | undefined
): string | null {
  if (config?.reportsActivity !== true) return null;
  return config.extensionId ?? null;
}

/** `resolveActivityReporter` for a panel record, read off the live kind registry. */
export function activityReporterForPanel(
  panel: { kind?: string; pluginPanelKindId?: string } | undefined
): string | null {
  if (!panel) return null;
  const config =
    (panel.pluginPanelKindId !== undefined
      ? getPanelKindConfig(panel.pluginPanelKindId)
      : undefined) ?? (panel.kind !== undefined ? getPanelKindConfig(panel.kind) : undefined);
  return resolveActivityReporter(config);
}
