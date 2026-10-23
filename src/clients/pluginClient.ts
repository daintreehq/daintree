import type {
  LoadedPluginInfo,
  ProjectPluginInfo,
  WorktreeDeleteNoteSource,
  WorktreeDeleteNotesAnswer,
} from "@shared/types/plugin";
import type { PluginDiagnosticsSnapshot } from "@shared/types/ipc/pluginDiagnostics";
import type { PluginManifestValidationResult } from "@shared/types/ipc/pluginValidation";
import type { PluginDataBackupOutcome } from "@shared/types/ipc/pluginDataBackup";
import type { PluginPerfSnapshot } from "@shared/types/pluginMetrics";
import type { PluginNotificationSilence } from "@shared/types/ipc/maps";

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

  getProjectPlugins: (): Promise<ProjectPluginInfo[]> => window.electron.plugin.getProjectPlugins(),

  reloadProjectPlugins: (): Promise<void> => window.electron.plugin.reloadProjectPlugins(),

  /** Snapshot a plugin's existing databases through a native save or folder dialog. */
  backupDatabases: (pluginId: string): Promise<PluginDataBackupOutcome> =>
    window.electron.plugin.backupDatabases(pluginId),

  /** The plugins whose toasts and notifications the user silenced (#13818). */
  getNotificationSilences: (): Promise<PluginNotificationSilence[]> =>
    window.electron.plugin.getNotificationSilences(),

  /** Silence or unsilence one plugin instance; resolves with every silence now in force. */
  setNotificationSilenced: (
    pluginId: string,
    silenced: boolean
  ): Promise<PluginNotificationSilence[]> =>
    window.electron.plugin.setNotificationSilenced(pluginId, silenced),

  /** The plugins this view's worktree delete confirmations ask for notes (#13805). */
  getWorktreeDeleteNoteSources: (): Promise<WorktreeDeleteNoteSource[]> =>
    window.electron.plugin.getWorktreeDeleteNoteSources(),

  /**
   * One plugin's notes on a worktree of this view's project, activating it if
   * need be. `null` when it is no longer asked, or the worktree is gone.
   */
  getWorktreeDeleteNotes: (
    worktreeId: string,
    pluginId: string
  ): Promise<WorktreeDeleteNotesAnswer | null> =>
    window.electron.plugin.getWorktreeDeleteNotes({ worktreeId, pluginId }),

  /** Every plugin the host is running, with the instance key each is addressed by. */
  list: (): Promise<LoadedPluginInfo[]> => window.electron.plugin.list(),

  /** Every tracked plugin's cost observations, as main has them now. */
  getPerfSnapshots: (): Promise<PluginPerfSnapshot[]> => window.electron.plugin.getPerfSnapshots(),

  /**
   * Snapshots pushed at most once a second while subscribed; pair with
   * {@link getPerfSnapshots} for the initial state. Returns the unsubscribe.
   */
  onPerfSnapshotsChanged: (callback: (snapshots: PluginPerfSnapshot[]) => void): (() => void) =>
    window.electron.plugin.onPerfSnapshotsChanged(callback),
} as const;
