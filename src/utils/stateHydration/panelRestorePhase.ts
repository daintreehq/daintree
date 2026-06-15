import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { getPanelKindConfig, panelKindHasPty } from "@shared/config/panelKindRegistry";
import { isSmokeTestTerminalId } from "@shared/utils/smokeTestTerminals";
import { logWarn } from "@/utils/logger";
import type {
  TerminalState,
  BackendTerminalInfo,
  TerminalReconnectResult,
} from "@shared/types/ipc/terminal";
import type { AgentSettings } from "@shared/types/agentSettings";
import type { WorktreeState } from "@shared/types";
import type { AgentPreset } from "@/config/agents";
import type { ResourceProfile } from "@shared/types/resourceProfile";
import { type TerminalRestoreTask, getRestoreBatchParams, delay } from "./batchScheduler";
import { reconnectWithTimeout } from "./reconnectManager";
import {
  inferKind,
  resolveAgentId,
  buildArgsForBackendTerminal,
  buildArgsForReconnectedFallback,
  buildArgsForRespawn,
  buildArgsForNonPtyRecreation,
  buildArgsForOrphanedTerminal,
  inferWorktreeIdFromCwd,
} from "./statePatcher";
import type { HydrationOptions } from "./";

type AddPanelFn = HydrationOptions["addPanel"];
type RestoreTerminalOrderFn = NonNullable<HydrationOptions["restoreTerminalOrder"]>;

export interface PanelRestoreContext {
  addPanel: AddPanelFn;
  withHydrationBatch: (run: () => Promise<void>) => Promise<void>;
  backendTerminalMap: Map<string, BackendTerminalInfo>;
  /**
   * Bulk-prefetched `terminal:reconnect` probe results keyed by saved panel id
   * (#10390). When a saved id is present here, `reconnectWithTimeout` consumes
   * the prefetched result instead of firing a per-panel IPC inside the
   * serialized spawn queue. Absent ids fall back to the individual probe.
   */
  prefetchedReconnectResults?: Record<string, TerminalReconnectResult>;
  terminalSizes: Record<string, { cols: number; rows: number }>;
  activeWorktreeId: string | null;
  projectRoot: string;
  agentSettings: AgentSettings | undefined;
  clipboardDirectory: string | undefined;
  projectPresetsByAgent: Record<string, AgentPreset[]>;
  worktreesPromise: Promise<WorktreeState[] | null>;
  restoreTerminalOrder?: RestoreTerminalOrderFn;
  safeMode: boolean;
  /**
   * Saved id of the panel the user last had on screen (the head of the
   * per-project MRU list, see #10527). A matching PTY panel jumps to the front
   * of the restore queue ahead of the active-worktree priority tier, so the
   * terminal the user was actually looking at reconnects first instead of
   * waiting behind background batches. `undefined` (no MRU, or a non-terminal
   * MRU head) degrades cleanly to the existing worktree/recency ordering.
   */
  visiblePanelId?: string;
  /**
   * Active resource profile, read once by the caller (#10528). Scales the
   * staggered PTY restore batch size and inter-batch delay via
   * `getRestoreBatchParams` so capable machines restore faster. Defaults to
   * `balanced` when omitted.
   */
  resourceProfile?: ResourceProfile;
  logHydrationInfo: (message: string, context?: Record<string, unknown>) => void;
}

interface PanelRestoreTaskEntry {
  priority: number;
  isPty: boolean;
  execute: () => Promise<void>;
}

export interface PanelRestorePhaseResult {
  restoreTasks: TerminalRestoreTask[];
  /**
   * Sparse map of saved panel id → restored panel id, populated only for
   * panels whose restored id differs from their saved id (e.g. a PTY panel
   * whose reconnect timed out and was respawned with a freshly generated id,
   * see #10440). Consumers that reference saved ids — notably tab-group
   * hydration — must remap through this before validating against live ids,
   * or the membership is silently filtered out and the group destroyed.
   * Empty when every panel restored under its original saved id.
   */
  savedIdToRestoredId: Map<string, string>;
}

/**
 * Restore saved panels (3-phase executor: non-PTY concurrent, priority PTY
 * sequential, background PTY staggered) and append orphan backend terminals.
 *
 * Load-bearing constraints (see #4911, #4945, #5087):
 *  - `backendTerminalMap` is mutated by reference; orphan detection depends
 *    on the surviving entries after the saved-panels loop.
 */
export async function restorePanelsPhase(
  savedPanels: TerminalState[] | undefined,
  ctx: PanelRestoreContext
): Promise<PanelRestorePhaseResult> {
  const {
    addPanel,
    withHydrationBatch,
    backendTerminalMap,
    prefetchedReconnectResults,
    terminalSizes,
    activeWorktreeId,
    projectRoot,
    agentSettings,
    clipboardDirectory,
    projectPresetsByAgent,
    worktreesPromise,
    restoreTerminalOrder,
    safeMode,
    visiblePanelId,
    resourceProfile,
    logHydrationInfo,
  } = ctx;

  const restoreTasks: TerminalRestoreTask[] = [];
  const savedIdToRestoredId = new Map<string, string>();
  // Adaptive staggered-restore params scaled to the machine's resource
  // profile (#10528). One source of truth for both the background and orphan
  // PTY phases below.
  const { batchSize: restoreBatchSize, delayMs: restoreBatchDelayMs } =
    getRestoreBatchParams(resourceProfile);

  if (savedPanels && savedPanels.length > 0) {
    // Build a single-pass map of worktreeId → highest lastActiveAt across saved
    // panels. The restore predicate uses this to promote each non-active
    // worktree's most-recently-focused panel to the priority sequential tier,
    // matching browser tab-restore behavior. Panels without a worktreeId are
    // excluded — they never participate in per-worktree promotion. Old
    // snapshots (no lastActiveAt stamp) leave a worktree with no entry in the
    // map, which short-circuits promotion below via `!== undefined`.
    // `Number.isFinite` rejects NaN and ±Infinity so corrupted persisted
    // values never seed the map with values that would silently mis-promote.
    const maxLastActiveAtByWorktree = new Map<string, number>();
    for (const saved of savedPanels) {
      if (saved === undefined) continue;
      if (saved.worktreeId === undefined) continue;
      if (!Number.isFinite(saved.lastActiveAt) || (saved.lastActiveAt ?? 0) <= 0) continue;
      const ts = saved.lastActiveAt as number;
      const current = maxLastActiveAtByWorktree.get(saved.worktreeId);
      if (current === undefined || ts > current) {
        maxLastActiveAtByWorktree.set(saved.worktreeId, ts);
      }
    }

    const panelTasks: PanelRestoreTaskEntry[] = [];
    const restoredIdsByIndex = new Map<number, string>();

    for (let savedIndex = 0; savedIndex < savedPanels.length; savedIndex++) {
      const saved = savedPanels[savedIndex];
      if (saved === undefined) continue;
      if (isSmokeTestTerminalId(saved.id)) {
        logHydrationInfo(`Skipping smoke test terminal snapshot: ${saved.id}`);
        continue;
      }

      const savedWorktreeId = saved.worktreeId ?? null;
      const isActiveWorktree = savedWorktreeId === activeWorktreeId;
      // A non-active worktree's last-focused panel earns priority restore so
      // each worktree's last active panel reactivates quickly on return.
      const isMostRecentInOtherWorktree =
        !isActiveWorktree &&
        saved.worktreeId !== undefined &&
        Number.isFinite(saved.lastActiveAt) &&
        (saved.lastActiveAt ?? 0) > 0 &&
        saved.lastActiveAt === maxLastActiveAtByWorktree.get(saved.worktreeId);

      // Determine isPty at task-build time so we can partition tasks
      // for concurrent (non-PTY) vs staggered (PTY) execution.
      const backendTerminal = backendTerminalMap.get(saved.id);
      let taskIsPty: boolean;
      if (backendTerminal) {
        taskIsPty = true;
      } else {
        const inferredKind = inferKind(saved);
        taskIsPty = inferredKind === "assistant" ? false : panelKindHasPty(inferredKind);
      }

      // The panel the user last had on screen (per-project MRU head, #10527)
      // jumps to a dedicated priority `-1` tier ahead of the active-worktree
      // queue, so the terminal they were actually looking at reconnects first.
      // Gated on `taskIsPty`: the `-1` tier only reorders PTY spawning, so a
      // visible non-PTY panel stays on the concurrent non-PTY path.
      const isVisible = taskIsPty && visiblePanelId !== undefined && saved.id === visiblePanelId;
      const priority = isVisible ? -1 : isActiveWorktree || isMostRecentInOtherWorktree ? 0 : 1;

      const capturedIndex = savedIndex;
      panelTasks.push({
        priority,
        isPty: taskIsPty,
        execute: async () => {
          if (backendTerminal) {
            // Skip dead agent backend terminals — they create phantom idle panels.
            const isDeadAgentBackend =
              backendTerminal.hasPty === false &&
              resolveAgentId(backendTerminal.launchAgentId) !== undefined;
            if (isDeadAgentBackend) {
              logHydrationInfo(`Skipping dead agent backend terminal: ${backendTerminal.id}`);
              backendTerminalMap.delete(saved.id);
              return;
            }

            logHydrationInfo(`Reconnecting to terminal: ${saved.id}`);

            const args = buildArgsForBackendTerminal(backendTerminal, saved, projectRoot || "");
            // Assign to active worktree if terminal has no worktreeId
            if (!args.worktreeId && activeWorktreeId) {
              args.worktreeId = activeWorktreeId;
            }
            const location = args.location as "grid" | "dock";

            logHydrationInfo(`[HYDRATION] Adding terminal from backend:`, {
              id: backendTerminal.id,
              kind: args.kind,
              launchAgentId: args.launchAgentId,
              location,
              worktreeId: args.worktreeId,
              title: backendTerminal.title,
            });

            const restoredTerminalId = await addPanel(args);
            restoredIdsByIndex.set(capturedIndex, restoredTerminalId);

            if (backendTerminal.activityTier) {
              terminalInstanceService.initializeBackendTier(
                restoredTerminalId,
                backendTerminal.activityTier
              );
            }

            if (terminalSizes && typeof terminalSizes === "object") {
              const savedSize = terminalSizes[restoredTerminalId];
              if (
                savedSize &&
                Number.isFinite(savedSize.cols) &&
                Number.isFinite(savedSize.rows) &&
                savedSize.cols > 0 &&
                savedSize.rows > 0
              ) {
                terminalInstanceService.setTargetSize(
                  restoredTerminalId,
                  savedSize.cols,
                  savedSize.rows
                );
              }
            }

            restoreTasks.push({
              terminalId: restoredTerminalId,
              label: saved.id,
              worktreeId: args.worktreeId,
              location,
            });

            backendTerminalMap.delete(saved.id);
          } else {
            const kind = inferKind(saved);

            if (kind === "assistant") {
              logHydrationInfo(`Skipping legacy assistant panel: ${saved.id}`);
              return;
            }

            const location = (saved.location === "dock" ? "dock" : "grid") as "grid" | "dock";

            if (panelKindHasPty(kind)) {
              const reconnectOutcome = await reconnectWithTimeout(
                saved.id,
                logHydrationInfo,
                prefetchedReconnectResults?.[saved.id]
              );
              const reconnectTimedOut = reconnectOutcome.status === "timeout";
              const reconnectedTerminal =
                reconnectOutcome.status === "found" ? reconnectOutcome.terminal : null;

              if (reconnectedTerminal) {
                const reconnectArgs = buildArgsForReconnectedFallback(
                  reconnectedTerminal,
                  saved,
                  projectRoot || ""
                );
                // Assign to active worktree when a legacy saved panel has
                // no worktreeId (mirrors the matched-backend path).
                if (!reconnectArgs.worktreeId && activeWorktreeId) {
                  reconnectArgs.worktreeId = activeWorktreeId;
                }
                const restoredTerminalId = await addPanel(reconnectArgs);
                restoredIdsByIndex.set(capturedIndex, restoredTerminalId);

                if (reconnectedTerminal.activityTier) {
                  terminalInstanceService.initializeBackendTier(
                    restoredTerminalId,
                    reconnectedTerminal.activityTier
                  );
                }

                if (terminalSizes && typeof terminalSizes === "object") {
                  const savedSize = terminalSizes[restoredTerminalId];
                  if (
                    savedSize &&
                    Number.isFinite(savedSize.cols) &&
                    Number.isFinite(savedSize.rows) &&
                    savedSize.cols > 0 &&
                    savedSize.rows > 0
                  ) {
                    terminalInstanceService.setTargetSize(
                      restoredTerminalId,
                      savedSize.cols,
                      savedSize.rows
                    );
                  }
                }

                restoreTasks.push({
                  terminalId: restoredTerminalId,
                  label: saved.id,
                  worktreeId: reconnectArgs.worktreeId,
                  location,
                });
              } else {
                // not_found on cold app restart means the PTY process was killed
                // on quit and needs to be respawned.
                const respawnArgs = buildArgsForRespawn(
                  saved,
                  kind,
                  projectRoot || "",
                  agentSettings,
                  reconnectTimedOut,
                  clipboardDirectory,
                  projectPresetsByAgent
                );

                // Assign to active worktree if the saved terminal has no worktreeId
                if (!respawnArgs.worktreeId && activeWorktreeId) {
                  respawnArgs.worktreeId = activeWorktreeId;
                }

                logHydrationInfo(
                  `Respawning PTY panel: ${saved.id} (${respawnArgs.launchAgentId ? "agent" : "terminal"})`
                );

                logHydrationInfo(`[HYDRATION-RESPAWN] Adding terminal:`, {
                  id: saved.id,
                  kind: respawnArgs.kind,
                  launchAgentId: respawnArgs.launchAgentId,
                  location: respawnArgs.location,
                  savedLocation: saved.location,
                  worktreeId: saved.worktreeId,
                  title: saved.title,
                });

                const restoredTerminalId = await addPanel(respawnArgs);
                restoredIdsByIndex.set(capturedIndex, restoredTerminalId);

                if (terminalSizes && typeof terminalSizes === "object") {
                  const savedSize = terminalSizes[saved.id] || terminalSizes[restoredTerminalId];
                  if (
                    savedSize &&
                    Number.isFinite(savedSize.cols) &&
                    Number.isFinite(savedSize.rows) &&
                    savedSize.cols > 0 &&
                    savedSize.rows > 0
                  ) {
                    terminalInstanceService.setTargetSize(
                      restoredTerminalId,
                      savedSize.cols,
                      savedSize.rows
                    );
                  }
                }
              }
            } else {
              // Unregistered kind. Restore when the panel carries a
              // pluginId (current-format plugin panel) OR the kind string
              // contains a dot (legacy pre-#5580 plugin panel whose kind
              // was persisted as "${manifest.name}.${panel.id}" without a
              // pluginId field). Both cases let the renderer surface a
              // PluginMissingPanel placeholder (#5580) instead of silently
              // dropping the panel. Non-dotted unregistered kinds (e.g.
              // the "notes" built-in removed in #5616) are still skipped
              // to avoid "Unknown Panel Type" ghosts.
              if (!getPanelKindConfig(kind) && !saved.pluginId && !kind.includes(".")) {
                logHydrationInfo(
                  `Skipping persisted panel with unregistered kind: ${saved.id} (${kind})`
                );
                return;
              }
              logHydrationInfo(`Recreating ${kind} panel: ${saved.id}`);
              const nonPtyId = await addPanel(
                buildArgsForNonPtyRecreation(saved, kind, projectRoot || "")
              );
              restoredIdsByIndex.set(capturedIndex, nonPtyId);
            }
          }
        },
      });
    }

    // Execute panel restore tasks: non-PTY panels run concurrently (they only
    // do synchronous Zustand mutations with no IPC), then PTY panels restore
    // with priority ordering and staggered batching to throttle process spawning.
    const nonPtyTasks = panelTasks.filter((t) => !t.isPty);
    const ptyVisibleTasks = panelTasks.filter((t) => t.isPty && t.priority === -1);
    const ptyPriorityTasks = panelTasks.filter((t) => t.isPty && t.priority === 0);
    const ptyBackgroundTasks = panelTasks.filter((t) => t.isPty && t.priority === 1);

    // Restore all non-PTY panels concurrently (browser, dev-preview).
    // These only perform synchronous store mutations, so no throttling is needed.
    // The begin/flush wrapper collapses the N addPanel mutations into one store
    // commit, reducing this phase from N re-renders to 1.
    if (nonPtyTasks.length > 0) {
      logHydrationInfo(`Restoring ${nonPtyTasks.length} non-PTY panel(s) concurrently`);
      await withHydrationBatch(async () => {
        await Promise.allSettled(
          nonPtyTasks.map(async (task) => {
            try {
              await task.execute();
            } catch (error) {
              logWarn("Failed to restore non-PTY panel", { error });
            }
          })
        );
      });
    }

    // Restore the visible panel first (#10527). The terminal the user last had
    // on screen reconnects ahead of the active-worktree tier so it is
    // interactive the instant the grid paints, instead of waiting behind
    // background batches. At most one task here (a single MRU head), but
    // filtered like the others to stay robust; batched to match the rest.
    if (ptyVisibleTasks.length > 0) {
      await withHydrationBatch(async () => {
        for (const task of ptyVisibleTasks) {
          try {
            await task.execute();
          } catch (error) {
            logWarn("Failed to restore visible panel", { error });
          }
        }
      });
    }

    // Restore priority PTY panels in parallel (active worktree + each other
    // worktree's last-focused panel, for instant interactivity). The main
    // process serializes the spawn IPC anyway, so firing them concurrently
    // only removes the renderer-side sequential `await` latency ((N-1)×RTT)
    // without adding OS-level spawn pressure (#10528). The single
    // `withHydrationBatch` wrapper collapses all N addPanel mutations into one
    // store commit; a rejection in one task never blocks the others.
    if (ptyPriorityTasks.length > 0) {
      await withHydrationBatch(async () => {
        await Promise.allSettled(
          ptyPriorityTasks.map(async (task) => {
            try {
              await task.execute();
            } catch (error) {
              logWarn("Failed to restore priority panel", { error });
            }
          })
        );
      });
    }

    // Restore background PTY panels in staggered batches. Each batch is its own
    // hydration batch: we still want staggered spawning to throttle PTY pressure,
    // but within a batch the N panels commit in one render rather than N.
    // N background panels -> ceil(N / restoreBatchSize) renders instead of N.
    if (ptyBackgroundTasks.length > 0) {
      logHydrationInfo(
        `Staggering ${ptyBackgroundTasks.length} background PTY panel(s) in batches of ${restoreBatchSize}`
      );
      for (let i = 0; i < ptyBackgroundTasks.length; i += restoreBatchSize) {
        const batch = ptyBackgroundTasks.slice(i, i + restoreBatchSize);
        await withHydrationBatch(async () => {
          await Promise.allSettled(
            batch.map(async (task) => {
              try {
                await task.execute();
              } catch (error) {
                logWarn("Failed to restore background panel", { error });
              }
            })
          );
        });
        if (i + restoreBatchSize < ptyBackgroundTasks.length) {
          await delay(restoreBatchDelayMs);
        }
      }
    }

    // Restore saved panel order. The three-phase restore (non-PTY first, then
    // priority PTY, then background PTY) means panels end up in execution order
    // rather than saved order. Sort them back to match the saved state.
    if (restoreTerminalOrder && restoredIdsByIndex.size > 0) {
      const orderedIds = Array.from(restoredIdsByIndex.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([, id]) => id);
      restoreTerminalOrder(orderedIds);
    }

    // Build the saved→restored id remap (#10440). Only panels whose restored
    // id diverged from the saved id need an entry; identity mappings (the
    // common clean-reconnect case) are skipped so downstream consumers can
    // fast-path on an empty map.
    for (const [index, restoredId] of restoredIdsByIndex.entries()) {
      const savedId = savedPanels[index]?.id;
      if (savedId !== undefined && savedId !== restoredId) {
        savedIdToRestoredId.set(savedId, restoredId);
      }
    }
  }

  // Restore any orphaned backend terminals not in saved state (append at end).
  // When no panels were saved (brand-new project), skip the startup "default"
  // terminal — it belongs to the previous project's bootstrap sequence, not this one.
  // In safe mode, skip orphan reconnection entirely to ensure a clean slate.
  const hasSavedPanels = Boolean(savedPanels && savedPanels.length > 0);
  const orphanedTerminals = safeMode
    ? []
    : Array.from(backendTerminalMap.values()).filter(
        (t) => !(t.id.startsWith("default-") && !hasSavedPanels) && t.hasPty !== false
      );
  if (orphanedTerminals.length > 0) {
    logHydrationInfo(
      `${orphanedTerminals.length} orphaned terminal(s) not in saved order, appending at end`
    );

    // Resolve worktreeId for orphaned terminals by matching the terminal's
    // cwd against known worktree paths (longest-prefix wins). worktreesPromise
    // is awaited once; if it resolves to null or hasn't loaded, orphans fall
    // back to activeWorktreeId so they still appear in the grid.
    const worktreesForInfer = await worktreesPromise;

    const restoreOrphan = async (terminal: (typeof orphanedTerminals)[number]): Promise<void> => {
      try {
        logHydrationInfo(`Reconnecting to orphaned terminal: ${terminal.id}`);

        const orphanArgs = buildArgsForOrphanedTerminal(terminal, projectRoot || "");
        // Orphaned backend terminals no longer carry worktreeId — infer it
        // from cwd against the loaded worktrees, then fall back to the
        // active worktree so the panel still appears in the grid filter.
        const inferred = inferWorktreeIdFromCwd(terminal.cwd, worktreesForInfer ?? undefined);
        if (inferred) {
          orphanArgs.worktreeId = inferred;
        } else if (activeWorktreeId) {
          orphanArgs.worktreeId = activeWorktreeId;
        }
        const restoredTerminalId = await addPanel(orphanArgs);

        if (terminal.activityTier) {
          terminalInstanceService.initializeBackendTier(restoredTerminalId, terminal.activityTier);
        }

        if (terminalSizes && typeof terminalSizes === "object") {
          const savedSize = terminalSizes[restoredTerminalId];
          if (
            savedSize &&
            Number.isFinite(savedSize.cols) &&
            Number.isFinite(savedSize.rows) &&
            savedSize.cols > 0 &&
            savedSize.rows > 0
          ) {
            terminalInstanceService.setTargetSize(
              restoredTerminalId,
              savedSize.cols,
              savedSize.rows
            );
          }
        }

        restoreTasks.push({
          terminalId: restoredTerminalId,
          label: terminal.id,
          worktreeId: orphanArgs.worktreeId,
          location: "grid",
        });
      } catch (error) {
        logWarn(`Failed to reconnect to orphaned terminal ${terminal.id}`, { error });
      }
    };

    // Same staggered-batch pattern as the background PTY phase: one hydration
    // batch per spawn batch so orphan restores commit once per batch rather
    // than once per terminal.
    for (let i = 0; i < orphanedTerminals.length; i += restoreBatchSize) {
      const batch = orphanedTerminals.slice(i, i + restoreBatchSize);
      await withHydrationBatch(async () => {
        await Promise.allSettled(batch.map(restoreOrphan));
      });
      if (i + restoreBatchSize < orphanedTerminals.length) {
        await delay(restoreBatchDelayMs);
      }
    }
  }

  return { restoreTasks, savedIdToRestoredId };
}
