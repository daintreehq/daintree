import { isPtyPanel, type PanelKind } from "@shared/types/panel";
import type { AgentState } from "@shared/types/agent";
import type { BackendTerminalInfo, TerminalReconnectResult } from "@shared/types/ipc/terminal";
import { getWorktreePathIndex, getWorktreeSelectionSnapshot } from "@/store/storeAccessors";
import { cancelDriveLeaseHold, isHeldForDriveLease } from "@/store/driveLeaseWaitStore";
import { logWarn } from "@/utils/logger";
import {
  load as loadTerminalService,
  with as withTerminalService,
} from "@/services/terminal/terminalInstanceServiceAccessor";
import type { TerminalPaintPlane } from "@/services/TerminalInstanceService";
import { isSpawnUnconfirmed } from "@/store/slices/panelRegistry/unconfirmedSpawn";
import { hostObservedAt } from "@shared/utils/restoreProvenance";

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
  /**
   * Told of each pane this pass reports gone, with its restart key: after a
   * host restart these are what the restart ended. One whose agent had
   * already quit is left out, since nothing in it was running to be ended.
   */
  onLost?: (id: string, restartKey: number) => void;
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
  const { usePanelStore } = await import("@/store/panelStore");
  const terminalInstanceService = await terminalServiceForResync(usePanelStore.getState());
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
    takeHostAgentState(info.id, info, store, terminalInstanceService);
  }

  adoptAwaitedTerminals(infos, usePanelStore, terminalInstanceService);

  if (options.follow) {
    await followHostTerminals(infos, exitedBefore, usePanelStore);
    if (!options.isCurrent()) return;
  }

  // A spawn whose answer was lost is still this view's own launch, closed or
  // not: its check attaches it or ends it once the host answers.
  await adoptNewTerminals(
    infos.filter((info) => !store.panelsById[info.id] && !isSpawnUnconfirmed(info.id)),
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

type ResyncTerminalService = Pick<TerminalPaintPlane, "setAgentState" | "fetchAndRestore">;

/**
 * A view with no terminal yet has not loaded the service, and an empty host
 * list gives it nothing to load it for (#14267): its calls wait for the
 * service the first terminal brings instead.
 */
async function terminalServiceForResync(state: PanelState): Promise<ResyncTerminalService> {
  const hasPtyPanel = state.panelIds.some((id) => {
    const panel = state.panelsById[id];
    return panel !== undefined && isPtyPanel(panel);
  });
  if (hasPtyPanel) return loadTerminalService();
  return {
    setAgentState: (id, agentState) =>
      withTerminalService((service) => service.setAgentState(id, agentState), id),
    fetchAndRestore: (id) =>
      new Promise<boolean>((resolve, reject) =>
        withTerminalService((service) => {
          service.fetchAndRestore(id).then(resolve, reject);
        }, id)
      ),
  };
}

type HostAgentStateRecord = Pick<
  BackendTerminalInfo,
  "agentState" | "lastStateChange" | "agentIncarnation" | "waitingReason"
>;

/**
 * Take the host's agent state for a pane where it is newer than the state the
 * host last reported there, or belongs to a new incarnation of the agent.
 * `overGuess` takes it whatever its
 * stamp: the pane holds only the state it guessed at launch, which the host's
 * own clock never has to be ahead of.
 */
export function takeHostAgentState(
  id: string,
  record: HostAgentStateRecord,
  store: Pick<PanelState, "panelsById" | "updateAgentState" | "noteAgentObservation">,
  instances: { setAgentState: (id: string, state: AgentState) => void },
  overGuess = false
): void {
  const panel = store.panelsById[id];
  if (!panel || !isPtyPanel(panel) || panel.isRestarting) return;
  if (!record.agentState || typeof record.lastStateChange !== "number") return;
  const newIncarnation =
    overGuess ||
    (record.agentIncarnation !== undefined &&
      panel.agentIncarnation !== undefined &&
      record.agentIncarnation !== panel.agentIncarnation);
  const observedAt = hostObservedAt(panel);
  if (!newIncarnation && observedAt !== undefined && record.lastStateChange <= observedAt) {
    return;
  }
  instances.setAgentState(id, record.agentState);
  // Same guard as the live state listener: a waiting report never overwrites
  // the renderer's directing, which the controller only writes on entry and
  // so could not restore on later keystrokes.
  if (!newIncarnation && panel.agentState === "directing" && record.agentState === "waiting") {
    store.noteAgentObservation(id, record.agentState, record.lastStateChange);
    return;
  }
  store.updateAgentState(
    id,
    record.agentState,
    undefined,
    record.lastStateChange,
    undefined,
    undefined,
    record.waitingReason
  );
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
      // The assistant's own pane: the host keeps it off the project's list and
      // its reconnect probe answers "gone" for a live one, so neither can say
      // it went. Its lane checks for itself (HelpSessionController).
      panel.location !== "overlay" &&
      // Following, this screen's own panes (the assistant) are never on the
      // host's project list, and say nothing about the driver.
      (!options.follow || followsHostLayout(panel)) &&
      !panel.isRestarting &&
      // Still starting: nothing ran yet to be lost, and its own spawn settles it.
      panel.spawnStatus !== "spawning" &&
      !panel.spawnError &&
      // Waiting for control, it has started nothing the host could have lost.
      !isHeldForDriveLease(id) &&
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
  let confirmed: Record<string, TerminalReconnectResult>;
  try {
    confirmed = await window.electron.terminal.reconnectBulk(live.slice(0, 256));
  } catch (error) {
    logWarn("[HostResync] Couldn't confirm which terminals the host dropped", { error });
    return;
  }
  if (!options.isCurrent()) return;
  const terminalInstanceService = await loadTerminalService();
  if (!options.isCurrent()) return;
  const state = getState();
  for (const id of live) {
    const answer = confirmed[id];
    if (!answer || answer.conflict) continue;
    const panel = state.panelsById[id];
    if (!panel || !isPtyPanel(panel) || panel.isRestarting) continue;
    // Refused while the probe was out, it now waits for control instead.
    if (isHeldForDriveLease(id)) continue;
    if (panel.spawnStatus === "spawning") continue;
    if ((panel.restartKey ?? 0) !== probed.get(id)) continue;
    // A real exit reported while the probe was out already says it all, code included.
    if (panel.exitCode !== undefined || panel.runtimeStatus === "exited") continue;
    if (answer.exists) {
      // Off the project's list because the driver trashed it: the list leaves
      // trashed terminals out. It comes back through adoption if the driver
      // restores it. Anything else still running (a restart caught between
      // its kill and its spawn) stays.
      if (options.follow && answer.isTrashed === true && followsHostLayout(panel)) {
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
      if (panel.agentState !== "exited") options.onLost?.(id, panel.restartKey ?? 0);
    }
  }
}

type PanelStore = typeof import("@/store/panelStore").usePanelStore;

/**
 * A pane waiting for control whose terminal the host runs after all (the
 * driver started that id itself): it attaches to it, and the launch it was
 * holding never runs, so the id isn't spawned twice. One whose launch is
 * already on its way checks the host for itself before it spawns.
 */
function adoptAwaitedTerminals(
  infos: BackendTerminalInfo[],
  store: PanelStore,
  instances: Pick<TerminalPaintPlane, "fetchAndRestore">
): void {
  for (const info of infos) {
    if (info.hasPty === false || info.isTrashed) continue;
    const panel = store.getState().panelsById[info.id];
    if (!panel || !isPtyPanel(panel) || panel.spawnStatus !== "spawning") continue;
    if (!cancelDriveLeaseHold(info.id)) continue;
    store.setState((current) => {
      const target = current.panelsById[info.id];
      if (!target || !isPtyPanel(target) || target.spawnStatus !== "spawning") return current;
      return {
        panelsById: { ...current.panelsById, [info.id]: { ...target, spawnStatus: "ready" } },
      };
    });
    instances.fetchAndRestore(info.id).catch((error: unknown) => {
      logWarn("[HostResync] Couldn't restore an adopted terminal's output", { error });
    });
  }
}

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
            sessionPreservingExit: undefined,
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
