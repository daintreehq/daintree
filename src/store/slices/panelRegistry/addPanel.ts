import type { TerminalRuntimeStatus } from "@/types";
import type { AddPanelCommitOptions, PanelRegistryStoreApi, PanelRegistrySlice } from "./types";
import {
  isGridPanelLocation,
  isPtyPanel,
  type PanelInstance,
  type PanelLocation,
  type PtyPanelData,
  type TabGroup,
  type TabGroupLocation,
} from "@shared/types/panel";
import { getNarrowPanel } from "./selectors";

type CarrierPanel = Parameters<typeof getNarrowPanel>[0][string];
import { terminalClient, projectClient, globalEnvClient } from "@/clients";
import {
  load as loadTerminalService,
  peek as peekTerminalService,
  with as withTerminalService,
} from "@/services/terminal/terminalInstanceServiceAccessor";
import { TerminalRefreshTier } from "@/types";
import {
  panelKindUsesTerminalUi,
  normalizeDockLocation,
  getPanelKindConfig,
  getExtensionFallbackDefaults,
  resolvePanelKindPolicy,
} from "@shared/config/panelKindRegistry";
import { getTerminalAppearanceSnapshot } from "@/hooks/useTerminalAppearance";
import { getScrollbackForType, PERFORMANCE_MODE_SCROLLBACK } from "@/utils/scrollbackConfig";
import { getXtermOptions, calculateTerminalDimensions } from "@/config/xtermConfig";
import { deriveTerminalRuntimeIdentity } from "@/utils/terminalChrome";
import { getWorktreeSelectionSnapshot } from "@/store/storeAccessors";
import { useHelpPanelStore } from "@/store/helpPanelStore";
import { usePanelLimitStore, buildPanelLimitSnapshot } from "@/store/panelLimitStore";
import { notify } from "@/lib/notify";
import { saveNormalized } from "./persistence";
import {
  getDefaultTitle,
  DOCK_TERM_WIDTH,
  DOCK_TERM_HEIGHT,
  DOCK_PREWARM_WIDTH_PX,
  DOCK_PREWARM_HEIGHT_PX,
  reconcileWorktreeAfterSpawn,
} from "./helpers";
import { logDebug, logWarn, logError } from "@/utils/logger";
import { markRendererPerformance } from "@/utils/performance";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { isClientAppError } from "@/utils/clientAppError";
import { requiredPluginToolsSpawnError } from "@/utils/requiredPluginToolsSpawnError";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { isUnknownOutcomeError } from "@/utils/resolveUnknownOutcome";
import { useHostConnectionStore, waitForHostConnected } from "@/store/hostConnectionStore";
import { takeHostAgentState } from "@/store/hostTerminalResync";
import { findSpawnOnHost, isLostSpawnReply, markSpawnUnconfirmed } from "./unconfirmedSpawn";
import { collectPanelIdForBatch, isHydrationBatchActive } from "./hydrationBatch";
import { newerObservation, sanitizeLiveRestoreProvenance } from "@shared/utils/restoreProvenance";
import {
  addToWorktreeIndex,
  panelMatchesWorktreeScope,
  transferBetweenWorktreeIndex,
} from "./worktreeIndex";
import { agentLifecycleLedger } from "@/services/terminal/lifecycleLedger";
import {
  type AgentLaunchHoldDetail,
  clearPanelMemoryPressureMark,
  holdForMemoryPressure,
  panelHoldKey,
  requestAgentLaunchAdmission,
} from "@/store/memoryPressureWaitStore";
import {
  cancelDriveLeaseHold,
  clearPanelDriveLeaseMark,
  drivesProject,
  holdForDriveLease,
  markPanelDriveLeaseLaunch,
  watchesProject,
} from "@/store/driveLeaseWaitStore";
import { getDriveLeaseSnapshot } from "@/services/terminal/inputGate";
import { computeEnvProvenance } from "@shared/utils/agentLifecycleLedger";
import { mergeTerminalLaunchEnv } from "@shared/utils/terminalLaunchOptions";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";
import { buildAgentLaunchContext } from "./agentLaunchContext";
import { countPanelsTowardLimit } from "./panelCount";
import { isUsableTerminalGeometry } from "@shared/types/terminal";

// Lazy accessor to break circular dependency: addPanel -> projectStore -> panelPersistence -> addPanel.
// Resolved on first call (after app init), then cached.
let _cachedProjectStore: typeof import("@/store/projectStore").useProjectStore | null = null;
async function resolveProjectStore() {
  if (!_cachedProjectStore) {
    const mod = await import("@/store/projectStore");
    _cachedProjectStore = mod.useProjectStore;
  }
  return _cachedProjectStore;
}

/**
 * Earliest position any of `ids` holds in `order`, or `-1` when none appear.
 * Each ordered structure resolves the anchor against itself: a cross-worktree
 * transfer appends to the destination bucket without moving the flat id, so
 * bucket order is not guaranteed to be flat order projected by worktree, and
 * reusing one structure's answer in the other would misplace the copy.
 */
type RegistryState = ReturnType<PanelRegistryStoreApi["getState"]>;

/**
 * Restore target recorded on a panel born parked. A replayed hydration keeps
 * the entry already in the map (see `commitParked`), so the record follows it
 * and the save made inside the commit writes the target a restore will use.
 */
function parkedRestoreTarget(
  state: RegistryState,
  id: string,
  options: { backgroundRestoreLocation?: "grid" | "dock" }
): "grid" | "dock" {
  return (
    state.backgroundedTerminals.get(id)?.originalLocation ??
    options.backgroundRestoreLocation ??
    "grid"
  );
}

/**
 * Wraps a commit so a panel born parked lands with its restore entry in the
 * same `set()`: `restoreBackgroundTerminal` reads only `backgroundedTerminals`,
 * and an entry written a commit later leaves a window where the panel is
 * parked with no way back. A replayed hydration keeps the entry already there,
 * which may carry tab-group metadata the snapshot never had, and the panel's
 * restore target is aligned to it.
 */
function commitParked(
  set: PanelRegistryStoreApi["setState"],
  panel: { id: string; location?: string; backgroundRestoreLocation?: "grid" | "dock" }
) {
  return (updater: (state: RegistryState) => Partial<RegistryState> | RegistryState): void => {
    set((state) => {
      const patch = updater(state);
      if (patch === state || panel.location !== "background") return patch;
      const current = patch.backgroundedTerminals ?? state.backgroundedTerminals;
      const kept = current.get(panel.id);
      if (kept) {
        // The panel's field is what the next save writes, so it follows the
        // entry that is kept rather than the snapshot's.
        const committed = patch.panelsById?.[panel.id];
        if (!committed || committed.backgroundRestoreLocation === kept.originalLocation) {
          return patch;
        }
        return {
          ...patch,
          panelsById: {
            ...patch.panelsById,
            [panel.id]: { ...committed, backgroundRestoreLocation: kept.originalLocation },
          },
        };
      }
      const backgroundedTerminals = new Map(current);
      backgroundedTerminals.set(panel.id, {
        id: panel.id,
        originalLocation: panel.backgroundRestoreLocation ?? "grid",
      });
      return { ...patch, backgroundedTerminals };
    });
  };
}

function earliestIndexOf(order: readonly string[], ids: readonly string[]): number {
  let earliest = -1;
  for (const id of ids) {
    const at = order.indexOf(id);
    if (at !== -1 && (earliest === -1 || at < earliest)) earliest = at;
  }
  return earliest;
}

/**
 * Resolve `AddPanelOptions.insertAfterId` to a flat `panelIds` index for a live
 * add, plus the anchor ids each ordered structure should place the new panel
 * after. `null` falls back to the ordinary append.
 *
 * Runs inside the commit `set()` on purpose. `addPanel` has async gaps before
 * it lands (agent-settings IPC while the duplicate recipe is built, then
 * `resolveProjectStore()` on the PTY path), so a numeric index computed at
 * dispatch would be stale by the time it is used. Only the id is durable
 * intent; the position is whatever that id means at commit.
 */
function resolveInsertAfterAnchor(
  state: {
    panelIds: string[];
    panelsById: Record<string, CarrierPanel>;
    tabGroups: Map<string, TabGroup>;
    trashedTerminals: Map<string, unknown>;
  },
  panel: { id: string; location?: PanelLocation; worktreeId?: string | null },
  insertAfterId: string | undefined
): { index: number; anchorIds: string[] } | null {
  if (!insertAfterId || insertAfterId === panel.id) return null;

  // Grid and dock are the only surfaces with a user-visible order to be
  // adjacent within — an overlay/dialog/trash landing has no slot to take.
  const location: TabGroupLocation | null = isGridPanelLocation(panel.location)
    ? "grid"
    : panel.location === "dock"
      ? "dock"
      : null;
  if (location === null) return null;

  // Mirrors the per-member filter both renderers apply, `trashedTerminals`
  // (optimistic close) included, so the anchor is a slot the user can see.
  const inScope = (candidate: CarrierPanel): boolean => {
    if (state.trashedTerminals.has(candidate.id)) return false;
    const onSurface =
      location === "grid" ? isGridPanelLocation(candidate.location) : candidate.location === "dock";
    return onSurface && panelMatchesWorktreeScope(candidate.worktreeId, panel.worktreeId, location);
  };

  // A source that has been trashed, moved to the other surface, or re-homed to
  // another worktree since dispatch no longer has a slot the copy can sit next
  // to; the same goes for one that never made it into `panelIds`.
  const source = state.panelsById[insertAfterId];
  if (!source || !inScope(source) || state.panelIds.indexOf(insertAfterId) === -1) return null;

  // Both renderers emit an explicit group once, at its earliest surviving
  // member — so a copy anchored on a later member would land past every panel
  // rendered in between. Anchor on the whole group instead and let each
  // structure pick its own earliest. The copy itself stays ungrouped: folding
  // it into the source's group is `addTabForPanel`'s job.
  //
  // The dock resolves groups PTY-only, chipping every non-PTY member standalone
  // in place (#11332), so there a non-PTY source is its own anchor and non-PTY
  // siblings are not candidates.
  let anchorIds = [insertAfterId];
  const groupsThisSource = location === "grid" || isPtyPanel(source);
  if (groupsThisSource) {
    for (const group of state.tabGroups.values()) {
      if (group.location !== location) continue;
      // Group-level scope, matching `getTabGroups`/`buildDockRenderItems`: a
      // group pinned to another worktree is not rendered here at all.
      if (!panelMatchesWorktreeScope(group.worktreeId, panel.worktreeId, location)) continue;
      if (!group.panelIds.includes(insertAfterId)) continue;
      const members = group.panelIds.filter((memberId) => {
        const member = state.panelsById[memberId];
        if (!member || !inScope(member)) return false;
        return location === "grid" || isPtyPanel(member);
      });
      // The store enforces single-group membership, so the first match is the
      // source's group; stop either way rather than blending two groups.
      if (members.includes(insertAfterId)) anchorIds = members;
      break;
    }
  }

  const index = earliestIndexOf(state.panelIds, anchorIds);
  return index === -1 ? null : { index: index + 1, anchorIds };
}

type Set = PanelRegistryStoreApi["setState"];
type Get = PanelRegistryStoreApi["getState"];

function countNonTrashTerminals(state: PanelRegistrySlice): number {
  return countPanelsTowardLimit(state.panelsById, state.panelIds);
}

function isHeldForRecovery(panel: CarrierPanel | undefined): boolean {
  return (
    panel !== undefined &&
    panel.location !== "trash" &&
    isPtyPanel(panel) &&
    panel.restoreRecovery !== undefined
  );
}

/** Still exactly as its host's loss of its terminal left it, under `restartKey`. */
function showsLostTerminal(panel: CarrierPanel | undefined, restartKey: number): boolean {
  return (
    panel !== undefined &&
    panel.location !== "trash" &&
    isPtyPanel(panel) &&
    !panel.isRestarting &&
    panel.runtimeStatus === "exited" &&
    panel.exitCode === undefined &&
    (panel.restartKey ?? 0) === restartKey
  );
}

/**
 * A call landing on a live record — a reconnect, a double hydration, a held pane
 * being launched — carries restore-time or snapshot notes that can be older than
 * what the user has typed since (#12835). The live record's notes win; the
 * incoming ones only fill a record that has none.
 */
function carryLiveScratchpad(
  incoming: CarrierPanel,
  existing: PtyPanelData | undefined
): CarrierPanel {
  if (!existing?.scratchpad || !isPtyPanel(incoming)) return incoming;
  return { ...incoming, scratchpad: existing.scratchpad };
}

const TERMINAL_STARTUP_ATTACH_TIMEOUT_MS = 2500;

// Chrome allowance for the overlay (help panel) grid estimate: horizontal =
// panel border + terminal-host inset; vertical = header + banners + hybrid
// input bar + footer. Rough is fine — the estimate only has to be close
// enough that a CLI painting before the first real fit lands near the final
// wrap width instead of the legacy 80×24 spawn default.
const OVERLAY_CHROME_X_PX = 16;
const OVERLAY_CHROME_Y_PX = 240;

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
 * Estimated grid for an overlay (help panel) terminal, derived from the
 * persisted panel width and the current viewport. The overlay's XtermAdapter
 * mounts without waiting for spawnStatus, but historically both the prewarmed
 * xterm and the PTY booted at the 80×24 spawn default, so the assistant CLI
 * painted its banner at 80 cols and the first real fit re-wrapped (or, when
 * the fit's PTY resize raced the spawn and was dropped, permanently desynced)
 * the committed output — the duplicated/garbled assistant startup (#10863).
 */
function estimateOverlayGridDims(fontSize: number): { cols: number; rows: number } | null {
  const panelWidth = useHelpPanelStore.getState().width;
  const viewportHeight = window.innerHeight;
  // NaN/∞ would flow into the panel record, the xterm constructor, and the
  // spawn payload — fall back to the legacy defaults instead of estimating.
  if (
    !Number.isFinite(panelWidth) ||
    !Number.isFinite(viewportHeight) ||
    !Number.isFinite(fontSize)
  ) {
    return null;
  }
  return calculateTerminalDimensions(
    Math.max(200, panelWidth - OVERLAY_CHROME_X_PX),
    Math.max(240, viewportHeight - OVERLAY_CHROME_Y_PX),
    fontSize
  );
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

const terminalStartupQueue = new TerminalStartupQueue();

function gridFocusPatch(
  commit: AddPanelCommitOptions | undefined,
  location: string,
  id: string
): { focusedId?: string; previousFocusedId?: string | null } {
  if (!commit?.focus || location !== "grid" || !commit.focus.stillApplies()) return {};
  const { previousFocusedId } = commit.focus;
  return previousFocusedId === id ? { focusedId: id } : { focusedId: id, previousFocusedId };
}
const RECIPE_TERMINAL_STARTUP_CONCURRENCY = 3;

export const createAddPanelActions = (
  set: Set,
  get: Get
): Pick<PanelRegistrySlice, "addPanel"> => ({
  addPanel: async (options, commit) => {
    // Panel limit enforcement: only the hard ceiling blocks a single-panel add.
    // The confirm band (>= confirmationLimit) is intentionally non-blocking —
    // adding a panel is reversible (one-click close), so the step-throttled
    // `TerminalCountWarning` banner (shown from `softWarningLimit` upward, with
    // no upper bound) is the right calibration, not a focus-stealing modal. The
    // blocking confirm survives only for batch spawns (`preflightSpawnBatchLimit`),
    // where the blast radius of many panels at once warrants it. See #10547.
    // Launching a pane held for recovery replaces it rather than adding one, so
    // it must not be refused by a limit the held pane already counts toward.
    const replacesHeldPane =
      options.replacesRestoreRecovery === true &&
      options.requestedId !== undefined &&
      isHeldForRecovery(get().panelsById[options.requestedId]);
    if (!options.bypassLimits && !replacesHeldPane) {
      const { softWarningLimit, confirmationLimit, hardLimit } = usePanelLimitStore.getState();
      const snapshot = buildPanelLimitSnapshot(countNonTrashTerminals(get()), {
        softWarningLimit,
        confirmationLimit,
        hardLimit,
      });

      if (snapshot.tier === "hard") {
        logWarn("[TerminalStore] Refused a panel at the hard panel limit", {
          kind: options.kind ?? "terminal",
          count: snapshot.count,
          hardLimit,
        });
        commit?.onLimitRefused?.(snapshot);
        notify({
          type: "warning",
          priority: "high",
          title: "Panel limit reached",
          message: `Maximum of ${hardLimit} panels reached. Close some panels before adding new ones.`,
          duration: 5000,
          context: { worktreeId: options.worktreeId ?? undefined },
        });
        return null;
      }
    }

    const requestedKind = options.kind ?? "terminal";

    // Handle panels that use custom UI (browser, dev-preview, extensions) separately
    if (!panelKindUsesTerminalUi(requestedKind)) {
      const id = options.requestedId || `${requestedKind}-${crypto.randomUUID()}`;
      const title = options.title || getDefaultTitle(requestedKind);

      // The scrollable grid (#8805) accepts every panel — there's no
      // screen-fit cap any more. Honor the requested location directly; the
      // hard ceiling has already been enforced upstream by `panelLimitStore`.
      const requestedLocation = options.location || "grid";
      const activeWorktreeId = getWorktreeSelectionSnapshot()?.activeWorktreeId ?? null;
      // The dock only renders kinds it can host (`isDockPanel`). A dock request
      // for a non-dockable kind would strand the panel invisibly — still
      // persisted, still counted, unreachable from any UI (#11054). Redirect it
      // to the grid instead. This also rescues already-stranded panels on
      // restart: hydration funnels non-PTY panels through this same branch
      // (`buildArgsForNonPtyRecreation` → `addPanel`), so a persisted dock panel
      // of a non-dockable kind is returned to the grid on next load. Must run
      // before the `shouldBackground`/`runtimeStatus` derivation below, or a
      // redirected-to-grid panel would still get dock-flavored background state.
      const location = normalizeDockLocation(requestedKind, requestedLocation);
      // A worktree-less panel redirected dock→grid must ALSO adopt the active
      // worktree: the grid renders only the active worktree's index bucket, so a
      // worktree-less grid panel is invisible whenever a worktree is active
      // (#11290) — worse than the stranding this rescue is meant to fix (#11375).
      // Mirrors the adoption in `moveTerminalToPosition`/`moveTerminalToGrid`.
      const adoptedWorktreeId =
        location === "grid" &&
        requestedLocation === "dock" &&
        (options.worktreeId ?? null) === null &&
        activeWorktreeId !== null
          ? activeWorktreeId
          : null;
      const effectiveWorktreeId = adoptedWorktreeId ?? options.worktreeId;
      // When activeWorktreeId is null (worktree store not yet hydrated — common
      // during a project switch), treat the panel as being in the active worktree
      // to avoid incorrectly backgrounding it. Mirrors the PTY branch guard
      // below; without it a non-PTY plugin panel spawned mid-switch is
      // mis-backgrounded (#10512).
      const isInActiveWorktree =
        activeWorktreeId === null || (effectiveWorktreeId ?? null) === (activeWorktreeId ?? null);
      const shouldBackground =
        location === "dock" ||
        location === "background" ||
        (location === "grid" && !isInActiveWorktree);
      const runtimeStatus: TerminalRuntimeStatus = shouldBackground ? "background" : "running";

      const kindConfig = getPanelKindConfig(requestedKind);
      const kindFields = kindConfig?.createDefaults?.(options) ?? getExtensionFallbackDefaults();
      // Stamp pluginId at creation time while the registry still has the entry —
      // by render time the plugin may be gone. `options.pluginId` (from hydration
      // of an unregistered kind) wins over a live registry lookup only when the
      // registry has no matching entry.
      const pluginId = kindConfig?.extensionId ?? options.pluginId;
      // A restored bag keeps the version it was written at; a bag built from
      // spawn arguments is current by definition, so it takes the registered
      // one. Neither is invented for a kind the registry can't answer for —
      // an absent version reads as legacy and is handed over unjudged, which
      // is the right outcome for a bag nobody has declared a schema for
      // (#12280).
      const extensionStateVersion =
        options.extensionStateVersion ??
        (options.extensionState !== undefined ? kindConfig?.stateVersion : undefined);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- panel shape is guaranteed by the registered createDefaults factory
      const terminal = {
        id,
        kind: requestedKind,
        title,
        // Carried like the PTY branch does below. Hydration forwards the saved
        // mode (`buildArgsForNonPtyRecreation`) and persistence writes it, so
        // dropping it here silently demoted every restored non-PTY rename back
        // to `"default"` — the panel kept the name but lost the ownership that
        // stops a derived surface (the dock chip) from overriding it.
        ...(options.titleMode && { titleMode: options.titleMode }),
        worktreeId: effectiveWorktreeId,
        location,
        ...(location === "background" && {
          backgroundRestoreLocation: parkedRestoreTarget(get(), id, options),
        }),
        ...(location === "grid" &&
          options.pendingDockWorktreeId !== undefined && {
            pendingDockWorktreeId: options.pendingDockWorktreeId,
          }),
        isVisible: location === "grid",
        runtimeStatus,
        extensionState: options.extensionState,
        extensionStateVersion,
        pluginId,
        excludeFromPersistence: options.excludeFromPersistence,
        removeOnExit: options.removeOnExit,
        // Preserve the saved `lastActiveAt` from the snapshot so the
        // post-hydration focus picker in `useAppHydration` can pick
        // the active worktree's most-recently-focused panel (#9933).
        // Validated upstream in `statePatcher.ts:buildArgsFor*` via
        // `sanitizeLastActiveAt`; conditional spread avoids stamping
        // `undefined` on freshly-created panels.
        ...(options.lastActiveAt !== undefined && { lastActiveAt: options.lastActiveAt }),
        ...kindFields,
      } as PanelInstance;

      if (isHydrationBatchActive()) {
        // Batched path: commit `panelsById` immediately (event listeners can find
        // the panel by id) and defer the `panelIds` append + persist to flush.
        commitParked(
          set,
          terminal
        )((state) => {
          const existing = state.panelsById[id];
          if (existing) {
            logDebug("[TerminalStore] Panel already exists, updating instead of adding", { id });
          }
          return {
            panelsById: { ...state.panelsById, [id]: terminal },
            panelIdsByWorktreeId: existing
              ? // Defensive: if a hydration replays with a different worktreeId,
                // keep the index in sync rather than silently corrupting it.
                transferBetweenWorktreeIndex(
                  state.panelIdsByWorktreeId,
                  existing.worktreeId,
                  terminal.worktreeId,
                  id
                )
              : addToWorktreeIndex(state.panelIdsByWorktreeId, terminal.worktreeId, id),
          };
        });
        collectPanelIdForBatch(id);
      } else {
        // Capture the kind's policy synchronously, BEFORE the `set()` updater
        // closure. The updater can run later (or, under React 19 concurrent
        // mode, replay), and a plugin unregister landing between this point
        // and the commit would silently flip the popover gate. See the
        // matching pattern in panelStore.ts where every fallback site reads
        // policy before the registry mutation.
        const popoverSuppressed =
          options.focusPolicy === "preserve" ||
          !resolvePanelKindPolicy(requestedKind).dockPopoverOnSpawn;
        commitParked(
          set,
          terminal
        )((state) => {
          const existing = state.panelsById[id];
          if (existing) {
            logDebug("[TerminalStore] Panel already exists, updating instead of adding", { id });
            const newById = { ...state.panelsById, [id]: terminal };
            const newIndex = transferBetweenWorktreeIndex(
              state.panelIdsByWorktreeId,
              existing.worktreeId,
              terminal.worktreeId,
              id
            );
            saveNormalized(newById, state.panelIds);
            return { panelsById: newById, panelIdsByWorktreeId: newIndex };
          }
          const newById = { ...state.panelsById, [id]: terminal };
          const anchor = resolveInsertAfterAnchor(state, terminal, options.insertAfterId);
          const newIds = [...state.panelIds];
          newIds.splice(anchor ? anchor.index : newIds.length, 0, id);
          const newIndex = addToWorktreeIndex(
            state.panelIdsByWorktreeId,
            terminal.worktreeId,
            id,
            anchor?.anchorIds
          );
          saveNormalized(newById, newIds);
          // Fold dock activation into this commit so the watchdog effect in
          // `DockPanelOffscreenContainer` cannot observe `activeDockTerminalId`
          // set across a microtask boundary from the panel landing in
          // `dockTerminals`. See #6590.
          if (options.activateDockOnCreate && location === "dock") {
            // `previousFocusedId` is preserved by the panelStore.ts wrapper
            // after registry.addPanel returns; here we only fold the dock
            // activation into the same set() that commits the panel so the
            // watchdog can't observe an intermediate state.
            // Focus-preserve spawns should land in the dock without opening the
            // popover. Opening the popover mounts Radix focus management and
            // terminal focus handlers, which is itself a keyboard-focus side
            // effect even if focusedId is preserved. See #6959.
            // The kind's policy may also opt out (e.g., a reading-surface
            // kind that prefers to land in the dock quietly); both gates
            // are folded into `popoverSuppressed` above.
            if (popoverSuppressed) {
              return {
                panelsById: newById,
                panelIds: newIds,
                panelIdsByWorktreeId: newIndex,
              };
            }
            return {
              panelsById: newById,
              panelIds: newIds,
              panelIdsByWorktreeId: newIndex,
              activeDockTerminalId: id,
              focusedId: id,
            };
          }
          return {
            panelsById: newById,
            panelIds: newIds,
            panelIdsByWorktreeId: newIndex,
            ...gridFocusPatch(commit, location, id),
          };
        });
      }

      return id;
    }

    // PTY panels: terminal / dev-preview. Agent identity lives on `launchAgentId`.
    const launchAgentId = options.launchAgentId;
    // Determine kind for PTY handling (dev-preview keeps its own kind)
    const kind: "terminal" | "dev-preview" =
      requestedKind === "dev-preview" ? "dev-preview" : "terminal";
    const title = options.title || getDefaultTitle(kind, { launchAgentId });

    // The scrollable panel grid no longer caps panels at the screen-fit count
    // (#8805). Honor the requested location directly; the hardware-adaptive
    // hard ceiling is enforced upstream by `panelLimitStore`.
    // Defense-in-depth: honor a non-dockable requested kind BEFORE the collapse
    // to "terminal"/"dev-preview" above discards it (#11375). `hasPty:true` with
    // `dockable:false` is rejected at the manifest gate and terminal/agent kinds
    // are always dockable, so this only fires for a programmatic dock request of
    // a non-dockable PTY kind — redirect it to the grid. No worktree adoption
    // here (unlike the non-PTY branch): PTY restore paths reconcile worktree
    // separately, and this defensive redirect never fires for a real launch.
    const location = normalizeDockLocation(requestedKind, options.location || "grid");
    const activeWorktreeId = getWorktreeSelectionSnapshot()?.activeWorktreeId ?? null;
    // When activeWorktreeId is null (worktree store not yet hydrated — common during
    // project switch), treat the terminal as being in the active worktree to avoid
    // incorrectly backgrounding it. applyWorktreeTerminalPolicy will reconcile
    // tiers once the worktree is set.
    const isInActiveWorktree =
      activeWorktreeId === null || (options.worktreeId ?? null) === (activeWorktreeId ?? null);
    const shouldBackground =
      location === "dock" ||
      location === "background" ||
      (location === "grid" && !isInActiveWorktree);
    const runtimeStatus: TerminalRuntimeStatus = shouldBackground ? "background" : "running";

    // Capture the owning workspace synchronously before any async work to avoid race
    // conditions if the user switches during async operations (issue #3690).
    // resolveProjectStore() is cached after first call, so subsequent calls resolve immediately.
    //
    // Two ids, deliberately: `capturedProjectId` is a *registered project* (it keys
    // project settings, which a scratch has none of), while `capturedWorkspaceId` is
    // whichever workspace owns this view — project or scratch. The PTY is stamped with
    // the workspace id so `killByProject(scratchId)` reaches scratch terminals on
    // delete (#11079); leaving it unset made ownership fall back to PtyClient's global
    // `activeProjectId`, which is null after a restore into a scratch and last-write-wins
    // across windows.
    const projectStore = await resolveProjectStore();
    const capturedProjectId = projectStore.getState().currentProject?.id;
    const capturedWorkspaceId = capturedProjectId ?? getViewWorkspaceId() ?? undefined;

    const isReconnect = !!options.existingId;
    const isAgent = Boolean(launchAgentId);
    // Reserve the id up front so the panel can be committed to the store before
    // any async work (env fetch, spawn IPC). #5789: commit-then-spawn collapses
    // six rapid agent clicks from serialized spawns into six parallel placeholders.
    const id = options.existingId ?? options.requestedId ?? `${kind}-${crypto.randomUUID()}`;
    // A held pane has no process until the user picks one (#12434): it commits
    // like any other pane and stops there — no startup slot, no ledger launch,
    // no prewarm, no spawn.
    const isRecoveryHold = options.restoreRecovery !== undefined && !isReconnect;

    // Checked after the last await before the commit: the pane may have been
    // closed, or already launched by another click, while this call waited, and
    // replacing it then would resurrect it or start a second process in it.
    if (options.replacesRestoreRecovery && !isHeldForRecovery(get().panelsById[id])) {
      logWarn("[TerminalStore] Dropped a launch for a pane no longer held for recovery", { id });
      return null;
    }
    const replacesLost = options.replacesLostTerminal;
    if (replacesLost !== undefined && !showsLostTerminal(get().panelsById[id], replacesLost)) {
      logWarn(
        "[TerminalStore] Dropped a relaunch for a pane that moved on from its lost terminal",
        {
          id,
        }
      );
      return null;
    }
    // The reverse: a saved hold replayed after the user already launched that
    // pane would hide a running agent behind a gate. Only another hold may be
    // re-committed over, or a pane whose terminal is gone.
    if (isRecoveryHold && replacesLost === undefined) {
      const existing = get().panelsById[id];
      if (existing !== undefined && !isHeldForRecovery(existing)) {
        logWarn("[TerminalStore] Kept a launched pane over a stale recovery hold", { id });
        return id;
      }
    }

    // For reconnects, use the backend's state directly - don't default to "working".
    // For new spawns, start with "working" in UI to show spinner immediately during boot.
    const agentState = isReconnect
      ? options.agentState
      : isRecoveryHold
        ? undefined
        : (options.agentState ?? (isAgent ? "working" : undefined));
    // Reason restored from the backend snapshot survives only while the
    // resolved state is still "waiting" — mirrors the main-process rule that
    // clears it on any other state.
    const waitingReason = agentState === "waiting" ? options.waitingReason : undefined;
    const lastStateChange = isReconnect
      ? options.lastStateChange
      : (options.lastStateChange ?? (agentState !== undefined ? Date.now() : undefined));

    // Stale-restore guard: a reconnect/hydration replay must never overwrite a
    // LIVE fresh launch that already owns this id. The ledger distinguishes the
    // two owners of an existing panel: an earlier restore pass stamped
    // `restoredAt` (double hydration — merging the same snapshot again is
    // idempotent and allowed), while a fresh launch did not (its metadata —
    // launchAgentId, model, preset, env — is newer than the snapshot and the
    // merge below would clobber it). Generation 0 = "persisted snapshot,
    // predates every launch this session", so the rejection lands in the
    // anomaly ring for diagnostics.
    if (isReconnect) {
      const preexisting = get().panelsById[id];
      const ledgerEntry = preexisting ? agentLifecycleLedger.getEntry(id) : undefined;
      if (
        preexisting &&
        ledgerEntry &&
        ledgerEntry.closedAt === undefined &&
        ledgerEntry.restoredAt === undefined
      ) {
        agentLifecycleLedger.recordRestoreApplied(id, 0);
        logWarn("[TerminalStore] Rejected stale restore over a live launch", { id });
        return id;
      }
    }

    // PTY-backed plugin-contributed kinds are rare today, but stamp pluginId
    // if the registry has an entry so the panel survives plugin removal.
    const ptyKindConfig = getPanelKindConfig(kind);
    // A PTY-backed plugin kind collapses to "terminal" above; keep the kind it
    // was opened as, so its plugin can still be found for this panel (#13213).
    const pluginPanelKindId =
      requestedKind !== kind && getPanelKindConfig(requestedKind)?.extensionId !== undefined
        ? requestedKind
        : undefined;
    const ptyPluginId = ptyKindConfig?.extensionId ?? options.pluginId;
    const ptyExtensionStateVersion =
      options.extensionStateVersion ??
      (options.extensionState !== undefined ? ptyKindConfig?.stateVersion : undefined);
    // Reconnects don't go through a fresh spawn — mark them "ready" directly. A
    // held pane has no spawn at all; `restoreRecovery` drives its rendering.
    const spawnStatus: "spawning" | "ready" | undefined = isReconnect
      ? "ready"
      : isRecoveryHold
        ? undefined
        : "spawning";

    // Overlay terminals boot at ~their real grid instead of the 80×24 spawn
    // default so the assistant CLI never paints its startup banner at a width
    // the first fit then re-wraps (#10863). Grid/dock keep the legacy default:
    // their XtermAdapter attaches only after spawnStatus flips "ready", so the
    // fit's PTY resize always lands on a live PTY.
    const overlayDims =
      location === "overlay" && !isReconnect
        ? estimateOverlayGridDims(getTerminalAppearanceSnapshot().fontSize)
        : null;

    // The grid this pane is BORN on. Hydration supplies the persisted size for
    // a restored pane so it never exists at 80×24 — a restore into a
    // non-selected worktree is prewarmed and never fitted, so the default would
    // stand for as long as the user stays away while the surviving PTY streams
    // into it (#11718). Overlay keeps precedence: its estimate is the grid its
    // XtermAdapter is about to fit to, and the two never co-occur (an overlay
    // is never a restore). Re-validated here because `addPanel` is also reached
    // from plugins and MCP.
    const restoredDims = isUsableTerminalGeometry(options.initialTerminalGeometry)
      ? options.initialTerminalGeometry
      : null;
    const constructionDims = overlayDims ?? restoredDims;

    // Single active-grid launches mount their visible xterm immediately
    // (TerminalPane skips the spawnStatus gate), overlapping xterm.open()
    // and the first fit with the env fetch + spawn IPC below. Decided at
    // commit time — the flag must be in the first committed panel record
    // because TerminalPane reads it on first render. Burst spawns (queue
    // busy) keep the gate so panels realize with bounded concurrency (#5789).
    const eagerAttach =
      !isReconnect &&
      !isRecoveryHold &&
      location === "grid" &&
      isInActiveWorktree &&
      terminalStartupQueue.isIdle;
    // Every non-reconnect, non-held PTY panel reaches the enqueue below (prewarm
    // and dock-wake failures are caught), so each reserve pairs with one enqueue.
    if (!isReconnect && !isRecoveryHold) terminalStartupQueue.reserve();

    const terminal = {
      id,
      kind,
      launchAgentId,
      title,
      // Pin the title when the caller owns it (e.g. an assistant-named agent
      // launch). `titleMode: "custom"` makes the identity reducer skip its
      // agent-detected/exited title rewrites. Conditional spread avoids
      // stamping `undefined`, which would read as an explicit "default".
      ...(options.titleMode && { titleMode: options.titleMode }),
      worktreeId: options.worktreeId,
      cwd: options.cwd ?? "",
      cols: constructionDims?.cols ?? 80,
      rows: constructionDims?.rows ?? 24,
      agentState,
      waitingReason,
      lastStateChange,
      location,
      ...(location === "background" && {
        backgroundRestoreLocation: parkedRestoreTarget(get(), id, options),
      }),
      command: options.command,
      // Initialize grid terminals as visible to avoid initial under-throttling
      // IntersectionObserver will update this once mounted
      isVisible: location === "grid" ? true : false,
      runtimeStatus: isRecoveryHold ? undefined : runtimeStatus,
      isInputLocked: options.isInputLocked,
      exitBehavior: options.exitBehavior,
      agentSessionId: options.agentSessionId,
      agentLaunchFlags: options.agentLaunchFlags,
      callerLaunchFlags: options.callerLaunchFlags,
      requiredPluginTools: options.requiredPluginTools,
      agentModelId: options.agentModelId,
      everDetectedAgent: options.everDetectedAgent,
      agentIncarnation: options.agentIncarnation,
      detectedAgentId: options.detectedAgentId,
      detectedProcessId: options.detectedProcessId,
      runtimeIdentity:
        deriveTerminalRuntimeIdentity({
          detectedAgentId: options.detectedAgentId,
          detectedProcessId: options.detectedProcessId,
        }) ??
        (launchAgentId
          ? deriveTerminalRuntimeIdentity({
              detectedAgentId: launchAgentId,
            })
          : undefined) ??
        undefined,
      agentPresetId: options.agentPresetId,
      agentPresetColor: options.agentPresetColor,
      originalPresetId: options.originalPresetId ?? options.agentPresetId,
      // Caller-resolved launch env captured so a restored session replays the
      // SAME provider environment it launched with (#10922). This is the
      // launcher's merged env (agent global + preset/recipe + caller layers); the
      // ambient global/project env is fetched when the panel is added (the
      // prefetch below, overlapping prewarm and any queue wait) and layered
      // UNDER this, so only the launch-resolved layer is frozen here.
      ...(options.env && { env: options.env }),
      isUsingFallback: options.isUsingFallback,
      fallbackChainIndex: options.fallbackChainIndex,
      sessionLostOnRestore: options.sessionLostOnRestore,
      ...(options.conversationCwd && { conversationCwd: options.conversationCwd }),
      // `hasPty: false` is what keeps fleet broadcast, interrupt and the other
      // live-process consumers off a pane that has nothing to write to.
      ...(isRecoveryHold && { restoreRecovery: options.restoreRecovery, hasPty: false }),
      ...(options.restoreProvenance && { restoreProvenance: options.restoreProvenance }),
      ...(options.lastAgentObservation && { lastAgentObservation: options.lastAgentObservation }),
      ...(options.launchedByPluginId && { launchedByPluginId: options.launchedByPluginId }),
      ...(options.holdOnRestart === true && { holdOnRestart: true as const }),
      ...(options.scratchpad && { scratchpad: options.scratchpad }),
      extensionState: options.extensionState,
      extensionStateVersion: ptyExtensionStateVersion,
      pluginId: ptyPluginId,
      ...(pluginPanelKindId !== undefined && { pluginPanelKindId }),
      spawnedBy: options.spawnedBy,
      focusPolicy: options.focusPolicy,
      excludeFromPersistence: options.excludeFromPersistence,
      removeOnExit: options.removeOnExit,
      startedAt: isRecoveryHold ? undefined : Date.now(),
      spawnStatus,
      ...(eagerAttach && { eagerAttach: true }),
      // Preserve the saved `lastActiveAt` from the snapshot so the
      // post-hydration focus picker in `useAppHydration` can pick
      // the active worktree's most-recently-focused panel (#9933).
      // Validated upstream in `statePatcher.ts:buildArgsFor*` via
      // `sanitizeLastActiveAt`; conditional spread avoids stamping
      // `undefined` on freshly-created panels.
      ...(options.lastActiveAt !== undefined && { lastActiveAt: options.lastActiveAt }),
    } as PanelInstance;

    // Commit the panel to `panelsById` BEFORE any async IPC (#5789 optimistic
    // placeholder) so the user sees the panel immediately and IPC event
    // listeners (onAgentStateChanged, onExit, onAgentDetected, activity flushes,
    // etc.) that look panels up by id always find the entry.
    // PTY-specific field access within the closures below requires the narrow view.
    // `terminal` is `PanelInstance` (cast above); the PTY path always produces a
    // PtyPanelData shape at runtime so the re-assertion is safe here.
    const ptyTerminal = terminal as PtyPanelData;

    // A launch over a held pane adds no id, so a batch's deferred flush — which
    // only persists when ids were added — would never write the new record.
    if (
      isHydrationBatchActive() &&
      !options.replacesRestoreRecovery &&
      replacesLost === undefined
    ) {
      // Batched path: commit `panelsById` immediately; defer `panelIds` append.
      commitParked(
        set,
        terminal
      )((state) => {
        const existing = state.panelsById[id];
        const existingPty = existing && isPtyPanel(existing) ? existing : undefined;
        const preservedTerminal: CarrierPanel =
          existing && isReconnect
            ? {
                ...ptyTerminal,
                agentState: ptyTerminal.agentState ?? existingPty?.agentState,
                // Reason follows the effective state: keep the freshest known
                // reason while waiting (a live event may have landed before the
                // reconnect flush), clear it otherwise.
                waitingReason:
                  (ptyTerminal.agentState ?? existingPty?.agentState) === "waiting"
                    ? (ptyTerminal.waitingReason ?? existingPty?.waitingReason)
                    : undefined,
                lastStateChange: ptyTerminal.lastStateChange ?? existingPty?.lastStateChange,
                exitBehavior: ptyTerminal.exitBehavior ?? existingPty?.exitBehavior,
                extensionState: ptyTerminal.extensionState ?? existing.extensionState,
                // Recovered with the bag it describes. Keeping one without
                // the other would leave a stamped bag looking legacy, and a
                // reconnect is not a plugin write (#12280).
                extensionStateVersion:
                  ptyTerminal.extensionState !== undefined
                    ? ptyTerminal.extensionStateVersion
                    : existing.extensionStateVersion,
                // Sticky: once detected, never downgrade on a partial reconnect payload.
                everDetectedAgent: ptyTerminal.everDetectedAgent || existingPty?.everDetectedAgent,
                // `??`, not `||`: zero is a real reading of this pty, and the
                // backend read outranks what the panel learned from an event.
                agentIncarnation: ptyTerminal.agentIncarnation ?? existingPty?.agentIncarnation,
                // Stamped once at creation and never re-derivable: an orphan or
                // partial reconnect payload carries none, so keep what we have
                // rather than letting the spread blank it (#12419).
                spawnedBy: ptyTerminal.spawnedBy ?? existingPty?.spawnedBy,
                // Same for the plugin hold and its owner, and for how restore
                // last rebuilt the pane (#14017).
                launchedByPluginId:
                  ptyTerminal.launchedByPluginId ?? existingPty?.launchedByPluginId,
                holdOnRestart: ptyTerminal.holdOnRestart ?? existingPty?.holdOnRestart,
                // A live PTY has left any hold, whichever side recorded it.
                restoreProvenance: sanitizeLiveRestoreProvenance(
                  ptyTerminal.restoreProvenance ?? existingPty?.restoreProvenance
                ),
                lastAgentObservation: newerObservation(
                  ptyTerminal.lastAgentObservation,
                  existingPty?.lastAgentObservation
                ),
                // Prefer the fresh reconnect value if present; otherwise keep an existing
                // live detection (live IPC event may have landed before reconnect flush).
                detectedAgentId: ptyTerminal.detectedAgentId ?? existingPty?.detectedAgentId,
                detectedProcessId: ptyTerminal.detectedProcessId ?? existingPty?.detectedProcessId,
                runtimeIdentity: ptyTerminal.runtimeIdentity ?? existingPty?.runtimeIdentity,
                // Capability is sealed at spawn — values should match — but
                // preserve the existing entry if a partial reconnect omits it.
              }
            : ptyTerminal;
        const carried = carryLiveScratchpad(preservedTerminal, existingPty);
        return {
          panelsById: { ...state.panelsById, [id]: carried },
          panelIdsByWorktreeId: existing
            ? // Defensive: PTY reconnect payloads should preserve worktreeId, but
              // sync the index if a fresh hydration arrives with a different one.
              transferBetweenWorktreeIndex(
                state.panelIdsByWorktreeId,
                existing.worktreeId,
                preservedTerminal.worktreeId,
                id
              )
            : addToWorktreeIndex(state.panelIdsByWorktreeId, preservedTerminal.worktreeId, id),
        };
      });
      collectPanelIdForBatch(id);
    } else {
      // Capture popover-gate inputs synchronously, BEFORE the `set()` updater
      // closure — same reason as the non-PTY path above. Resolve from
      // `requestedKind` (the caller-supplied kind), not the collapsed `kind`,
      // so a PTY extension kind's policy is honored. `kind` here is collapsed
      // to "terminal" | "dev-preview" for storage-shape purposes only.
      const ptyPopoverSuppressed =
        options.focusPolicy === "preserve" ||
        !resolvePanelKindPolicy(requestedKind).dockPopoverOnSpawn;
      // What the lost terminal showed goes, as a restart's does: the new
      // process starts on a fresh terminal, and the new restart key remounts it.
      if (replacesLost !== undefined) peekTerminalService()?.destroy(id);
      commitParked(
        set,
        terminal
      )((state) => {
        const existing = state.panelsById[id];
        if (existing) {
          // Update existing terminal in place (reconnection case or double hydration)
          logDebug("[TerminalStore] Terminal already exists, updating instead of adding", { id });
          // Preserve existing agentState/lastStateChange/exitBehavior if new values are undefined
          const existingPty2 = isPtyPanel(existing) ? existing : undefined;
          const preservedTerminal: CarrierPanel = isReconnect
            ? {
                ...ptyTerminal,
                agentState: ptyTerminal.agentState ?? existingPty2?.agentState,
                // Reason follows the effective state — same rule as the
                // batched path above.
                waitingReason:
                  (ptyTerminal.agentState ?? existingPty2?.agentState) === "waiting"
                    ? (ptyTerminal.waitingReason ?? existingPty2?.waitingReason)
                    : undefined,
                lastStateChange: ptyTerminal.lastStateChange ?? existingPty2?.lastStateChange,
                exitBehavior: ptyTerminal.exitBehavior ?? existingPty2?.exitBehavior,
                extensionState: ptyTerminal.extensionState ?? existing.extensionState,
                // Recovered with the bag it describes. Keeping one without
                // the other would leave a stamped bag looking legacy, and a
                // reconnect is not a plugin write (#12280).
                extensionStateVersion:
                  ptyTerminal.extensionState !== undefined
                    ? ptyTerminal.extensionStateVersion
                    : existing.extensionStateVersion,
                // Sticky: once detected, never downgrade on a partial reconnect payload.
                everDetectedAgent: ptyTerminal.everDetectedAgent || existingPty2?.everDetectedAgent,
                // `??`, not `||`: zero is a real reading of this pty, and the
                // backend read outranks what the panel learned from an event.
                agentIncarnation: ptyTerminal.agentIncarnation ?? existingPty2?.agentIncarnation,
                // Stamped once at creation and never re-derivable: an orphan or
                // partial reconnect payload carries none, so keep what we have
                // rather than letting the spread blank it (#12419).
                spawnedBy: ptyTerminal.spawnedBy ?? existingPty2?.spawnedBy,
                // Same for the plugin hold and its owner, and for how restore
                // last rebuilt the pane (#14017).
                launchedByPluginId:
                  ptyTerminal.launchedByPluginId ?? existingPty2?.launchedByPluginId,
                holdOnRestart: ptyTerminal.holdOnRestart ?? existingPty2?.holdOnRestart,
                // A live PTY has left any hold, whichever side recorded it.
                restoreProvenance: sanitizeLiveRestoreProvenance(
                  ptyTerminal.restoreProvenance ?? existingPty2?.restoreProvenance
                ),
                lastAgentObservation: newerObservation(
                  ptyTerminal.lastAgentObservation,
                  existingPty2?.lastAgentObservation
                ),
                // Prefer the fresh reconnect value if present; otherwise keep an existing
                // live detection (live IPC event may have landed before reconnect flush).
                detectedAgentId: ptyTerminal.detectedAgentId ?? existingPty2?.detectedAgentId,
                detectedProcessId: ptyTerminal.detectedProcessId ?? existingPty2?.detectedProcessId,
                runtimeIdentity: ptyTerminal.runtimeIdentity ?? existingPty2?.runtimeIdentity,
                // Capability is sealed at spawn — values should match — but
                // preserve the existing entry if a partial reconnect omits it.
              }
            : replacesLost !== undefined
              ? { ...ptyTerminal, restartKey: (existingPty2?.restartKey ?? 0) + 1 }
              : ptyTerminal;
          const newById = {
            ...state.panelsById,
            [id]: carryLiveScratchpad(preservedTerminal, existingPty2),
          };
          const newIndex = transferBetweenWorktreeIndex(
            state.panelIdsByWorktreeId,
            existing.worktreeId,
            preservedTerminal.worktreeId,
            id
          );
          saveNormalized(newById, state.panelIds);
          return { panelsById: newById, panelIdsByWorktreeId: newIndex };
        }
        const newById = { ...state.panelsById, [id]: terminal };
        const anchor = resolveInsertAfterAnchor(state, terminal, options.insertAfterId);
        const newIds = [...state.panelIds];
        newIds.splice(anchor ? anchor.index : newIds.length, 0, id);
        const newIndex = addToWorktreeIndex(
          state.panelIdsByWorktreeId,
          terminal.worktreeId,
          id,
          anchor?.anchorIds
        );
        saveNormalized(newById, newIds);
        // Fold dock activation into this commit so the watchdog effect in
        // `DockPanelOffscreenContainer` cannot observe `activeDockTerminalId`
        // set across a microtask boundary from the panel landing in
        // `dockTerminals`. See #6590.
        if (options.activateDockOnCreate && location === "dock") {
          // `previousFocusedId` is preserved by the panelStore.ts wrapper
          // after registry.addPanel returns; here we only fold the dock
          // activation into the same set() that commits the panel so the
          // watchdog can't observe an intermediate state.
          // Focus-preserve spawns should land in the dock without opening the
          // popover. Opening the popover mounts Radix focus management and
          // terminal focus handlers, which is itself a keyboard-focus side
          // effect even if focusedId is preserved. See #6959.
          // Both the explicit preserve policy and the kind's
          // `dockPopoverOnSpawn: false` opt-out are folded into
          // `ptyPopoverSuppressed` above.
          if (ptyPopoverSuppressed) {
            return {
              panelsById: newById,
              panelIds: newIds,
              panelIdsByWorktreeId: newIndex,
            };
          }
          return {
            panelsById: newById,
            panelIds: newIds,
            panelIdsByWorktreeId: newIndex,
            activeDockTerminalId: id,
            focusedId: id,
          };
        }
        return {
          panelsById: newById,
          panelIds: newIds,
          panelIdsByWorktreeId: newIndex,
          ...gridFocusPatch(commit, location, id),
        };
      });
    }

    if (isRecoveryHold) return id;

    markRendererPerformance("agentlaunch.committed", { id });

    // Mint the panel's launch generation atomically with the commit above (no
    // await between id reservation and here). Every async completion below —
    // env fetch, spawn IPC, attach settle — re-validates against it so a
    // completion that outlives this incarnation (panel closed, id reused by a
    // restart or a stale hydration replay) can never write into a successor.
    const launchGeneration = agentLifecycleLedger.recordLaunch(id, {
      launchAgentId,
      cwd: options.cwd,
      projectId: capturedWorkspaceId,
      worktreeId: options.worktreeId,
      worktreeSource:
        options.worktreeId !== undefined ? (options.worktreeIdSource ?? "explicit") : undefined,
      agentModelId: options.agentModelId,
      agentPresetId: options.agentPresetId,
      originalPresetId: options.originalPresetId ?? options.agentPresetId,
      agentLaunchFlags: options.agentLaunchFlags,
      env: computeEnvProvenance(options.env),
      initialCols: constructionDims?.cols ?? 80,
      initialRows: constructionDims?.rows ?? 24,
      spawnedBy: options.spawnedBy,
      resumedFromSessionId: options.agentSessionId,
    });
    // A launch of this id supersedes any earlier one still waiting for control.
    cancelDriveLeaseHold(id);
    clearPanelDriveLeaseMark(id);
    if (isReconnect) {
      // Mark this generation as restore-born so the stale-restore guard above
      // can tell an idempotent re-merge from a clobbering one.
      agentLifecycleLedger.recordRestoreApplied(id, launchGeneration);
    }

    // Start the ambient env fetch now so its IPC round-trips overlap the
    // prewarm below and any queue wait, instead of serializing ahead of the
    // spawn IPC inside the startup task. Same merge semantics as before —
    // global env under project env under the caller's launch env. The
    // promise never rejects (every branch resolves a fallback), so an
    // early-returning startup task cannot leave an unhandled rejection.
    const spawnEnvPromise: Promise<Record<string, string> | undefined> = (() => {
      if (isReconnect) return Promise.resolve(options.env);
      try {
        return Promise.all([
          globalEnvClient.get().catch((error: unknown) => {
            logWarn("[TerminalStore] Failed to fetch global environment variables", { error });
            return {} as Record<string, string>;
          }),
          capturedProjectId
            ? projectClient.getSettings(capturedProjectId).then(
                (s) => s?.environmentVariables ?? ({} as Record<string, string>),
                (error: unknown) => {
                  logWarn("[TerminalStore] Failed to fetch project environment variables", {
                    error,
                  });
                  return {} as Record<string, string>;
                }
              )
            : Promise.resolve({} as Record<string, string>),
        ]).then(
          ([globalEnvVars, projectEnvVars]) =>
            mergeTerminalLaunchEnv(globalEnvVars, projectEnvVars, options.env),
          (error: unknown) => {
            logWarn("[TerminalStore] Failed to fetch environment variables", { error });
            return options.env;
          }
        );
      } catch (error) {
        logWarn("[TerminalStore] Failed to fetch environment variables", { error });
        return Promise.resolve(options.env);
      }
    })();

    // Prewarm renderer-side xterm immediately so we never drop startup output/ANSI while hidden.
    // earlyDataBuffer in terminalClient buffers any data that arrives before the
    // xterm data callback is registered, so prewarming with the pre-assigned id
    // before spawn completes is safe (see #5789 research notes).
    try {
      const appearance = getTerminalAppearanceSnapshot();
      const { fontSize, fontFamily, performanceMode } = appearance;

      // Project-level scrollback override for non-agent terminals
      const projectScrollback = isAgent ? undefined : appearance.projectScrollback;

      const effectiveScrollback = performanceMode
        ? PERFORMANCE_MODE_SCROLLBACK
        : getScrollbackForType(isAgent, projectScrollback ?? appearance.scrollbackLines);

      const terminalOptions = getXtermOptions({
        fontSize,
        fontFamily,
        scrollback: effectiveScrollback,
        performanceMode,
        theme: appearance.effectiveTheme,
        screenReaderMode: appearance.screenReaderMode,
      });
      // Overlay panes are BORN at their estimated grid (xterm constructor
      // cols/rows) so pre-attach CLI output wraps near the final width — a
      // prewarmed-but-unattached xterm otherwise sits at the 80×24 default
      // until the help panel's XtermAdapter mounts (#10863). Restored panes get
      // their persisted grid the same way, for the same reason (#11718).
      const prewarmOptions = constructionDims
        ? { ...terminalOptions, cols: constructionDims.cols, rows: constructionDims.rows }
        : terminalOptions;
      // Synchronous when the service is already up, so the prewarm claims the
      // instance before anything else can mount it.
      const loadedService = peekTerminalService();
      const terminalService = loadedService ?? (await loadTerminalService());
      // Removing the panel while the service loaded found no instance to
      // destroy; prewarming now would build an orphaned xterm for it.
      const supersededDuringLoad =
        loadedService === null &&
        (get().panelsById[id] === undefined ||
          !agentLifecycleLedger.isCurrent(id, launchGeneration));

      if (!supersededDuringLoad) {
        // Prewarm ALL terminal types to ensure the managed instance and data
        // listeners exist before the backend PTY can emit output. Do not attach
        // to an offscreen or visible DOM node here. Visible xterm.open() is
        // gated by spawnStatus below so burst-created panels realize one at a
        // time instead of all mounting xterm/WebGL during the same grid layout.
        const currentActiveWorktreeId = getWorktreeSelectionSnapshot()?.activeWorktreeId ?? null;
        const isDockOrInactive =
          location === "dock" ||
          location === "background" ||
          (currentActiveWorktreeId !== null &&
            (options.worktreeId ?? null) !== (currentActiveWorktreeId ?? null));

        if (!isAgent) {
          // Awaited so the managed instance and its PTY data listener exist before
          // the queued spawn runs — prewarmTerminal is async now that the lazy
          // Unicode11 addon is loaded during terminal construction (#10840).
          await terminalService.prewarmTerminal(id, launchAgentId, prewarmOptions, {
            offscreen: false,
            widthPx: location === "dock" ? DOCK_PREWARM_WIDTH_PX : DOCK_TERM_WIDTH,
            heightPx: location === "dock" ? DOCK_PREWARM_HEIGHT_PX : DOCK_TERM_HEIGHT,
          });
        } else {
          // Agent terminals also need prewarm for proper tier management.
          // This ensures they can receive wake signals when their worktree activates.
          const widthPx = location === "dock" ? DOCK_PREWARM_WIDTH_PX : DOCK_TERM_WIDTH;
          const heightPx = location === "dock" ? DOCK_PREWARM_HEIGHT_PX : DOCK_TERM_HEIGHT;

          // Awaited so the instance exists before the sendPtyResize below targets
          // it — prewarmTerminal is async now that the lazy Unicode11 addon is
          // loaded during terminal construction (#10840).
          await terminalService.prewarmTerminal(id, launchAgentId, prewarmOptions, {
            offscreen: false,
            widthPx,
            heightPx,
          });

          // Only send explicit resize for active grid spawns. Background/dock
          // terminals can boot at the spawn default and will be resized on reveal.
          // Cell metrics come from calculateTerminalDimensions so the lineHeight
          // assumption stays in sync with xtermConfig. An overlay panel that
          // reaches this branch (no active worktree) must use its own estimate —
          // the DOCK_TERM-derived dims would re-poison the grid the overlay
          // spawn path just fixed (#10863), and for a settled-strategy agent
          // this call arms a 500ms timer that can land AFTER the spawn. When the
          // estimate is unavailable (non-finite inputs), skip entirely and let
          // the spawn-time dims own overlay geometry. A restored pane skips it
          // too: its PTY is already on the persisted grid we just constructed at,
          // and this estimate is a fixed DOCK_TERM-derived guess, not a
          // measurement — sending it would move a healthy PTY off that grid
          // (#11718).
          if (!isDockOrInactive && !restoredDims && (location !== "overlay" || overlayDims)) {
            const { cols, rows } =
              overlayDims ?? calculateTerminalDimensions(widthPx, heightPx, fontSize);
            terminalService.sendPtyResize(id, cols, rows);
          }
        }
      }
    } catch (error) {
      logWarn("[TerminalStore] Failed to prewarm terminal", { id, error });
    }
    markRendererPerformance("agentlaunch.prewarmed", { id });

    // Determine if terminal should start backgrounded:
    // 1. Dock terminals are always backgrounded (offscreen)
    // 2. Grid terminals in inactive worktrees should also be backgrounded
    //    since they won't mount until the worktree becomes active
    if (shouldBackground) {
      // Terminal is either in dock or in an inactive worktree.
      // Apply BACKGROUND policy to prevent renderer updates for unmounted terminals.
      withTerminalService(
        (service) => service.applyRendererPolicy(id, TerminalRefreshTier.BACKGROUND),
        id
      );
    }

    // The store's value, not the creation option: a lock toggled while the
    // service loaded must not be reverted here.
    const lockTarget = get().panelsById[id];
    peekTerminalService()?.setInputLocked(
      id,
      lockTarget && isPtyPanel(lockTarget) ? !!lockTarget.isInputLocked : !!options.isInputLocked
    );

    // Wake the renderer instance and clear attention indicators when a panel is
    // created as the active dock panel — the state activation was already
    // committed atomically in the set() above (see #6590); this only handles
    // the renderer-side side effects that `openDockTerminal` would normally
    // perform. Wrapped to mirror the prewarm block: a renderer service
    // failure should not strand the panel in `spawning` with the spawn
    // promise never started.
    // Mirror both opt-outs from the popover gate above so this side-effect
    // path doesn't fire when the popover was deliberately suppressed.
    // Resolve from `requestedKind` to honor PTY extension kind policies.
    const ptyDockPolicy = resolvePanelKindPolicy(requestedKind);
    if (
      options.activateDockOnCreate &&
      location === "dock" &&
      options.focusPolicy !== "preserve" &&
      ptyDockPolicy.dockPopoverOnSpawn
    ) {
      try {
        peekTerminalService()?.wake(id);
        if (agentState === "waiting") {
          window.electron?.notification?.acknowledgeWaiting(id);
        } else if (agentState === "working") {
          window.electron?.notification?.acknowledgeWorkingPulse(id);
        }
      } catch (error) {
        logWarn("[TerminalStore] Failed to wake/acknowledge active dock panel", { id, error });
      }
    }

    if (isReconnect) {
      // Reconnect path does not spawn; the panel is already "ready".
      logDebug("[TerminalStore] Reconnecting to existing terminal", { id });
      return id;
    }

    const shouldWaitForVisibleAttach = location === "grid" && isInActiveWorktree;
    // An agent pane waits out critical kernel memory pressure before it spawns
    // (#13530), and waits while the host already runs as many agents as its
    // memory allows (#14221), launches and restores alike. Not the assistant:
    // it renders in its own surface, and asking it about memory is what the
    // memory notice offers.
    const holdsForMemoryPressure =
      Boolean(launchAgentId) && location !== "overlay" && location !== "dialog";
    // Any pane waits for control of its project (#13913), save the assistant
    // and dialog panes, whose own surfaces handle a launch that didn't start.
    const holdsForDriveLease = location !== "overlay" && location !== "dialog";
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
        const waitOutMemoryPressure = (detail?: AgentLaunchHoldDetail): void => {
          // A launch control released keeps its mark through the memory wait:
          // a restart stays off it until its spawn has an answer.
          if (controlArrived) handedOn = true;
          holdForMemoryPressure(panelHoldKey(id), {
            panelId: id,
            detail,
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
          // a restore that tips the machine into critical, or fills it, holds
          // the rest of itself. Started before the env await so the round
          // trips overlap.
          const admissionCheck =
            holdsForMemoryPressure && !launchAnyway ? requestAgentLaunchAdmission(id) : null;
          const mergedEnv = await spawnEnvPromise;
          const admission = admissionCheck !== null ? await admissionCheck : null;

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
            if (admission?.holdReason) {
              waitOutMemoryPressure({
                reason: admission.holdReason,
                observation: admission.observation,
              });
              return;
            }
            if (resumed && _p1.location === "trash") {
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
          if (
            holdsForDriveLease &&
            (controlArrived || resumed) &&
            getDriveLeaseSnapshot() !== null
          ) {
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
                panelsById: { ...state.panelsById, [id]: { ...current, spawnStatus: "ready" } },
              };
            });
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
              if (
                settledDims &&
                (settledDims.cols !== spawnCols || settledDims.rows !== spawnRows)
              ) {
                terminalClient.resize(id, settledDims.cols, settledDims.rows);
              }
            }

            if (mountedPanel && waitForAttach) {
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
                      logWarn(
                        "[TerminalStore] Couldn't trash a terminal found after a lost spawn",
                        {
                          id,
                          error: trashError,
                        }
                      );
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

    return id;
  },
});
