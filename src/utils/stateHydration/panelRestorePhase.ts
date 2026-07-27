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
  buildWorktreeMoveContext,
  resolveWorktreeMovePatch,
  type WorktreeMoveContext,
} from "./worktreeMoveRemap";
import { rebaseAbsolutePath } from "@shared/utils/projectPathRelocation";
import {
  inferKind,
  resolveAgentId,
  buildArgsForBackendTerminal,
  buildArgsForReconnectedFallback,
  buildArgsForRespawn,
  buildArgsForNonPtyRecreation,
  buildArgsForOrphanedTerminal,
  inferWorktreeIdFromCwd,
  resolveRespawnAgentId,
} from "./statePatcher";
import { buildResumeLatestCommand } from "@shared/types/agentSettings";
import { normalize as normalizePath } from "@shared/utils/path";
import type { HydrationOptions } from "./";
import { getAgentConfig } from "@/config/agents";
import {
  getCurrentLaunchCliDetail,
  resolveAgentLaunchBaseCommand,
} from "@/utils/agentLaunchCommand";

type AddPanelFn = HydrationOptions["addPanel"];
type RestoreTerminalOrderFn = NonNullable<HydrationOptions["restoreTerminalOrder"]>;

/**
 * Rebase a restore arg's `cwd` from a moved worktree's old root to its new one.
 * No-op when the panel's worktree didn't move or the arg carries no cwd. Used on
 * the surviving-PTY paths, whose cwd comes from the live backend record (the old
 * path) rather than the already-rebased `saved.cwd` (#11388).
 */
/**
 * Scope key component for the resume-latest election: the directory a pane will
 * launch in, normalized lexically so two spellings of one directory share a slot.
 * Deliberately not realpath'd — the election must stay synchronous and the path
 * may no longer exist, so symlink aliases remain separate scopes.
 */
function resumeLatestScopeCwd(cwd: string): string {
  const normalized = normalizePath(cwd).normalize("NFC");
  // Windows paths are case-insensitive; fold so `C:/Repo` and `c:/repo` collide.
  return /^([A-Za-z]:\/|\/\/)/.test(normalized) ? normalized.toLowerCase() : normalized;
}

/**
 * Ids of panes that must NOT use their agent's resume-latest fallback because a
 * sibling pane in the same (agent, cwd) scope already owns that scope's single
 * slot (#11461). Highest valid `lastActiveAt` wins and ties keep the earlier
 * saved entry, so the outcome is deterministic and independent of restore order.
 *
 * Only panes that could actually reach the fallback are candidates: an id-less
 * agent pane, of an agent that declares resume-latest args, with no surviving
 * backend PTY — a live PTY reconnects instead of respawning, so letting one win a
 * slot would strand its genuinely-respawning siblings on fresh launches.
 *
 * Scopes with a single candidate are omitted entirely, so the common one-pane
 * case keeps its existing behavior by construction.
 */
function electSuppressedResumeLatestIds(
  panels: readonly (TerminalState | undefined)[],
  context: { projectRoot: string; backendTerminalMap: Map<string, BackendTerminalInfo> }
): Set<string> {
  const winnerByScope = new Map<string, { id: string; lastActiveAt: number }>();
  const candidateIdsByScope = new Map<string, string[]>();

  for (const saved of panels) {
    if (saved === undefined) continue;
    if (isSmokeTestTerminalId(saved.id)) continue;
    // An exact per-pane session id resumes precisely and never consumes a slot.
    if (saved.agentSessionId) continue;
    if (context.backendTerminalMap.has(saved.id)) continue;
    const kind = inferKind(saved);
    if (kind === "assistant" || !panelKindHasPty(kind)) continue;
    const agentId = resolveRespawnAgentId(saved, kind);
    if (agentId === undefined) continue;
    // Probe capability through the very builder the respawn branch calls, so
    // eligibility can't drift from behavior (covers custom/plugin agents too).
    if (buildResumeLatestCommand(agentId) === undefined) continue;

    // NUL-joined: neither an agent id nor a path can contain it, so the key can
    // never be forged by an unusual path or a future custom agent id.
    const scope = `${agentId}\u0000${resumeLatestScopeCwd(saved.cwd || context.projectRoot)}`;
    const existingIds = candidateIdsByScope.get(scope);
    if (existingIds === undefined) {
      candidateIdsByScope.set(scope, [saved.id]);
    } else {
      existingIds.push(saved.id);
    }

    const lastActiveAt =
      Number.isFinite(saved.lastActiveAt) && (saved.lastActiveAt ?? 0) > 0
        ? (saved.lastActiveAt as number)
        : 0;
    const currentWinner = winnerByScope.get(scope);
    if (currentWinner === undefined || lastActiveAt > currentWinner.lastActiveAt) {
      winnerByScope.set(scope, { id: saved.id, lastActiveAt });
    }
  }

  const suppressed = new Set<string>();
  for (const [scope, ids] of candidateIdsByScope) {
    if (ids.length < 2) continue;
    const winnerId = winnerByScope.get(scope)?.id;
    for (const id of ids) {
      if (id !== winnerId) suppressed.add(id);
    }
  }
  return suppressed;
}

function rebaseMovedArgsCwd(
  args: { cwd?: string },
  move: { oldRoot: string; newRoot: string } | undefined
): void {
  if (move === undefined || typeof args.cwd !== "string") return;
  args.cwd = rebaseAbsolutePath(args.cwd, move.oldRoot, move.newRoot);
}

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

  // A panel can outlive its worktree (#11232): deleting a worktree leaves its
  // terminals running, and the sidebar row that holds them is in-memory only.
  // So a saved panel may point at a worktree that no longer exists, and both
  // the grid and the dock filter by the active worktree — restoring it as-is
  // would leave a live PTY on screen nowhere, unreachable even to close.
  // Re-home those to the active worktree instead.
  //
  // The id set is derived once and awaited at each use. `worktreesPromise` is
  // already in flight (the orphan phase below awaits the same one), so this
  // costs a microtask per panel once resolved — and unlike sampling a variable
  // the loader may not have filled yet, it cannot silently skip the re-home.
  //
  // An empty list counts as unknown, not as "every worktree is gone" (#11234).
  // Hydration races backend init by design, and `worktree.getAll()` answers []
  // while the window's workspace host is still registering. A successful git
  // enumeration never yields zero — `git worktree list` always reports the main
  // worktree — so [] only ever means "not ready", never a real count. Treating
  // it as authoritative re-homed every panel to the active worktree, and the
  // save loop then persisted that, compounding across restarts.
  // A single memoized correlation context off the in-flight worktree list,
  // shared by the known-id guard and the worktree-move remap below (#11388).
  let worktreeMoveContextPromise: Promise<WorktreeMoveContext | null> | null = null;
  const getWorktreeMoveContext = (): Promise<WorktreeMoveContext | null> => {
    worktreeMoveContextPromise ??= worktreesPromise.then((list) => buildWorktreeMoveContext(list));
    return worktreeMoveContextPromise;
  };
  const getKnownWorktreeIds = async (): Promise<Set<string> | null> => {
    const ctx = await getWorktreeMoveContext();
    return ctx?.knownIds ?? null;
  };
  const resolveRestoredWorktreeId = async (
    worktreeId: string | undefined
  ): Promise<string | undefined> => {
    const known = await getKnownWorktreeIds();
    // Only re-home onto the active worktree when it is itself live. With a
    // complete, authoritative list (#11387) an activeWorktreeId absent from
    // `known` is a deleted/stale selection, so re-homing onto it would strand
    // the panel on a dead worktree — worse than keeping the saved id, which the
    // boot's own active-selection fallback (index.ts) repairs on this and the
    // next boot. When the list is unknown (null) there is nothing to validate
    // against, so preserve the prior behavior of trusting activeWorktreeId
    // (#11234). This closes PR #11235's own unaddressed follow-up.
    const rehomeTarget =
      activeWorktreeId !== null && (known === null || known.has(activeWorktreeId))
        ? activeWorktreeId
        : undefined;
    // No saved worktree (undefined, or a corrupt empty string): fall to the
    // validated active worktree, or leave it unset rather than guess onto a
    // dead id — never echo back the falsy saved value.
    if (!worktreeId) return rehomeTarget;
    // With no worktree list there is nothing to check the id against, so
    // re-homing would be a guess — keep what was saved.
    if (known === null || known.has(worktreeId)) return worktreeId;
    return rehomeTarget ?? worktreeId;
  };

  if (savedPanels && savedPanels.length > 0) {
    // #11388: a worktree move (`git worktree move` or an external relocation)
    // changes its path-derived id while its stable `.git/worktrees/<name>`
    // handle is preserved. Remap panels whose worktree moved — matched via the
    // gitDir persisted with each panel — to the worktree's new id (rebasing
    // cwd/filePath) BEFORE anything keys off saved.worktreeId, so a moved
    // worktree's panels stay put instead of being treated as deleted. Legacy
    // snapshots without a stored gitDir, and genuinely-deleted worktrees, are
    // left untouched here and handled by resolveRestoredWorktreeId's re-home
    // below. The context is null when the list isn't ready (#11234), so this is
    // a no-op in that race — identical to the pre-#11388 behavior.
    // Skip the correlation — and its worktree-list await — entirely when no
    // saved panel even carries a gitDir handle. Legacy snapshots and
    // browser-only sessions then restore without waiting on worktree
    // enumeration, preserving the pre-#11388 time-to-first-panel.
    const anyMoveCandidate = savedPanels.some(
      (saved) =>
        saved !== undefined && saved.worktreeId !== undefined && saved.worktreeGitDir !== undefined
    );
    const moveContext = anyMoveCandidate ? await getWorktreeMoveContext() : null;
    // old→new root per remapped panel, so the surviving-PTY paths below (which
    // take cwd from the live backend record, not saved.cwd) can rebase it too.
    const movedRootsById = new Map<string, { oldRoot: string; newRoot: string }>();
    const panels = moveContext
      ? savedPanels.map((saved) => {
          if (saved === undefined) return saved;
          const patch = resolveWorktreeMovePatch(saved, moveContext);
          if (!patch) return saved;
          if (saved.worktreeId !== undefined) {
            movedRootsById.set(saved.id, { oldRoot: saved.worktreeId, newRoot: patch.worktreeId });
          }
          return { ...saved, ...patch };
        })
      : savedPanels;

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
    for (const saved of panels) {
      if (saved === undefined) continue;
      if (saved.worktreeId === undefined) continue;
      if (!Number.isFinite(saved.lastActiveAt) || (saved.lastActiveAt ?? 0) <= 0) continue;
      const ts = saved.lastActiveAt as number;
      const current = maxLastActiveAtByWorktree.get(saved.worktreeId);
      if (current === undefined || ts > current) {
        maxLastActiveAtByWorktree.set(saved.worktreeId, ts);
      }
    }

    // Elect at most one pane per (agent, cwd) to use the agent's resume-latest
    // fallback. That fallback resolves to the most recent session in scope
    // (`codex resume --last`, `claude --continue`), so N id-less panes sharing a
    // directory would every one of them reopen the SAME conversation (#11461).
    // Computed synchronously over static saved fields before any task executes:
    // same-tier tasks run concurrently via Promise.allSettled, so a check-and-claim
    // inside the closures would race (the hazard already fixed once for restart,
    // #11052). Only the losers are recorded, so a lone candidate — the common
    // single-pane case — is never suppressed.
    const resumeLatestSuppressedIds = electSuppressedResumeLatestIds(panels, {
      projectRoot: projectRoot || "",
      backendTerminalMap,
    });

    const panelTasks: PanelRestoreTaskEntry[] = [];
    const restoredIdsByIndex = new Map<number, string>();

    for (let savedIndex = 0; savedIndex < panels.length; savedIndex++) {
      const saved = panels[savedIndex];
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
            // Assign to the active worktree when the terminal has no worktree,
            // or names one that no longer exists.
            args.worktreeId = await resolveRestoredWorktreeId(args.worktreeId);
            // A surviving backend PTY reports its live (old-path) cwd; rebase it
            // onto the moved worktree's new root so persisted state and a later
            // respawn don't reference the vanished path (#11388).
            rebaseMovedArgsCwd(args, movedRootsById.get(saved.id));
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
                // Assign to the active worktree when a legacy saved panel has
                // no worktreeId, or names a deleted one (mirrors the
                // matched-backend path).
                reconnectArgs.worktreeId = await resolveRestoredWorktreeId(
                  reconnectArgs.worktreeId
                );
                // Rebase the reconnected PTY's live (old-path) cwd onto the
                // moved worktree's new root, like the matched-backend path.
                rebaseMovedArgsCwd(reconnectArgs, movedRootsById.get(saved.id));
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
                const savedAgentId = resolveAgentId(saved.launchAgentId);
                const resolvedAgentBaseCommand = savedAgentId
                  ? resolveAgentLaunchBaseCommand(
                      getAgentConfig(savedAgentId)?.command ?? savedAgentId,
                      await getCurrentLaunchCliDetail(savedAgentId)
                    )
                  : undefined;
                const respawnArgs = buildArgsForRespawn(
                  saved,
                  kind,
                  projectRoot || "",
                  agentSettings,
                  reconnectTimedOut,
                  clipboardDirectory,
                  projectPresetsByAgent,
                  {
                    resolvedAgentBaseCommand,
                    allowResumeLatest: !resumeLatestSuppressedIds.has(saved.id),
                  }
                );

                // Assign to the active worktree when the saved terminal has no
                // worktreeId, or names a deleted one — which also keeps the
                // respawn's cwd pointing at a directory that still exists.
                respawnArgs.worktreeId = await resolveRestoredWorktreeId(respawnArgs.worktreeId);

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
                buildArgsForNonPtyRecreation(saved, kind, projectRoot || "", activeWorktreeId)
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
        // Both are inferred attribution: the lifecycle ledger records the
        // provenance so cwd inference can never overwrite a worktree the
        // user explicitly chose later in this panel's life.
        const inferred = inferWorktreeIdFromCwd(terminal.cwd, worktreesForInfer ?? undefined);
        if (inferred) {
          orphanArgs.worktreeId = inferred;
          orphanArgs.worktreeIdSource = "inferred";
        } else if (activeWorktreeId) {
          orphanArgs.worktreeId = activeWorktreeId;
          orphanArgs.worktreeIdSource = "inferred";
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
