import type { AgentId } from "@shared/types/agent";
import type { PanelRegistryStoreApi } from "./types";
import type { AddPanelOptions } from "@shared/types/addPanelOptions";
import { isPtyPanel, type PanelLocation, type PtyPanelData } from "@shared/types/panel";
import { terminalClient } from "@/clients";
import {
  load as loadTerminalService,
  peek as peekTerminalService,
} from "@/services/terminal/terminalInstanceServiceAccessor";
import { saveNormalized } from "./persistence";
import { deferPersistToBatchEnd, isHydrationBatchActive } from "./hydrationBatch";
import { reconcileWorktreeAfterSpawn } from "./helpers";
import { logWarn, logError } from "@/utils/logger";
import { markRendererPerformance } from "@/utils/performance";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { isClientAppError } from "@/utils/clientAppError";
import { requiredPluginToolsSpawnError } from "@/utils/requiredPluginToolsSpawnError";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { isUnknownOutcomeError } from "@/utils/resolveUnknownOutcome";
import { useHostConnectionStore, waitForHostConnected } from "@/store/hostConnectionStore";
import { takeHostAgentState } from "@/store/hostTerminalResync";
import { findSpawnOnHost, isLostSpawnReply, markSpawnUnconfirmed } from "./unconfirmedSpawn";
import { agentLifecycleLedger } from "@/services/terminal/lifecycleLedger";
import {
  clearPanelMemoryPressureMark,
  holdForMemoryPressure,
  isMemoryPressureCritical,
  panelHoldKey,
} from "@/store/memoryPressureWaitStore";
import {
  clearPanelDriveLeaseMark,
  drivesProject,
  holdForDriveLease,
  markPanelDriveLeaseLaunch,
  watchesProject,
} from "@/store/driveLeaseWaitStore";
import { getDriveLeaseSnapshot } from "@/services/terminal/inputGate";
import { isUsableTerminalGeometry } from "@shared/types/terminal";
import { buildAgentLaunchContext } from "./agentLaunchContext";

const TERMINAL_STARTUP_ATTACH_TIMEOUT_MS = 2500;

// Starts at once when the service is already up, as a direct call would.
function fetchAndRestoreTerminal(id: string): Promise<boolean> {
  const service = peekTerminalService();
  if (service) return service.fetchAndRestore(id);
  return loadTerminalService().then((loaded) => loaded.fetchAndRestore(id));
}

/**
 * Live grid of an ATTACHED renderer xterm. Returns null until the instance is
 * mounted in the real DOM — a prewarmed (never-attached) instance still holds
 * its construction-default grid, which must not be mistaken for a fitted
 * measurement.
 */
function getAttachedGridDims(id: string): { cols: number; rows: number } | null {
  const managed = peekTerminalService()?.get(id);
  if (!managed?.terminal.element?.isConnected) return null;
  const grid = { cols: managed.terminal.cols, rows: managed.terminal.rows };
  // Attached is not the same as laid out. A pane attached into a container that
  // has not laid out yet holds whatever grid it was constructed on, and the
  // post-spawn re-assert would then hand that to the PTY as the pane's real
  // size — one of the routes to #12442. A collapsed grid is treated as no
  // measurement at all, so the caller keeps the spawn dims and the first real
  // fit corrects both halves. Anything above that is taken at face value: this
  // often IS the fitted grid, and second-guessing it would discard the very
  // measurement the re-assert exists to deliver.
  if (!isUsableTerminalGeometry(grid)) {
    logWarn("[TerminalStore] Ignoring a collapsed attached grid", {
      id,
      cols: managed.terminal.cols,
      rows: managed.terminal.rows,
    });
    return null;
  }
  return grid;
}

/**
 * Whether the pane's chrome is on the page. The queue holds the next spawn on a
 * visible attach only to pace xterm realization (#5789), and only a pane on the
 * page has an attach coming: one that is in another worktree by now, in a
 * hidden tab, or behind a maximized pane cost every launch behind it the full
 * timeout (#15271).
 */
function isPaneOnPage(id: string): boolean {
  if (typeof document === "undefined") return false;
  for (const element of document.querySelectorAll<HTMLElement>("[data-panel-id]")) {
    if (element.dataset.panelId === id) return true;
  }
  return false;
}

class TerminalStartupQueue {
  private readonly tasks: Array<{ run: () => Promise<void>; concurrency: number }> = [];
  private activeTasks = 0;
  private reservations = 0;

  /** True when an enqueued task would start immediately (single-launch fast path). */
  get isIdle(): boolean {
    return this.tasks.length === 0 && this.activeTasks === 0 && this.reservations === 0;
  }

  /**
   * Claim a pending slot between the synchronous eager-attach decision and
   * the (post-await) enqueue. Concurrent addPanel calls — a recipe's
   * Promise.allSettled burst — would otherwise all observe an idle queue and
   * every panel would stamp eagerAttach, realizing many xterms in the same
   * frame (the exact burst #5789 gates against). Released on enqueue.
   */
  reserve(): void {
    this.reservations++;
  }

  enqueue(task: () => Promise<void>, concurrency = 1): void {
    if (this.reservations > 0) this.reservations--;
    this.tasks.push({ run: task, concurrency });
    this.drain();
  }

  /** Queue a launch that already left the queue once; it never reserved a slot, so it releases none. */
  requeue(task: () => Promise<void>): void {
    this.tasks.push({ run: task, concurrency: 1 });
    this.drain();
  }

  private drain(): void {
    while (this.tasks.length > 0 && this.activeTasks < this.tasks[0]!.concurrency) {
      const task = this.tasks.shift();
      if (!task) continue;
      this.activeTasks++;
      void this.runTask(task.run);
    }
  }

  private async runTask(task: () => Promise<void>): Promise<void> {
    try {
      await task();
    } catch (error) {
      logError("[TerminalStore] Terminal startup task failed", error);
    } finally {
      this.activeTasks--;
      this.drain();
    }
  }
}

export const terminalStartupQueue = new TerminalStartupQueue();
const RECIPE_TERMINAL_STARTUP_CONCURRENCY = 3;

/** Everything a committed PTY panel's queued startup reads, captured before it is queued. */
export interface PtyStartupLaunch {
  readonly id: string;
  readonly launchGeneration: number;
  readonly options: AddPanelOptions;
  readonly kind: "terminal" | "dev-preview";
  readonly launchAgentId: AgentId | undefined;
  readonly pluginPanelKindId: string | undefined;
  readonly location: PanelLocation;
  readonly isInActiveWorktree: boolean;
  readonly capturedWorkspaceId: string | undefined;
  readonly lastStateChange: number | undefined;
  readonly constructionDims: { cols: number; rows: number } | null;
  readonly spawnEnvPromise: Promise<Record<string, string> | undefined>;
}

export function enqueuePtyStartup(
  set: PanelRegistryStoreApi["setState"],
  get: PanelRegistryStoreApi["getState"],
  launch: PtyStartupLaunch
): void {
  const {
    id,
    launchGeneration,
    options,
    kind,
    launchAgentId,
    pluginPanelKindId,
    location,
    isInActiveWorktree,
    capturedWorkspaceId,
    lastStateChange,
    constructionDims,
    spawnEnvPromise,
  } = launch;
  const shouldWaitForVisibleAttach = location === "grid" && isInActiveWorktree;
  // An agent pane waits out critical kernel memory pressure before it spawns
  // (#13530), launches and restores alike. Not the assistant: it renders in
  // its own surface, and asking it about memory is what the memory notice
  // offers.
  const holdsForMemoryPressure =
    Boolean(launchAgentId) && location !== "overlay" && location !== "dialog";
  // Any pane waits for control of its project (#13913), save the assistant
  // and dialog panes, whose own surfaces handle a launch that didn't start.
  const holdsForDriveLease = location !== "overlay" && location !== "dialog";
  // The launch's prompt becomes the pane's record once this launch's own
  // process is running (#14592): a spawn that fails or is refused never
  // delivered it, and a pane a restart has taken over belongs to its successor.
  const started = <T extends PtyPanelData>(current: T): T =>
    options.launchPrompt && !current.firstPrompt && !current.isRestarting
      ? { ...current, firstPrompt: options.launchPrompt }
      : current;
  const persistLaunchPrompt = (): void => {
    if (!options.launchPrompt) return;
    if (isHydrationBatchActive()) {
      deferPersistToBatchEnd();
      return;
    }
    const after = get();
    saveNormalized(after.panelsById, after.panelIds);
  };
  const isStillStarting = (): boolean => {
    const current = get().panelsById[id];
    return (
      Boolean(current && isPtyPanel(current) && current.spawnStatus === "spawning") &&
      agentLifecycleLedger.isCurrent(id, launchGeneration)
    );
  };
  // The host already runs this id: the pane attaches to that terminal, as a
  // reconnect does, and nothing is spawned.
  const adoptHostTerminal = (): void => {
    agentLifecycleLedger.recordSpawnResolved(id, launchGeneration, true);
    let adopted = false;
    set((state) => {
      const current = state.panelsById[id];
      if (!current || !isPtyPanel(current) || current.spawnStatus !== "spawning") return state;
      adopted = true;
      // Not this launch's process: the host may run a launch another window
      // started under the id, so this one's prompt is never claimed for it.
      return {
        panelsById: { ...state.panelsById, [id]: { ...current, spawnStatus: "ready" } },
      };
    });
    // What it printed before this pane attached comes from the host's record.
    if (adopted) {
      fetchAndRestoreTerminal(id).catch((error: unknown) => {
        logWarn("[TerminalStore] Couldn't restore an adopted terminal's output", { id, error });
      });
    }
  };

  // The panel chrome is already committed. Realize backend PTY startup and
  // visible xterm.open() through a bounded queue so bulk recipes can add many
  // panels without making Chromium/xterm settle every terminal in the same
  // frame. spawnStatus remains "spawning" while queued, so TerminalPane shows
  // lightweight chrome instead of mounting XtermAdapter. Named so a launch
  // held for memory pressure can queue itself again when it continues.
  terminalStartupQueue.enqueue(
    async function startPty(
      launchAnyway = false,
      resumed = false,
      controlArrived = false
    ): Promise<void> {
      if (resumed) clearPanelMemoryPressureMark(id);
      // Set once this run hands the launch on (to a hold or a retry), which
      // then owns the pane's mark.
      let handedOn = false;
      // Held outside the queue until this view drives the project (#13913):
      // the host refuses a spawn from a view that only watches, and a refusal
      // left standing would cost a restore its resume. It continues with the
      // launch it was given, command and session id included.
      const waitForControl = (projectId: string): void => {
        handedOn = true;
        holdForDriveLease(id, {
          projectId,
          resume: () => terminalStartupQueue.requeue(() => startPty(launchAnyway, false, true)),
          isStale: () => !isStillStarting(),
          // Closed while it waited: it stays held in the trash, as a pane held
          // for memory pressure does, rather than starting unseen.
          isDeferred: () => get().panelsById[id]?.location === "trash",
        });
      };
      // A launch control released keeps its pane marked until its spawn has
      // an answer, so a restart can't start a second one beside it. Never a
      // successor's mark, and gone before the attach wait, which needs the
      // terminal on screen.
      const settleControl = (): void => {
        if (controlArrived && !handedOn && agentLifecycleLedger.isCurrent(id, launchGeneration)) {
          clearPanelDriveLeaseMark(id);
        }
      };
      const waitOutMemoryPressure = (): void => {
        // A launch control released keeps its mark through the memory wait:
        // a restart stays off it until its spawn has an answer.
        if (controlArrived) handedOn = true;
        holdForMemoryPressure(panelHoldKey(id), {
          panelId: id,
          resume: (anyway) =>
            terminalStartupQueue.enqueue(() => startPty(anyway, true, controlArrived)),
          isStale: () => !isStillStarting(),
          // A pane closed while it waited stays held in the trash, so an
          // undo brings back the same waiting launch rather than one that
          // started unseen.
          isDeferred: () => get().panelsById[id]?.location === "trash",
        });
      };
      // A released launch whose pane was closed before its turn goes back to
      // the wait it came from, in the trash, rather than starting unseen.
      const waitInTrash = (): boolean => {
        if (get().panelsById[id]?.location !== "trash") return false;
        if (controlArrived && capturedWorkspaceId) {
          waitForControl(capturedWorkspaceId);
          return true;
        }
        if (resumed && holdsForMemoryPressure) {
          waitOutMemoryPressure();
          return true;
        }
        return false;
      };
      const _p0 = get().panelsById[id];
      if (!_p0 || !isPtyPanel(_p0) || _p0.spawnStatus !== "spawning") {
        settleControl();
        return;
      }
      markRendererPerformance("agentlaunch.task-start", { id });
      let leaseAtSpawn = getDriveLeaseSnapshot();

      // A spawn the host refused, or one it never started. `keepObservedError`
      // keeps a reason the host already reported for this launch.
      const failSpawn = (error: unknown, keepObservedError = false): void => {
        // Same staleness gate as the success path: never stamp a failure onto
        // a successor incarnation that re-launched this id mid-flight.
        if (!agentLifecycleLedger.recordSpawnResolved(id, launchGeneration, false).accepted) {
          return;
        }
        const current = get().panelsById[id];
        if (!current || !isPtyPanel(current) || current.spawnStatus !== "spawning") return;

        // A refusal from main (a drive lease, a validation) arrives as an
        // encoded AppError: its code is not a spawn errno, and the person
        // reads its userMessage, never the wire prefix.
        const appError = isClientAppError(error) ? error : null;
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- error shape from node-pty spawn rejection
        const err = error as { code?: string; errno?: number; syscall?: string; path?: string };
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- SpawnError construction from caught IPC error
        const errnoSpawnError = {
          code: appError ? "UNKNOWN" : (err.code ?? "UNKNOWN"),
          message: appError
            ? (appError.userMessage ?? appError.message)
            : formatErrorMessage(error, "Failed to start terminal process"),
          errno: err.errno,
          syscall: err.syscall,
          path: err.path,
        } as import("@shared/types/pty-host").SpawnError;
        // A refusal for missing plugin tools keeps its per-plugin states, so
        // the banner can say what's missing and offer to start without them.
        const spawnError = requiredPluginToolsSpawnError(error) ?? errnoSpawnError;

        set((state) => {
          const _current = state.panelsById[id];
          if (!_current || !isPtyPanel(_current) || _current.spawnStatus !== "spawning")
            return state;
          // A launched agent that fails to start never produces a PTY exit, so
          // its optimistic agentState would stay stuck (e.g. "working"). Mark it
          // "exited" so terminal.list / terminal.getStatus report the crash
          // instead of a phantom running agent (#10816). Plain shells have no
          // launchAgentId and keep agentState undefined.
          const agentPatch = _current.launchAgentId
            ? { agentState: "exited" as const, lastStateChange: Date.now() }
            : {};
          return {
            panelsById: {
              ...state.panelsById,
              [id]: {
                ..._current,
                spawnStatus: "failed",
                spawnError: (keepObservedError && _current.spawnError) || spawnError,
                runtimeStatus: "error",
                ...agentPatch,
              },
            },
          };
        });

        const after = get();
        saveNormalized(after.panelsById, after.panelIds);
      };

      try {
        // Asked as each launch reaches the front, not when it was queued, so
        // a restore that tips the machine into critical holds the rest of
        // itself. Started before the env await so the round trips overlap.
        const pressureCheck =
          holdsForMemoryPressure && !launchAnyway ? isMemoryPressureCritical() : null;
        const mergedEnv = await spawnEnvPromise;
        const pressureCritical = pressureCheck !== null && (await pressureCheck);

        markRendererPerformance("agentlaunch.env-ready", { id });
        const _p1 = get().panelsById[id];
        if (!_p1 || !isPtyPanel(_p1) || _p1.spawnStatus !== "spawning") return;

        if (holdsForMemoryPressure) {
          // The pressure round trip and a hold's wait are each long enough for
          // a restart or replay to take this id over, so ownership is checked
          // again before anything starts.
          if (!isStillStarting()) return;
          // Held outside the queue, so a waiting agent never stops the panes
          // queued behind it from starting. A released hold queues one at a
          // time, whatever its batch: pressure has only just eased. One that
          // was closed while its release queued goes back to waiting.
          if (pressureCritical || (resumed && _p1.location === "trash")) {
            waitOutMemoryPressure();
            return;
          }
        }

        if (waitInTrash()) return;
        // A launch that waited, for control or for memory, in a view that
        // follows a drive lease: the driver may have started this very
        // terminal meanwhile (its own restore of the same pane), so attach to
        // it rather than spawn over it. A failed probe says nothing, so the
        // spawn goes.
        if (holdsForDriveLease && (controlArrived || resumed) && getDriveLeaseSnapshot() !== null) {
          const onHost = await terminalClient.reconnect(id).catch(() => null);
          if (!isStillStarting()) return;
          if (onHost?.exists && onHost.hasPty !== false && onHost.isTrashed !== true) {
            adoptHostTerminal();
            return;
          }
          if (waitInTrash()) return;
        }
        // Another screen has control of the project, so the host would refuse
        // the spawn: it waits for control instead of failing.
        leaseAtSpawn = getDriveLeaseSnapshot();
        if (
          holdsForDriveLease &&
          capturedWorkspaceId &&
          watchesProject(leaseAtSpawn, capturedWorkspaceId)
        ) {
          if (isStillStarting()) waitForControl(capturedWorkspaceId);
          return;
        }
        const spawnWorktreeId = _p1.worktreeId;

        const commandToExecute = options.skipCommandExecution ? undefined : options.command;
        // Spawn the PTY at the grid the renderer is actually showing. The
        // overlay XtermAdapter mounts without waiting for spawnStatus, so by
        // now the xterm may already be attached and fitted — a PTY resize it
        // sent before this spawn resolved was silently dropped by the
        // pty-host (no terminal yet), and booting at 80×24 anyway left the
        // CLI painting a width the renderer wasn't wrapping at (#10863).
        const attachedDims = getAttachedGridDims(id);
        const spawnCols = attachedDims?.cols ?? constructionDims?.cols ?? 80;
        const spawnRows = attachedDims?.rows ?? constructionDims?.rows ?? 24;

        // Everything after the host started the terminal, the same whether its
        // answer came back or was found after the link lost it (#13915). True
        // when the pane was promoted to ready.
        const completeSpawn = async (waitForAttach: boolean): Promise<boolean> => {
          // Reject a spawn resolution that no longer belongs to this incarnation:
          // if a restart or hydration replay re-launched the id while our IPC was
          // in flight, the successor owns spawnStatus now and its own resolution
          // manages it. The ledger records the rejection as an anomaly. One
          // carve-out: when the successor's panel is ALSO gone, the backend PTY
          // this resolution just created has no owner at all — kill it, exactly
          // like the orphan path below (killing the shared id is safe only when
          // no live panel claims it).
          if (!agentLifecycleLedger.recordSpawnResolved(id, launchGeneration, true).accepted) {
            if (!get().panelsById[id]) {
              terminalClient.kill(id).catch((killError) => {
                logWarn("[TerminalStore] Compensating kill after stale spawn resolution failed", {
                  id,
                  error: killError,
                });
              });
            }
            return false;
          }

          // Promote spawnStatus to "ready" once the PTY is live. If the panel was
          // removed during the spawn window, issue a compensating kill to avoid
          // orphaning the freshly-spawned PTY (removePanel's kill IPC was a no-op
          // at the time because the backend had no terminal yet).
          let orphaned = false;
          let mountedPanel = false;
          set((state) => {
            const current = state.panelsById[id];
            if (!current) {
              orphaned = true;
              return state;
            }
            if (!isPtyPanel(current) || current.spawnStatus !== "spawning") return state;
            mountedPanel = true;
            return {
              panelsById: {
                ...state.panelsById,
                [id]: { ...started(current), spawnStatus: "ready" },
              },
            };
          });
          if (mountedPanel) persistLaunchPrompt();
          if (orphaned) {
            terminalClient.kill(id).catch((killError) => {
              logWarn("[TerminalStore] Compensating kill after orphan spawn failed", {
                id,
                error: killError,
              });
            });
          } else {
            if (mountedPanel) markRendererPerformance("agentlaunch.ready", { id });
            // Recover the same race on the worktree axis: main awaits admission
            // and settings before it reaches `PtyClient.spawn`, and that call
            // overwrites the replay cache — so a move landing in that window
            // reached a host with no record and was then clobbered. Placed past
            // the incarnation gate, so a successor's filing is never re-stamped
            // from this resolution (#12060).
            reconcileWorktreeAfterSpawn(id, spawnWorktreeId, get().panelsById[id]);
            // Recover the attach-during-spawn race: a fit that ran while the
            // spawn IPC was in flight had its PTY resize dropped (no terminal
            // existed yet), which would strand the CLI at the spawn dims while
            // xterm renders the fitted grid — the assistant's progressively
            // garbled prompt (#10863). Re-assert the live grid now that the PTY
            // exists. PTY-only and direct: xterm already shows these dims, and
            // sendPtyResize would defer 500ms for a settled-strategy agent —
            // exactly the window in which the CLI paints its banner at the
            // stale spawn width. The backend dedupes when nothing drifted.
            // Whatever a fit recorded as sent during the spawn never reached a
            // PTY; forget it so a pane that detached before this point still
            // re-asserts on its next fit.
            peekTerminalService()?.invalidatePtyGrid(id);
            const settledDims = getAttachedGridDims(id);
            if (settledDims && (settledDims.cols !== spawnCols || settledDims.rows !== spawnRows)) {
              terminalClient.resize(id, settledDims.cols, settledDims.rows);
            }
          }

          if (mountedPanel && waitForAttach && isPaneOnPage(id)) {
            try {
              const terminalService = peekTerminalService() ?? (await loadTerminalService());
              await terminalService.waitForAttachSettled(id, {
                timeoutMs: TERMINAL_STARTUP_ATTACH_TIMEOUT_MS,
              });
            } catch (error) {
              logWarn("[TerminalStore] Terminal did not attach before startup queue advanced", {
                id,
                error,
              });
            }
          }
          return mountedPanel;
        };

        // The answer was lost with the link, not refused: the host may well be
        // running the terminal, so the pane stays starting until the host says
        // whether it is. Followed outside the startup queue, so the launches
        // queued behind this one aren't held while the link is down.
        const followLostSpawnReply = (lostError: unknown): void => {
          logWarn("[TerminalStore] Spawn answer lost with the link; checking with the host", {
            id,
          });
          const settle = markSpawnUnconfirmed(id);
          const endCheck = useHostConnectionStore.getState().beginCheck();
          safeFireAndForget(
            (async () => {
              try {
                const found = await findSpawnOnHost(id);
                // A later launch under this id settles its own spawn.
                if (!agentLifecycleLedger.isCurrent(id, launchGeneration)) return;
                if (found.status === "absent") {
                  const host = useHostConnectionStore.getState();
                  const hostName = host.hostName ?? host.hostId ?? "The host";
                  failSpawn(
                    new Error(
                      `${hostName} didn't start this terminal before the connection dropped.`
                    ),
                    true
                  );
                  return;
                }
                if (!get().panelsById[id]) {
                  // Closed while it was being checked: end what the host
                  // started, and only then let resync see the id, so it can't
                  // adopt the terminal and bring the pane back. A kill the
                  // link loses is sent again once it is back, while no later
                  // launch has taken the id.
                  agentLifecycleLedger.recordSpawnResolved(id, launchGeneration, true);
                  for (;;) {
                    try {
                      await terminalClient.kill(id);
                      break;
                    } catch (killError) {
                      if (!isUnknownOutcomeError(killError)) {
                        logWarn(
                          "[TerminalStore] Compensating kill after a closed lost spawn failed",
                          {
                            id,
                            error: killError,
                          }
                        );
                        break;
                      }
                      await waitForHostConnected();
                      if (
                        !agentLifecycleLedger.isCurrent(id, launchGeneration) ||
                        get().panelsById[id]
                      ) {
                        break;
                      }
                    }
                  }
                  return;
                }
                const guessed = get().panelsById[id];
                takeHostAgentState(
                  id,
                  found.record,
                  get(),
                  {
                    setAgentState: (agentId, state) =>
                      peekTerminalService()?.setAgentState(agentId, state),
                  },
                  guessed !== undefined &&
                    isPtyPanel(guessed) &&
                    guessed.lastStateChange === lastStateChange
                );
                if (!(await completeSpawn(false))) return;
                const recovered = get().panelsById[id];
                if (!recovered || !isPtyPanel(recovered)) return;
                // The host has it, so an error reported while it was being asked
                // (its confirmation timing out) no longer stands.
                if (recovered.spawnError) get().clearSpawnError(id);
                if (found.record.hasPty === false) {
                  // Started, and the PTY already went while the link was down.
                  get().setRuntimeStatus(id, "exited");
                  if (recovered.launchAgentId && recovered.agentState !== "exited") {
                    peekTerminalService()?.setAgentState(id, "exited");
                    get().updateAgentState(id, "exited");
                  }
                }
                // Trashed while it was being checked, when the host had nothing
                // to trash yet.
                if (recovered.location === "trash") {
                  terminalClient.trash(id).catch((trashError: unknown) => {
                    logWarn("[TerminalStore] Couldn't trash a terminal found after a lost spawn", {
                      id,
                      error: trashError,
                    });
                  });
                }
                // A pane on a running PTY starts with only what it prints next;
                // what it drew while the link was down comes from the host.
                safeFireAndForget(fetchAndRestoreTerminal(id), {
                  context: "Restoring a terminal found after a lost spawn answer",
                });
              } catch (error) {
                logWarn("[TerminalStore] Couldn't check a lost spawn with the host", {
                  id,
                  error,
                });
                failSpawn(lostError);
              } finally {
                settle();
                endCheck();
              }
            })(),
            { context: "Checking a lost spawn answer with the host" }
          );
        };

        try {
          await terminalClient.spawn({
            id,
            projectId: capturedWorkspaceId,
            cwd: options.cwd,
            shell: options.shell,
            cols: spawnCols,
            rows: spawnRows,
            command: commandToExecute,
            kind,
            launchAgentId,
            pluginPanelKindId,
            // Read off the live panel, not the values captured before the
            // queue wait: a rename landing while the spawn was queued reaches
            // a pty-host that has no record yet and is dropped, so the spawn
            // itself has to carry it or it is lost (#11830).
            title: _p1.title,
            titleMode: _p1.titleMode,
            env: mergedEnv,
            restore: options.restore,
            spawnBatchId: options.spawnBatchId,
            spawnBatchSize: options.spawnBatchSize,
            agentLaunchFlags: options.agentLaunchFlags,
            agentModelId: options.agentModelId,
            // Off the live panel, which holds it paired with its source, so a
            // session captured when the agent ends names the run (#15977).
            scheduledRun: _p1.scheduledRun,
            // Known-at-launch session id (#11782) — either freshly minted and
            // assigned to the CLI, or the one this launch resumes. Recorded on
            // the terminal record at spawn so a kill path that never runs a
            // capture (force quit, crash, SIGKILL) can't lose the conversation.
            agentSessionId: options.agentSessionId,
            // Live, for the same reason as `title` above: a move landing while
            // the spawn was queued reaches a pty-host with no record yet and is
            // dropped, so the spawn itself has to carry the current filing.
            worktreeId: spawnWorktreeId,
            agentPresetId: options.agentPresetId,
            agentPresetColor: options.agentPresetColor,
            originalAgentPresetId: options.originalPresetId ?? options.agentPresetId,
            handbackCode: options.handbackCode,
            // A launch prompt or a carried record is the run's first prompt, so
            // main never offers a send as one (#15521).
            ...((options.launchPrompt || _p1.firstPrompt) && { hasFirstPrompt: true }),
            requiredPluginTools: options.requiredPluginTools,
            // Launch-time context the pane's MCP session replays through its
            // workspace binding (#12486): a caller may supply one, and a Claude
            // pane's is captured here for its own worktree.
            actionContext:
              options.actionContext ??
              buildAgentLaunchContext({
                launchAgentId,
                terminalId: id,
                title: _p1.title,
                worktreeId: spawnWorktreeId,
              }),
          });
        } catch (error) {
          // The assistant's own terminal is never on the host's reconnect
          // probe, so asking could only ever answer "absent"; its lane checks
          // for itself (HelpSessionController).
          if (!isLostSpawnReply(error) || location === "overlay") throw error;
          followLostSpawnReply(error);
          return;
        }

        markRendererPerformance("agentlaunch.spawn-ipc-resolved", { id });
        settleControl();
        await completeSpawn(shouldWaitForVisibleAttach);
      } catch (error) {
        // Refused because another screen has control: the launch waits for
        // control rather than failing. A refusal while this view still reads
        // as driving, from the same lease it spawned under, fails as before:
        // nothing on screen would explain the wait. Control that arrived
        // while the refusal travelled gets one more attempt at once.
        if (
          holdsForDriveLease &&
          isClientAppError(error) &&
          error.code === "DRIVEN_ELSEWHERE" &&
          capturedWorkspaceId &&
          isStillStarting()
        ) {
          const lease = getDriveLeaseSnapshot();
          if (!drivesProject(lease, capturedWorkspaceId)) {
            waitForControl(capturedWorkspaceId);
            return;
          }
          if (lease !== leaseAtSpawn) {
            // Marked until the retry has its answer, as a released launch is.
            handedOn = true;
            markPanelDriveLeaseLaunch(id);
            terminalStartupQueue.requeue(() => startPty(launchAnyway, false, true));
            return;
          }
        }
        logError("[TerminalStore] Failed to spawn terminal", error);
        failSpawn(error);
      } finally {
        settleControl();
      }
    },
    options.spawnBatchId && (options.spawnBatchSize ?? 0) > 1
      ? RECIPE_TERMINAL_STARTUP_CONCURRENCY
      : 1
  );
}
