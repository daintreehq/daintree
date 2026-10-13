import { isPtyPanel, type PanelKind } from "@shared/types/panel";
import type { BackendTerminalInfo } from "@shared/types/ipc/terminal";
import { getWorktreePathIndex, getWorktreeSelectionSnapshot } from "@/store/storeAccessors";
import { logWarn } from "@/utils/logger";

export interface HostTerminalResyncOptions {
  /**
   * False once a newer resync was requested or the view moved on. Checked
   * after every await, so an obsolete snapshot is never applied over a newer one.
   */
  isCurrent: () => boolean;
  /**
   * This view follows the driver's panels (it watches, or has just taken the
   * project over): a terminal the host has trashed leaves this view's layout,
   * and one shown as exited that the host runs again (a restart) is shown
   * running. Removing what the driver closed is the layout rehydrate's, which
   * knows what the driver still shows.
   */
  follow?: boolean;
}

/**
 * Bring this view's terminals in line with the host's own list after the view
 * missed events: adopt terminals created while it was away, observe the ones
 * that are gone, and take the host's agent state where it is newer or belongs
 * to a new incarnation of the agent. Output is not part of this; it resumes
 * on its own stream.
 */
export async function resyncHostTerminals(
  projectId: string,
  options: HostTerminalResyncOptions
): Promise<void> {
  // Taken before asking, so a pane opened while the answer is in flight is
  // never judged against a list that predates it.
  const [{ usePanelStore }, { terminalInstanceService }] = await Promise.all([
    import("@/store/panelStore"),
    import("@/services/TerminalInstanceService"),
  ]);
  const knownBefore = new Set(usePanelStore.getState().panelIds);
  const before = usePanelStore.getState();
  const exitedBefore = new Set(
    options.follow ? [...knownBefore].filter((id) => showsExited(before, id)) : []
  );
  const infos = await window.electron.terminal.getForProject(projectId);
  if (!options.isCurrent()) return;

  const onHost = new Map(infos.map((info) => [info.id, info]));
  const store = usePanelStore.getState();

  for (const info of infos) {
    const panel = store.panelsById[info.id];
    if (!panel || !isPtyPanel(panel) || panel.isRestarting) continue;
    if (!info.agentState || typeof info.lastStateChange !== "number") continue;
    const newIncarnation =
      info.agentIncarnation !== undefined &&
      panel.agentIncarnation !== undefined &&
      info.agentIncarnation !== panel.agentIncarnation;
    if (!newIncarnation && panel.lastStateChange && info.lastStateChange <= panel.lastStateChange) {
      continue;
    }
    terminalInstanceService.setAgentState(info.id, info.agentState);
    store.updateAgentState(
      info.id,
      info.agentState,
      undefined,
      info.lastStateChange,
      undefined,
      undefined,
      info.waitingReason
    );
  }

  if (options.follow) {
    await followHostTerminals(infos, exitedBefore, usePanelStore);
    if (!options.isCurrent()) return;
  }

  await adoptNewTerminals(
    infos.filter((info) => !store.panelsById[info.id]),
    store.addPanel,
    options
  );
  if (!options.isCurrent()) return;

  await observeVanishedTerminals(
    [...knownBefore].filter((id) => !onHost.has(id)),
    usePanelStore.getState,
    options
  );
  if (!options.isCurrent()) return;

  replayWatchedPanels(usePanelStore.getState());
}

/**
 * Only plain and agent terminals come back from a bare host record; other
 * PTY-backed kinds carry state of their own that the record can't rebuild.
 */
const ADOPTABLE_KINDS: ReadonlySet<PanelKind> = new Set<PanelKind>(["terminal"]);

type PanelState = ReturnType<typeof import("@/store/panelStore").usePanelStore.getState>;

async function adoptNewTerminals(
  added: BackendTerminalInfo[],
  addPanel: PanelState["addPanel"],
  options: HostTerminalResyncOptions
): Promise<void> {
  const live = added.filter((info) => info.hasPty !== false && !info.isTrashed);
  if (live.length === 0) return;
  const { buildArgsForOrphanedTerminal, inferWorktreeIdFromCwd } =
    await import("@/utils/stateHydration/statePatcher");
  if (!options.isCurrent()) return;
  const worktrees = [...(getWorktreePathIndex() ?? new Map<string, string>())].map(
    ([id, path]) => ({ id, path })
  );
  const activeWorktreeId = getWorktreeSelectionSnapshot()?.activeWorktreeId ?? null;
  for (const info of live) {
    const { kind, ...args } = buildArgsForOrphanedTerminal(info, "");
    if (kind !== undefined && !ADOPTABLE_KINDS.has(kind)) continue;
    const worktreeId = inferWorktreeIdFromCwd(info.cwd, worktrees) ?? activeWorktreeId;
    if (worktreeId) {
      args.worktreeId = worktreeId;
      args.worktreeIdSource = "inferred";
    }
    try {
      // Already running on the host, so the pane cap that gates new spawns
      // doesn't apply, just as on restore.
      await addPanel({ ...args, kind: "terminal", bypassLimits: true });
    } catch (error) {
      logWarn("[HostResync] Couldn't show a terminal the host started", { error });
    }
    if (!options.isCurrent()) return;
  }
}

/**
 * A terminal this view shows as running that the host no longer lists is
 * reported as exited, not removed: the pane and its output stay for review,
 * as they would had the exit event arrived. A trashed one was only waiting
 * for its PTY to go, so it goes.
 */
async function observeVanishedTerminals(
  candidates: string[],
  getState: () => PanelState,
  options: HostTerminalResyncOptions
): Promise<void> {
  const live = candidates.filter((id) => {
    const panel = getState().panelsById[id];
    return (
      panel !== undefined &&
      isPtyPanel(panel) &&
      !panel.isRestarting &&
      !panel.spawnError &&
      // Held for restore recovery: it has no PTY on purpose, and is waiting on the user.
      panel.restoreRecovery === undefined &&
      panel.exitCode === undefined &&
      panel.runtimeStatus !== "exited" &&
      panel.runtimeStatus !== "error"
    );
  });
  if (live.length === 0) return;
  // The incarnation each answer is about: a restart landing while the probe is
  // out is a new PTY, and an answer about the old one says nothing about it.
  const probed = new Map(
    live.map((id) => {
      const panel = getState().panelsById[id];
      return [id, panel && isPtyPanel(panel) ? (panel.restartKey ?? 0) : 0];
    })
  );
  // A spawn still in flight when the list was read isn't on it yet; ask about
  // each one directly before calling it gone, and change nothing if unsure.
  let confirmed: Record<string, { exists: boolean; conflict?: boolean }>;
  try {
    confirmed = await window.electron.terminal.reconnectBulk(live.slice(0, 256));
  } catch (error) {
    logWarn("[HostResync] Couldn't confirm which terminals the host dropped", { error });
    return;
  }
  if (!options.isCurrent()) return;
  const { terminalInstanceService } = await import("@/services/TerminalInstanceService");
  if (!options.isCurrent()) return;
  const state = getState();
  for (const id of live) {
    const answer = confirmed[id];
    if (!answer || answer.conflict) continue;
    const panel = state.panelsById[id];
    if (!panel || !isPtyPanel(panel) || panel.isRestarting) continue;
    if ((panel.restartKey ?? 0) !== probed.get(id)) continue;
    // A real exit reported while the probe was out already says it all, code included.
    if (panel.exitCode !== undefined || panel.runtimeStatus === "exited") continue;
    if (answer.exists) {
      // Still running on the host but off its project list: the list leaves
      // trashed terminals out, so the driver trashed it. It comes back through
      // adoption if the driver restores it. A spawn can't be in flight here:
      // a watcher starts nothing, and this pane was on an earlier list.
      if (options.follow && followsHostLayout(panel)) {
        state.removePanel(id, { backendAlreadyClosed: true });
      }
      continue;
    }
    if (panel.location === "trash") {
      state.removePanel(id, { backendAlreadyClosed: true });
    } else {
      // No exit code: none was seen. Left undefined, a restart relaunches an
      // agent as the agent rather than demoting it to a shell.
      state.setRuntimeStatus(id, "exited");
      terminalInstanceService.reportLost(id, "The host no longer has this terminal");
    }
  }
}

type PanelStore = typeof import("@/store/panelStore").usePanelStore;

function showsExited(state: PanelState, id: string): boolean {
  const panel = state.panelsById[id];
  return (
    panel !== undefined &&
    isPtyPanel(panel) &&
    (panel.exitCode !== undefined || panel.runtimeStatus === "exited")
  );
}

/**
 * A pane that shows the driver's layout, as opposed to one that belongs to this
 * screen alone (the assistant, a dialog) or is held for restore recovery.
 */
export function followsHostLayout(panel: PanelState["panelsById"][string]): boolean {
  if ((panel.kind ?? "terminal") !== "terminal") return false;
  if (panel.location !== "grid" && panel.location !== "dock") return false;
  if (panel.excludeFromPersistence) return false;
  return !isPtyPanel(panel) || (panel.removeOnExit !== true && panel.restoreRecovery === undefined);
}

/**
 * Following the driver: a terminal the host lists as trashed leaves this
 * view's layout, and one shown as exited that the host runs again was
 * restarted there. Only a pane already exited before the list was read is
 * revived: an exit landing while the answer travelled is about the process
 * the list saw.
 */
async function followHostTerminals(
  infos: BackendTerminalInfo[],
  exitedBefore: ReadonlySet<string>,
  store: PanelStore
): Promise<void> {
  const { deriveRuntimeStatus } = await import("@/store/slices/panelRegistry/helpers");
  for (const info of infos) {
    const state = store.getState();
    const panel = state.panelsById[info.id];
    if (!panel || !isPtyPanel(panel) || panel.isRestarting || !followsHostLayout(panel)) continue;
    if (info.isTrashed) {
      state.removePanel(info.id, { backendAlreadyClosed: true });
      continue;
    }
    if (info.hasPty === false || !exitedBefore.has(info.id) || !showsExited(state, info.id)) {
      continue;
    }
    // The host already runs the new process under this id; nothing is started
    // here. The new restart key remounts the pane, which drops the exit it showed.
    store.setState((current) => {
      const target = current.panelsById[info.id];
      if (!target || !isPtyPanel(target)) return current;
      return {
        panelsById: {
          ...current.panelsById,
          [info.id]: {
            ...target,
            exitCode: undefined,
            restartKey: (target.restartKey ?? 0) + 1,
            runtimeStatus: deriveRuntimeStatus(target.isVisible, target.flowStatus),
          },
        },
      };
    });
  }
}

/** A fresh host session has no record of which panes this view watches. */
function replayWatchedPanels(state: PanelState): void {
  const sync = window.electron.notification?.syncWatchedPanels;
  if (!sync) return;
  sync([...state.watchedPanels].filter((id) => state.panelsById[id] !== undefined));
}
