import { isGitBackedProject } from "@shared/types";
import { agentClipboardDirectory } from "@shared/types/agentSettings";
import type { HydrateResult } from "@shared/types/ipc/app";
import type { TerminalReconnectResult } from "@shared/types/ipc/terminal";
import { worktreeClient } from "@/clients";
import { isRemoteWindow } from "@/hooks/useHostPlatform";
import { getWorktreeSelectionSnapshot } from "@/store/storeAccessors";
import type { PanelRestoreContext } from "@/utils/stateHydration/panelRestorePhase";
import { logDebug, logInfo } from "@/utils/logger";

export interface HostRestartRecoveryOptions {
  /** False once the view moved on or a newer resync took over. */
  isCurrent: () => boolean;
  /** This view still drives the project; asked again before each launch. */
  drives: () => boolean;
}

/**
 * Bring back the panes a host restart ended, as a cold launch of this view
 * would: the host's saved state for each goes through the same restore, which
 * elects who resumes which conversation, honours the resume setting and the
 * holds, and respawns each agent into its conversation. A pane is replaced in
 * place, keeping its spot and its tab, and only while it still shows what the
 * restart left: once it has been restarted or closed, it is the user's.
 *
 * `lost` maps each pane to the restart key it was lost under.
 */
export async function relaunchTerminalsLostToHostRestart(
  projectId: string,
  lost: ReadonlyMap<string, number>,
  options: HostRestartRecoveryOptions
): Promise<void> {
  const hydrate: HydrateResult = await window.electron.app.hydrate();
  if (!options.isCurrent()) return;
  if ((hydrate.workspaceId ?? hydrate.project?.id ?? null) !== projectId) return;
  const saved = (hydrate.appState?.terminals ?? []).filter(
    (entry) =>
      entry !== undefined &&
      entry !== null &&
      typeof entry.id === "string" &&
      lost.has(entry.id) &&
      entry.location !== "trash"
  );
  if (saved.length === 0) return;

  const [{ restorePanelsPhase }, { usePanelStore }, { useResourceProfileStore }] =
    await Promise.all([
      import("@/utils/stateHydration/panelRestorePhase"),
      import("@/store/panelStore"),
      import("@/store/resourceProfileStore"),
    ]);
  if (!options.isCurrent() || !options.drives()) return;

  const addPanel: PanelRestoreContext["addPanel"] = async (args) => {
    const id = args.requestedId;
    const restartKey = id === undefined ? undefined : lost.get(id);
    // Only a pane this restart ended, under its own id, is this relaunch's to make.
    if (id === undefined || restartKey === undefined) return id ?? "";
    // Plain and agent terminals, the kinds the resync itself adopts; a pane
    // of any other kind stays as the resync left it.
    if ((args.kind ?? "terminal") !== "terminal") return id;
    if (!options.isCurrent() || !options.drives()) return id;
    const launched = await usePanelStore.getState().addPanel({
      ...args,
      kind: "terminal",
      replacesLostTerminal: restartKey,
      // Already counted: the pane is there, only its terminal is new.
      bypassLimits: true,
      focusPolicy: "preserve",
    });
    return launched ?? id;
  };

  const project = hydrate.project;
  const status = worktreeClient.getAllWithStatus().catch(() => null);
  const tmpDir = hydrate.hostTmpDir ?? (isRemoteWindow() ? undefined : hydrate.systemTmpDir);
  // Each one the host just confirmed it no longer has, so none is asked about again.
  const gone: Record<string, TerminalReconnectResult> = Object.fromEntries(
    saved.map((entry) => [entry.id, { exists: false }])
  );

  logInfo("[HostRestart] Relaunching the terminals a host restart ended", {
    projectId,
    count: saved.length,
  });
  await restorePanelsPhase(saved, {
    addPanel,
    withHydrationBatch: (run) => run(),
    // Nothing the host runs now is appended: this restores only what the restart ended.
    backendTerminalMap: new Map(),
    prefetchedReconnectResults: gone,
    terminalSizes: hydrate.terminalSizes ?? {},
    activeWorktreeId:
      getWorktreeSelectionSnapshot()?.activeWorktreeId ??
      hydrate.appState?.activeWorktreeId ??
      null,
    workspaceHasWorktreesPromise:
      project == null || !isGitBackedProject(project)
        ? Promise.resolve(false)
        : status.then((result) => result?.gitBacked !== false),
    projectRoot: project?.path ?? "",
    projectId,
    agentSettings: hydrate.agentSettings,
    clipboardDirectory: tmpDir ? agentClipboardDirectory(tmpDir, isRemoteWindow()) : undefined,
    projectPresetsByAgent: hydrate.projectPresets ?? {},
    worktreesPromise: status.then((result) => result?.worktrees ?? null),
    safeMode: hydrate.safeMode,
    resourceProfile: useResourceProfileStore.getState().profile,
    logHydrationInfo: (message, context) => logDebug(`[HostRestart] ${message}`, context),
  });
}
