import { isGitBackedProject } from "@shared/types";
import { agentClipboardDirectory } from "@shared/types/agentSettings";
import type { HydrateResult } from "@shared/types/ipc/app";
import type { BackendTerminalInfo } from "@shared/types/ipc/terminal";
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
 * `lost` maps each pane to the restart key it was lost under. Resolves with
 * those it left for later because this view stopped driving on the way.
 */
export async function relaunchTerminalsLostToHostRestart(
  projectId: string,
  lost: ReadonlyMap<string, number>,
  options: HostRestartRecoveryOptions
): Promise<ReadonlyMap<string, number>> {
  const deferred = new Map<string, number>();
  const hydrate: HydrateResult = await window.electron.app.hydrate();
  if (!options.isCurrent()) return deferred;
  if ((hydrate.workspaceId ?? hydrate.project?.id ?? null) !== projectId) return deferred;
  const entries = (hydrate.appState?.terminals ?? []).filter(
    (entry) =>
      entry !== undefined &&
      entry !== null &&
      typeof entry.id === "string" &&
      entry.id.trim() !== "" &&
      entry.location !== "trash"
  );
  const candidates = entries.filter((entry) => lost.has(entry.id)).slice(0, 256);
  if (candidates.length === 0) return deferred;
  // Asked again just before launching: one the host runs under that id after
  // all (another screen brought it back meanwhile) must not start twice, and
  // one it can't say about is left alone.
  const [answers, running] = await Promise.all([
    window.electron.terminal.reconnectBulk(candidates.map((entry) => entry.id)),
    window.electron.terminal.getForProject(projectId),
  ]);
  if (!options.isCurrent()) return deferred;
  // What the host runs under a saved id, including a pane restarted since it
  // was lost, takes part in who resumes which conversation, as it does on a
  // cold launch, and launches nothing: its reconnect is the resync's. Without
  // its activity tier, the restore has nothing to set on a pane it never adds.
  const savedIds = new Set(entries.map((entry) => entry.id));
  const live = new Map<string, BackendTerminalInfo>();
  for (const info of running) {
    if (info.hasPty === false || info.isTrashed || !savedIds.has(info.id)) continue;
    live.set(info.id, { ...info, activityTier: undefined });
  }
  // Gone by its own answer and off the host's list: either one saying it
  // runs is enough to leave it alone.
  const gone = new Set(
    candidates
      .filter((entry) => {
        const answer = answers[entry.id];
        return answer !== undefined && !answer.exists && !answer.conflict && !live.has(entry.id);
      })
      .map((entry) => entry.id)
  );
  if (gone.size === 0) return deferred;
  const saved = entries.filter((entry) => gone.has(entry.id) || live.has(entry.id));

  const [{ restorePanelsPhase }, { usePanelStore }, { useResourceProfileStore }] =
    await Promise.all([
      import("@/utils/stateHydration/panelRestorePhase"),
      import("@/store/panelStore"),
      import("@/store/resourceProfileStore"),
    ]);
  if (!options.isCurrent()) return deferred;

  const addPanel: PanelRestoreContext["addPanel"] = async (args) => {
    const id = args.requestedId;
    const restartKey = id === undefined || !gone.has(id) ? undefined : lost.get(id);
    // Only a pane this restart ended, under its own id, is this relaunch's to make.
    if (id === undefined || restartKey === undefined) return "";
    // Plain and agent terminals, the kinds the resync itself adopts; a pane
    // of any other kind stays as the resync left it.
    if ((args.kind ?? "terminal") !== "terminal") return "";
    if (!options.isCurrent()) return "";
    if (!options.drives()) {
      deferred.set(id, restartKey);
      return "";
    }
    // What the view shows now outranks the host's save, which a rename or a
    // move made while the link was down never reached.
    const shownNow = usePanelStore.getState().panelsById[id];
    const shown =
      shownNow && (shownNow.location === "grid" || shownNow.location === "dock")
        ? {
            location: shownNow.location,
            ...(shownNow.titleMode === "user" && {
              title: shownNow.title,
              titleMode: shownNow.titleMode,
            }),
          }
        : {};
    const launched = await usePanelStore.getState().addPanel({
      ...args,
      ...shown,
      kind: "terminal",
      replacesLostTerminal: restartKey,
      // Already counted: the pane is there, only its terminal is new.
      bypassLimits: true,
      focusPolicy: "preserve",
    });
    return launched ?? "";
  };

  const project = hydrate.project;
  const status = worktreeClient.getAllWithStatus().catch(() => null);
  const tmpDir = hydrate.hostTmpDir ?? (isRemoteWindow() ? undefined : hydrate.systemTmpDir);

  logInfo("[HostRestart] Relaunching the terminals a host restart ended", {
    projectId,
    count: gone.size,
  });
  await restorePanelsPhase(saved, {
    addPanel,
    withHydrationBatch: (run) => run(),
    // Only saved ids are here, so the restore appends nothing the host runs as an orphan.
    backendTerminalMap: live,
    prefetchedReconnectResults: answers,
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
  return deferred;
}
