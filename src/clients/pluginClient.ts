import type { ProjectPluginInfo } from "@shared/types";
import type { PluginDiagnosticsSnapshot } from "@shared/types/ipc/pluginDiagnostics";
import type { PluginManifestValidationResult } from "@shared/types/ipc/pluginValidation";

/**
 * Renderer surface for the plugin-authoring feedback loop (#12214) — the reads
 * and the one re-scan that let an author (or the agent writing for them) find
 * out why a plugin did not load.
 *
 * Deliberately narrow: the plugin manager's own install/enable/settings traffic
 * goes through `usePluginManager`, which owns caching and optimistic state for
 * those. Nothing here is cached — a diagnostics read that returned a stale
 * snapshot would be worse than no diagnostics at all, since the whole point is
 * to observe a change that just happened.
 */
export const pluginClient = {
  validateManifest: (absolutePath: string): Promise<PluginManifestValidationResult> =>
    window.electron.plugin.validateManifest(absolutePath),

  getDiagnosticsSnapshot: (): Promise<PluginDiagnosticsSnapshot> =>
    window.electron.plugin.getDiagnosticsSnapshot(),

  getProjectPlugins: (): Promise<ProjectPluginInfo[]> =>
    window.electron.plugin.getProjectPlugins(),

  reloadProjectPlugins: (): Promise<void> => window.electron.plugin.reloadProjectPlugins(),
} as const;
