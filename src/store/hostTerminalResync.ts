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
      panel.exitCode === undefined &&
      panel.runtimeStatus !== "exited" &&
      panel.runtimeStatus !== "error"
    );
  });
  if (live.length === 0) return;
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
  const state = getState();
  for (const id of live) {
    const answer = confirmed[id];
    if (!answer || answer.exists || answer.conflict) continue;
    const panel = state.panelsById[id];
    if (!panel || !isPtyPanel(panel) || panel.isRestarting) continue;
    if (panel.location === "trash") {
      state.removePanel(id, { backendAlreadyClosed: true });
    } else {
      state.setRuntimeStatus(id, "exited");
    }
  }
}

/** A fresh host session has no record of which panes this view watches. */
function replayWatchedPanels(state: PanelState): void {
  const sync = window.electron.notification?.syncWatchedPanels;
  if (!sync) return;
  sync([...state.watchedPanels].filter((id) => state.panelsById[id] !== undefined));
}
