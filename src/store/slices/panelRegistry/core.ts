import type { TerminalRuntimeStatus } from "@/types";
import type {
  PanelRegistryStoreApi,
  PanelRegistrySlice,
  PanelRegistryMiddleware,
  TerminalInstance,
  HydrationBatchToken,
} from "./types";
import { terminalClient, projectClient } from "@/clients";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { TerminalRefreshTier } from "@/types";
import { isRegisteredAgent } from "@/config/agents";
import {
  panelKindHasPty,
  panelKindUsesTerminalUi,
  getPanelKindConfig,
  getExtensionFallbackDefaults,
} from "@shared/config/panelKindRegistry";
import { getTerminalAppearanceSnapshot } from "@/hooks/useTerminalAppearance";
import { getScrollbackForType, PERFORMANCE_MODE_SCROLLBACK } from "@/utils/scrollbackConfig";
import { getXtermOptions } from "@/config/xtermConfig";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useLayoutConfigStore } from "@/store/layoutConfigStore";
import { usePanelLimitStore, evaluatePanelLimit } from "@/store/panelLimitStore";
import { useNotificationStore } from "@/store/notificationStore";
import { saveNormalized, saveTabGroups } from "./persistence";
import { optimizeForDock } from "./layout";
import {
  deriveRuntimeStatus,
  getDefaultTitle,
  DOCK_TERM_WIDTH,
  DOCK_TERM_HEIGHT,
  DOCK_PREWARM_WIDTH_PX,
  DOCK_PREWARM_HEIGHT_PX,
  stopDevPreviewByPanelId,
} from "./helpers";
import type { TrashExpiryHelpers } from "./trash";
import { logDebug, logWarn, logError } from "@/utils/logger";

// Lazy accessor to break circular dependency: core -> projectStore -> panelPersistence -> core.
// Resolved on first call (after app init), then cached.
let _cachedProjectStore: typeof import("@/store/projectStore").useProjectStore | null = null;
async function resolveProjectStore() {
  if (!_cachedProjectStore) {
    const mod = await import("@/store/projectStore");
    _cachedProjectStore = mod.useProjectStore;
  }
  return _cachedProjectStore;
}

type Set = PanelRegistryStoreApi["setState"];
type Get = PanelRegistryStoreApi["getState"];

/**
 * Hydration batch state. Each restore phase runs inside begin/flush, and during
 * that window `addPanel` commits the per-panel `panelsById` entry immediately
 * (so IPC event listeners that look panels up by id always find them) but defers
 * the `panelIds` append. Flush applies a single `panelIds` update per phase —
 * which is the high-fanout subscription that the worktree dashboard, dock, and
 * grid subscribe to. Net: a phase of N panels triggers 1 `panelIds` render
 * instead of N, while never leaving spawned panels invisible to event handlers.
 *
 * Singleton: hydration is guarded by `isCurrent()` so at most one batch is active
 * at a time. `HydrationBatchToken` protects against stale flushes from cancelled
 * hydrations colliding with a fresh batch started by the superseding hydration.
 */
// `globalThis.Set` qualifier avoids a collision with the local `type Set` alias
// above (which is the Zustand `setState` function type).
let activeHydrationBatch: {
  token: HydrationBatchToken;
  /** Ids pending append to `panelIds`; deduplicated via `seenIds`. */
  pendingIds: string[];
  seenIds: globalThis.Set<string>;
} | null = null;

/**
 * Exposed so higher-level `addPanel` wrappers (e.g. the focus-setting wrapper in
 * `panelStore.ts`) can skip their own `set()` calls while a batch is active —
 * otherwise they'd trigger one render per panel and defeat the batching.
 */
export function isHydrationBatchActive(): boolean {
  return activeHydrationBatch !== null;
}

/** Record a new panel id for append to `panelIds` at flush time. Dedup-safe. */
function collectPanelIdForBatch(id: string): void {
  if (activeHydrationBatch === null) return;
  if (activeHydrationBatch.seenIds.has(id)) return;
  activeHydrationBatch.seenIds.add(id);
  activeHydrationBatch.pendingIds.push(id);
}

function countNonTrashTerminals(state: PanelRegistrySlice): number {
  let count = 0;
  for (const id of state.panelIds) {
    if (state.panelsById[id]?.location !== "trash") count++;
  }
  return count;
}

function countGridTerminals(state: PanelRegistrySlice, targetWorktreeId: string | null): number {
  let count = 0;
  for (const id of state.panelIds) {
    const t = state.panelsById[id];
    if (
      t &&
      (t.location === "grid" || t.location === undefined) &&
      (t.worktreeId ?? null) === targetWorktreeId
    )
      count++;
  }
  return count;
}

export const createCorePanelActions = (
  set: Set,
  get: Get,
  { clearTrashExpiryTimer }: TrashExpiryHelpers,
  middleware?: PanelRegistryMiddleware
): Pick<
  PanelRegistrySlice,
  | "addPanel"
  | "beginHydrationBatch"
  | "flushHydrationBatch"
  | "removePanel"
  | "updateTitle"
  | "updateLastObservedTitle"
  | "updateAgentState"
  | "updateActivity"
  | "updateLastCommand"
  | "updateVisibility"
  | "getTerminal"
  | "moveTerminalToDock"
  | "moveTerminalToGrid"
  | "toggleTerminalLocation"
> => ({
  beginHydrationBatch: () => {
    // A leftover batch from a cancelled hydration is discarded — we prioritize the
    // fresh hydration and never flush stale panels into the store.
    const token: HydrationBatchToken = Symbol("hydration-batch");
    activeHydrationBatch = { token, pendingIds: [], seenIds: new Set() };
    return token;
  },

  flushHydrationBatch: (token) => {
    // Token mismatch means the batch was superseded or already flushed — ignore.
    if (activeHydrationBatch === null || activeHydrationBatch.token !== token) return;
    const pendingIds = activeHydrationBatch.pendingIds;
    activeHydrationBatch = null;

    set((state) => {
      // `panelsById` was already updated per panel during the batch, so this
      // final `set` only reveals `panelIds` to subscribers and persists once.
      // Filter: reconnect ids are already in `panelIds`, and a failed addPanel
      // might have been collected but never landed in `panelsById`.
      const existing = new Set(state.panelIds);
      const additions = pendingIds.filter(
        (id) => !existing.has(id) && state.panelsById[id] !== undefined
      );
      const newIds = additions.length > 0 ? [...state.panelIds, ...additions] : state.panelIds;
      saveNormalized(state.panelsById, newIds);
      return additions.length > 0 ? { panelIds: newIds } : {};
    });
  },

  addPanel: async (options) => {
    // Panel limit enforcement (Tier 2: confirmation, Tier 3: hard block)
    if (!options.bypassLimits) {
      const {
        softWarningLimit,
        confirmationLimit,
        hardLimit,
        warningsDisabled,
        requestConfirmation,
      } = usePanelLimitStore.getState();
      const globalCount = countNonTrashTerminals(get());
      const tier = evaluatePanelLimit(globalCount, {
        softWarningLimit,
        confirmationLimit,
        hardLimit,
      });

      if (tier === "hard") {
        useNotificationStore.getState().addNotification({
          type: "warning",
          priority: "high",
          title: "Panel limit reached",
          message: `Maximum of ${hardLimit} panels reached. Close some panels before adding new ones.`,
          duration: 5000,
        });
        return null;
      }

      if (tier === "confirm" && !warningsDisabled) {
        let memoryMB: number | null = null;
        try {
          const metrics = await import("@/clients").then((m) => m.systemClient.getAppMetrics());
          memoryMB = metrics.totalMemoryMB;
        } catch {
          // Memory info unavailable
        }

        const confirmed = await requestConfirmation(globalCount, memoryMB);
        if (!confirmed) return null;

        // Re-check count after confirmation in case panels were closed during the dialog
        const postConfirmCount = countNonTrashTerminals(get());
        if (postConfirmCount >= hardLimit) {
          useNotificationStore.getState().addNotification({
            type: "warning",
            priority: "high",
            title: "Panel limit reached",
            message: `Maximum of ${hardLimit} panels reached. Close some panels before adding new ones.`,
            duration: 5000,
          });
          return null;
        }
      }
    }

    const requestedKind = options.kind ?? (options.agentId ? "agent" : "terminal");
    const legacyType = options.type || "terminal";

    // Handle panels that use custom UI (browser, dev-preview, extensions) separately
    if (!panelKindUsesTerminalUi(requestedKind)) {
      const id =
        options.requestedId ||
        `${requestedKind}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const title = options.title || getDefaultTitle(requestedKind);

      const targetWorktreeId = options.worktreeId ?? null;
      const maxCapacity = useLayoutConfigStore.getState().getMaxGridCapacity();
      const currentGridCount = countGridTerminals(get(), targetWorktreeId);
      const requestedLocation = options.location || "grid";
      const location =
        requestedLocation === "grid" && currentGridCount >= maxCapacity
          ? "dock"
          : requestedLocation;
      const activeWorktreeId = useWorktreeSelectionStore.getState().activeWorktreeId;
      const isInActiveWorktree = (options.worktreeId ?? null) === (activeWorktreeId ?? null);
      const shouldBackground = location === "dock" || (location === "grid" && !isInActiveWorktree);
      const runtimeStatus: TerminalRuntimeStatus = shouldBackground ? "background" : "running";

      const kindConfig = getPanelKindConfig(requestedKind);
      const kindFields = kindConfig?.createDefaults?.(options) ?? getExtensionFallbackDefaults();
      // Stamp pluginId at creation time while the registry still has the entry —
      // by render time the plugin may be gone. `options.pluginId` (from hydration
      // of an unregistered kind) wins over a live registry lookup only when the
      // registry has no matching entry.
      const pluginId = kindConfig?.extensionId ?? options.pluginId;
      const terminal: TerminalInstance = {
        id,
        kind: requestedKind,
        title,
        worktreeId: options.worktreeId,
        location,
        isVisible: location === "grid",
        runtimeStatus,
        extensionState: options.extensionState,
        pluginId,
        ...kindFields,
      };

      if (isHydrationBatchActive()) {
        // Batched path: commit `panelsById` immediately (event listeners can find
        // the panel by id) and defer the `panelIds` append + persist to flush.
        set((state) => {
          if (state.panelsById[id]) {
            logDebug("[TerminalStore] Panel already exists, updating instead of adding", { id });
          }
          return { panelsById: { ...state.panelsById, [id]: terminal } };
        });
        collectPanelIdForBatch(id);
      } else {
        set((state) => {
          const existing = state.panelsById[id];
          if (existing) {
            logDebug("[TerminalStore] Panel already exists, updating instead of adding", { id });
            const newById = { ...state.panelsById, [id]: terminal };
            saveNormalized(newById, state.panelIds);
            return { panelsById: newById };
          }
          const newById = { ...state.panelsById, [id]: terminal };
          const newIds = [...state.panelIds, id];
          saveNormalized(newById, newIds);
          return { panelsById: newById, panelIds: newIds };
        });
      }

      return id;
    }

    // PTY panels: terminal/agent/dev-preview
    // Derive agentId: explicit option, or from legacy type if it's a registered agent
    const agentId = options.agentId ?? (isRegisteredAgent(legacyType) ? legacyType : undefined);
    // Determine kind for PTY handling (dev-preview keeps its own kind)
    const kind: "terminal" | "agent" | "dev-preview" =
      requestedKind === "dev-preview"
        ? "dev-preview"
        : agentId || requestedKind === "agent"
          ? "agent"
          : "terminal";
    const title = options.title || getDefaultTitle(kind, legacyType, agentId);

    // Auto-dock if grid is full and user requested grid location
    // Use dynamic capacity based on current viewport dimensions
    const targetWorktreeId = options.worktreeId ?? null;
    const maxCapacity = useLayoutConfigStore.getState().getMaxGridCapacity();
    const currentGridGroupCount = (() => {
      // Count unique groups in grid (each group = 1 slot)
      // Groups come from two sources: explicit TabGroups and ungrouped panels
      const state = get();
      const gridTerminalIds: string[] = [];
      for (const tid of state.panelIds) {
        const t = state.panelsById[tid];
        if (
          t &&
          (t.location === "grid" || t.location === undefined) &&
          (t.worktreeId ?? null) === targetWorktreeId
        )
          gridTerminalIds.push(tid);
      }
      const tabGroups = state.tabGroups;
      const panelsInGroups = new Set<string>();
      const explicitGroups = new Set<string>();

      // Count explicit groups in this location/worktree
      for (const group of tabGroups.values()) {
        if (group.location === "grid" && (group.worktreeId ?? null) === targetWorktreeId) {
          explicitGroups.add(group.id);
          group.panelIds.forEach((gid) => panelsInGroups.add(gid));
        }
      }

      // Count ungrouped panels (each is its own virtual group)
      let ungroupedCount = 0;
      for (const tid of gridTerminalIds) {
        if (!panelsInGroups.has(tid)) {
          ungroupedCount++;
        }
      }

      return explicitGroups.size + ungroupedCount;
    })();
    const requestedLocation = options.location || "grid";
    const location =
      requestedLocation === "grid" && currentGridGroupCount >= maxCapacity
        ? "dock"
        : requestedLocation;
    const activeWorktreeId = useWorktreeSelectionStore.getState().activeWorktreeId;
    // When activeWorktreeId is null (worktree store not yet hydrated — common during
    // project switch), treat the terminal as being in the active worktree to avoid
    // incorrectly backgrounding it. applyWorktreeTerminalPolicy will reconcile
    // tiers once the worktree is set.
    const isInActiveWorktree =
      activeWorktreeId === null || (options.worktreeId ?? null) === (activeWorktreeId ?? null);
    const shouldBackground = location === "dock" || (location === "grid" && !isInActiveWorktree);
    const runtimeStatus: TerminalRuntimeStatus = shouldBackground ? "background" : "running";

    // Capture project ID synchronously before any async work to avoid race conditions
    // if the user switches projects during async operations (issue #3690).
    // resolveProjectStore() is cached after first call, so subsequent calls resolve immediately.
    const projectStore = await resolveProjectStore();
    const capturedProjectId = projectStore.getState().currentProject?.id;

    const isReconnect = !!options.existingId;
    const isAgent = kind === "agent";
    // Reserve the id up front so the panel can be committed to the store before
    // any async work (env fetch, spawn IPC). #5789: commit-then-spawn collapses
    // six rapid agent clicks from serialized spawns into six parallel placeholders.
    const id =
      options.existingId ??
      options.requestedId ??
      `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    // For reconnects, use the backend's state directly - don't default to "working".
    // For new spawns, start with "working" in UI to show spinner immediately during boot.
    const agentState = isReconnect
      ? options.agentState
      : (options.agentState ?? (isAgent ? "working" : undefined));
    const lastStateChange = isReconnect
      ? options.lastStateChange
      : (options.lastStateChange ?? (agentState !== undefined ? Date.now() : undefined));

    // PTY-backed plugin-contributed kinds are rare today, but stamp pluginId
    // if the registry has an entry so the panel survives plugin removal.
    const ptyKindConfig = getPanelKindConfig(kind);
    const ptyPluginId = ptyKindConfig?.extensionId ?? options.pluginId;
    // Reconnects don't go through a fresh spawn — mark them "ready" directly.
    const spawnStatus: "spawning" | "ready" = isReconnect ? "ready" : "spawning";
    const terminal: TerminalInstance = {
      id,
      kind,
      type: legacyType,
      agentId,
      title,
      worktreeId: options.worktreeId,
      cwd: options.cwd ?? "",
      cols: 80,
      rows: 24,
      agentState,
      lastStateChange,
      location,
      command: options.command,
      // Initialize grid terminals as visible to avoid initial under-throttling
      // IntersectionObserver will update this once mounted
      isVisible: location === "grid" ? true : false,
      runtimeStatus,
      isInputLocked: options.isInputLocked,
      exitBehavior: options.exitBehavior,
      agentSessionId: options.agentSessionId,
      agentLaunchFlags: options.agentLaunchFlags,
      agentModelId: options.agentModelId,
      everDetectedAgent: options.everDetectedAgent,
      detectedAgentId: options.detectedAgentId,
      agentPresetId: options.agentPresetId,
      agentPresetColor: options.agentPresetColor,
      originalPresetId: options.originalPresetId ?? options.agentPresetId,
      isUsingFallback: options.isUsingFallback,
      fallbackChainIndex: options.fallbackChainIndex,
      extensionState: options.extensionState,
      pluginId: ptyPluginId,
      spawnedBy: options.spawnedBy,
      startedAt: Date.now(),
      spawnStatus,
    };

    // Commit the panel to `panelsById` BEFORE any async IPC (#5789 optimistic
    // placeholder) so the user sees the panel immediately and IPC event
    // listeners (onAgentStateChanged, onExit, onAgentDetected, activity flushes,
    // etc.) that look panels up by id always find the entry.
    if (isHydrationBatchActive()) {
      // Batched path: commit `panelsById` immediately; defer `panelIds` append.
      set((state) => {
        const existing = state.panelsById[id];
        const preservedTerminal =
          existing && isReconnect
            ? {
                ...terminal,
                agentState: terminal.agentState ?? existing.agentState,
                lastStateChange: terminal.lastStateChange ?? existing.lastStateChange,
                exitBehavior: terminal.exitBehavior ?? existing.exitBehavior,
                extensionState: terminal.extensionState ?? existing.extensionState,
                // Sticky: once detected, never downgrade on a partial reconnect payload.
                everDetectedAgent: terminal.everDetectedAgent || existing.everDetectedAgent,
                // Prefer the fresh reconnect value if present; otherwise keep an existing
                // live detection (live IPC event may have landed before reconnect flush).
                detectedAgentId: terminal.detectedAgentId ?? existing.detectedAgentId,
              }
            : terminal;
        return { panelsById: { ...state.panelsById, [id]: preservedTerminal } };
      });
      collectPanelIdForBatch(id);
    } else {
      set((state) => {
        const existing = state.panelsById[id];
        if (existing) {
          // Update existing terminal in place (reconnection case or double hydration)
          logDebug("[TerminalStore] Terminal already exists, updating instead of adding", { id });
          // Preserve existing agentState/lastStateChange/exitBehavior if new values are undefined
          const preservedTerminal = isReconnect
            ? {
                ...terminal,
                agentState: terminal.agentState ?? existing.agentState,
                lastStateChange: terminal.lastStateChange ?? existing.lastStateChange,
                exitBehavior: terminal.exitBehavior ?? existing.exitBehavior,
                extensionState: terminal.extensionState ?? existing.extensionState,
                // Sticky: once detected, never downgrade on a partial reconnect payload.
                everDetectedAgent: terminal.everDetectedAgent || existing.everDetectedAgent,
                // Prefer the fresh reconnect value if present; otherwise keep an existing
                // live detection (live IPC event may have landed before reconnect flush).
                detectedAgentId: terminal.detectedAgentId ?? existing.detectedAgentId,
              }
            : terminal;
          const newById = { ...state.panelsById, [id]: preservedTerminal };
          saveNormalized(newById, state.panelIds);
          return { panelsById: newById };
        }
        const newById = { ...state.panelsById, [id]: terminal };
        const newIds = [...state.panelIds, id];
        saveNormalized(newById, newIds);
        return { panelsById: newById, panelIds: newIds };
      });
    }

    // Prewarm renderer-side xterm immediately so we never drop startup output/ANSI while hidden.
    // earlyDataBuffer in terminalClient buffers any data that arrives before the
    // xterm data callback is registered, so prewarming with the pre-assigned id
    // before spawn completes is safe (see #5789 research notes).
    try {
      const appearance = getTerminalAppearanceSnapshot();
      const { fontSize, fontFamily, performanceMode } = appearance;

      // Project-level scrollback override for non-agent terminals
      const projectScrollback = kind !== "agent" ? appearance.projectScrollback : undefined;

      const effectiveScrollback = performanceMode
        ? PERFORMANCE_MODE_SCROLLBACK
        : getScrollbackForType(legacyType, projectScrollback ?? appearance.scrollbackLines);

      const terminalOptions = getXtermOptions({
        fontSize,
        fontFamily,
        scrollback: effectiveScrollback,
        performanceMode,
        theme: appearance.effectiveTheme,
        screenReaderMode: appearance.screenReaderMode,
      });

      // Prewarm ALL terminal types to ensure managed instance exists.
      // This is critical for terminals in inactive worktrees - they need a managed
      // instance for proper BACKGROUND→VISIBLE tier transitions when worktree activates.
      const currentActiveWorktreeId = useWorktreeSelectionStore.getState().activeWorktreeId;
      // When activeWorktreeId is null (hydration in progress), don't treat the
      // terminal as offscreen — it would be prewarmed in the offscreen container
      // at -20000px and backgrounded, suppressing data flow from the pty-host.
      const offscreenOrInactive =
        location === "dock" ||
        (currentActiveWorktreeId !== null &&
          (options.worktreeId ?? null) !== (currentActiveWorktreeId ?? null));

      if (kind !== "agent") {
        terminalInstanceService.prewarmTerminal(id, legacyType, terminalOptions, {
          offscreen: offscreenOrInactive,
          widthPx: location === "dock" ? DOCK_PREWARM_WIDTH_PX : DOCK_TERM_WIDTH,
          heightPx: location === "dock" ? DOCK_PREWARM_HEIGHT_PX : DOCK_TERM_HEIGHT,
        });
      } else {
        // Agent terminals also need prewarm for proper tier management.
        // This ensures they can receive wake signals when their worktree activates.
        const widthPx = location === "dock" ? DOCK_PREWARM_WIDTH_PX : DOCK_TERM_WIDTH;
        const heightPx = location === "dock" ? DOCK_PREWARM_HEIGHT_PX : DOCK_TERM_HEIGHT;

        terminalInstanceService.prewarmTerminal(id, legacyType, terminalOptions, {
          offscreen: offscreenOrInactive,
          widthPx,
          heightPx,
        });

        // For offscreen/inactive agents, prewarmTerminal's fit() already handles
        // initial PTY resize through settled strategy. Only send explicit resize
        // for active grid spawns where fit() is skipped.
        if (!offscreenOrInactive) {
          const cellWidth = Math.max(6, Math.floor(fontSize * 0.6));
          const cellHeight = Math.max(10, Math.floor(fontSize * 1.1));
          const cols = Math.max(20, Math.min(500, Math.floor(widthPx / cellWidth)));
          const rows = Math.max(10, Math.min(200, Math.floor(heightPx / cellHeight)));
          terminalInstanceService.sendPtyResize(id, cols, rows);
        }
      }
    } catch (error) {
      logWarn("[TerminalStore] Failed to prewarm terminal", { id, error });
    }

    // Determine if terminal should start backgrounded:
    // 1. Dock terminals are always backgrounded (offscreen)
    // 2. Grid terminals in inactive worktrees should also be backgrounded
    //    since they won't mount until the worktree becomes active
    if (shouldBackground) {
      // Terminal is either in dock or in an inactive worktree.
      // Apply BACKGROUND policy to prevent renderer updates for unmounted terminals.
      terminalInstanceService.applyRendererPolicy(id, TerminalRefreshTier.BACKGROUND);
    }

    terminalInstanceService.setInputLocked(id, !!options.isInputLocked);

    if (isReconnect) {
      // Reconnect path does not spawn; the panel is already "ready".
      logDebug("[TerminalStore] Reconnecting to existing terminal", { id });
      return id;
    }

    // Fire env fetch + spawn IPC in the background so the panel render is not
    // blocked on ~200-500ms of IPC round-trips. Any caller that needs to pipe
    // input after spawn already gates on agentState (which starts at "working"
    // for agents and only drops to "idle" once the PTY reports ready).
    const spawnPromise = (async () => {
      let mergedEnv: Record<string, string> | undefined = options.env;
      try {
        const [globalEnvVars, projectEnvVars] = await Promise.all([
          window.electron.globalEnv.get().catch((error: unknown) => {
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
        ]);

        const hasGlobal = Object.keys(globalEnvVars).length > 0;
        const hasProject = Object.keys(projectEnvVars).length > 0;
        if (hasGlobal || hasProject) {
          mergedEnv = { ...globalEnvVars, ...projectEnvVars, ...options.env };
        }
      } catch (error) {
        logWarn("[TerminalStore] Failed to fetch environment variables", { error });
      }

      const commandToExecute = options.skipCommandExecution ? undefined : options.command;
      await terminalClient.spawn({
        id,
        projectId: capturedProjectId,
        cwd: options.cwd,
        shell: options.shell,
        cols: 80,
        rows: 24,
        command: commandToExecute,
        kind,
        type: legacyType,
        agentId,
        title,
        env: mergedEnv,
        restore: options.restore,
        agentLaunchFlags: options.agentLaunchFlags,
        agentModelId: options.agentModelId,
        worktreeId: options.worktreeId,
        agentPresetId: options.agentPresetId,
        originalAgentPresetId: options.originalPresetId ?? options.agentPresetId,
      });
    })();

    void spawnPromise.then(
      () => {
        // Promote spawnStatus to "ready" once the PTY is live. If the panel was
        // removed during the spawn window, issue a compensating kill to avoid
        // orphaning the freshly-spawned PTY (removePanel's kill IPC was a no-op
        // at the time because the backend had no terminal yet).
        let orphaned = false;
        set((state) => {
          const current = state.panelsById[id];
          if (!current) {
            orphaned = true;
            return state;
          }
          if (current.spawnStatus !== "spawning") return state;
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
        }
      },
      (error) => {
        logError("[TerminalStore] Failed to spawn terminal", error);
        // Only remove the placeholder we committed. If the id has been reused
        // (e.g. the user closed the panel mid-spawn and a reconnect slot picked
        // the id up) or the panel was already removed, skip the cleanup —
        // otherwise we'd destroy someone else's panel.
        const current = get().panelsById[id];
        if (current?.spawnStatus !== "spawning") return;
        try {
          get().removePanel(id);
        } catch (removeError) {
          logWarn("[TerminalStore] Failed to remove panel after spawn failure", {
            id,
            error: removeError,
          });
        }
      }
    );

    return id;
  },

  removePanel: (id) => {
    clearTrashExpiryTimer(id);
    const state = get();
    const removedIndex = state.panelIds.indexOf(id);
    const terminal = state.panelsById[id];

    if (terminal?.kind === "dev-preview") {
      stopDevPreviewByPanelId(id);
    }

    // Only call PTY operations for PTY-backed terminals
    if (terminal && panelKindHasPty(terminal.kind ?? "terminal")) {
      terminalClient.kill(id).catch((error) => {
        logError("[TerminalStore] Failed to kill terminal", error);
      });

      terminalInstanceService.destroy(id);
    }

    set((state) => {
      const { [id]: _, ...restById } = state.panelsById;
      const newIds = state.panelIds.filter((tid) => tid !== id);

      const newTrashed = new Map(state.trashedTerminals);
      newTrashed.delete(id);

      const newBackgrounded = new Map(state.backgroundedTerminals);
      newBackgrounded.delete(id);

      // Remove panel from any tab group on permanent deletion
      const newTabGroups = new Map(state.tabGroups);
      for (const [groupId, group] of newTabGroups) {
        if (group.panelIds.includes(id)) {
          const filteredPanelIds = group.panelIds.filter((panelId) => panelId !== id);
          if (filteredPanelIds.length <= 1) {
            // Group has 0 or 1 panels remaining - delete it
            newTabGroups.delete(groupId);
          } else {
            // Update group without this panel
            const newActiveTabId =
              group.activeTabId === id ? (filteredPanelIds[0] ?? "") : group.activeTabId;
            newTabGroups.set(groupId, {
              ...group,
              panelIds: filteredPanelIds,
              activeTabId: newActiveTabId,
            });
          }
          break;
        }
      }

      saveNormalized(restById, newIds);
      saveTabGroups(newTabGroups);
      return {
        panelsById: restById,
        panelIds: newIds,
        trashedTerminals: newTrashed,
        backgroundedTerminals: newBackgrounded,
        tabGroups: newTabGroups,
      };
    });

    const remainingIds = get().panelIds;
    middleware?.onTerminalRemoved?.(id, removedIndex, remainingIds, terminal);
  },

  updateTitle: (id, newTitle) => {
    set((state) => {
      const terminal = state.panelsById[id];
      if (!terminal) return state;

      const effectiveTitle =
        newTitle.trim() || getDefaultTitle(terminal.kind, terminal.type, terminal.agentId);
      const newById = { ...state.panelsById, [id]: { ...terminal, title: effectiveTitle } };
      saveNormalized(newById, state.panelIds);
      return { panelsById: newById };
    });
  },

  updateLastObservedTitle: (id, title) => {
    set((state) => {
      const terminal = state.panelsById[id];
      if (!terminal) return state;
      const trimmed = title.trim();
      if (!trimmed || terminal.lastObservedTitle === trimmed) return state;
      const newById = {
        ...state.panelsById,
        [id]: { ...terminal, lastObservedTitle: trimmed },
      };
      saveNormalized(newById, state.panelIds);
      return { panelsById: newById };
    });
  },

  updateAgentState: (
    id,
    agentState,
    error,
    lastStateChange,
    trigger,
    confidence,
    waitingReason,
    sessionCost,
    sessionTokens
  ) => {
    set((state) => {
      const terminal = state.panelsById[id];
      if (!terminal) {
        logWarn("[TerminalStore] Cannot update agent state: terminal not found", { id });
        return state;
      }

      return {
        panelsById: {
          ...state.panelsById,
          [id]: {
            ...terminal,
            agentState,
            error,
            lastStateChange: lastStateChange ?? Date.now(),
            stateChangeTrigger: trigger,
            stateChangeConfidence: confidence,
            waitingReason: agentState === "waiting" ? waitingReason : undefined,
            sessionCost:
              (agentState === "completed" || agentState === "exited") && sessionCost != null
                ? sessionCost
                : agentState === "working"
                  ? undefined
                  : terminal.sessionCost,
            sessionTokens:
              (agentState === "completed" || agentState === "exited") && sessionTokens != null
                ? sessionTokens
                : agentState === "working"
                  ? undefined
                  : terminal.sessionTokens,
          },
        },
      };
    });
  },

  updateActivity: (id, headline, status, type, timestamp, lastCommand) => {
    set((state) => {
      const terminal = state.panelsById[id];
      if (!terminal) return state;

      if (
        terminal.activityHeadline === headline &&
        terminal.activityStatus === status &&
        terminal.activityType === type &&
        terminal.activityTimestamp === timestamp &&
        terminal.lastCommand === lastCommand
      ) {
        return state;
      }

      return {
        panelsById: {
          ...state.panelsById,
          [id]: {
            ...terminal,
            activityHeadline: headline,
            activityStatus: status,
            activityType: type,
            activityTimestamp: timestamp,
            lastCommand,
          },
        },
      };
    });
  },

  updateLastCommand: (id, lastCommand) => {
    set((state) => {
      const terminal = state.panelsById[id];
      if (!terminal) return state;

      return {
        panelsById: {
          ...state.panelsById,
          [id]: { ...terminal, lastCommand },
        },
      };
    });
  },

  updateVisibility: (id, isVisible) => {
    set((state) => {
      const terminal = state.panelsById[id];
      if (!terminal) return state;
      if (terminal.isVisible === isVisible) return state;

      const runtimeStatus = deriveRuntimeStatus(
        isVisible,
        terminal.flowStatus,
        terminal.runtimeStatus
      );

      return {
        panelsById: {
          ...state.panelsById,
          [id]: { ...terminal, isVisible, runtimeStatus },
        },
      };
    });
  },

  getTerminal: (id) => {
    return get().panelsById[id];
  },

  moveTerminalToDock: (id) => {
    // Check if panel is in a group - if so, move the entire group
    const group = get().getPanelGroup(id);
    if (group) {
      get().moveTabGroupToLocation(group.id, "dock");
      return;
    }

    // Single ungrouped panel - move just this panel
    const terminal = get().panelsById[id];

    set((state) => {
      if (!terminal || terminal.location === "dock") return state;

      const newById = {
        ...state.panelsById,
        [id]: {
          ...terminal,
          location: "dock" as const,
          isVisible: false,
          runtimeStatus: deriveRuntimeStatus(false, terminal.flowStatus, terminal.runtimeStatus),
        },
      };
      saveNormalized(newById, state.panelIds);
      return { panelsById: newById };
    });

    // Only optimize PTY-backed panels
    if (terminal && panelKindHasPty(terminal.kind ?? "terminal")) {
      optimizeForDock(id);
    }
  },

  moveTerminalToGrid: (id) => {
    // Check if panel is in a group - if so, move the entire group
    const group = get().getPanelGroup(id);
    if (group) {
      return get().moveTabGroupToLocation(group.id, "grid");
    }

    // Single ungrouped panel - move just this panel
    let moveSucceeded = false;
    let terminal: TerminalInstance | undefined;

    set((state) => {
      terminal = state.panelsById[id];
      if (!terminal || terminal.location === "grid") return state;

      const targetWorktreeId = terminal.worktreeId ?? null;
      const maxCapacity = useLayoutConfigStore.getState().getMaxGridCapacity();
      // Check grid capacity - count unique groups (each group = 1 slot)
      const gridTerminalIds: string[] = [];
      for (const tid of state.panelIds) {
        const t = state.panelsById[tid];
        if (
          t &&
          (t.location === "grid" || t.location === undefined) &&
          (t.worktreeId ?? null) === targetWorktreeId
        )
          gridTerminalIds.push(tid);
      }

      // Count groups using TabGroup data
      const panelsInGroups = new Set<string>();
      let explicitGroupCount = 0;
      for (const g of state.tabGroups.values()) {
        if (g.location === "grid" && (g.worktreeId ?? null) === targetWorktreeId) {
          explicitGroupCount++;
          g.panelIds.forEach((pid) => panelsInGroups.add(pid));
        }
      }
      // Count ungrouped panels
      let ungroupedCount = 0;
      for (const tid of gridTerminalIds) {
        if (!panelsInGroups.has(tid)) {
          ungroupedCount++;
        }
      }
      if (explicitGroupCount + ungroupedCount >= maxCapacity) {
        return state;
      }

      moveSucceeded = true;
      const newById = {
        ...state.panelsById,
        [id]: {
          ...terminal!,
          location: "grid" as const,
          isVisible: true,
          runtimeStatus: deriveRuntimeStatus(true, terminal!.flowStatus, terminal!.runtimeStatus),
        },
      };
      saveNormalized(newById, state.panelIds);
      return { panelsById: newById };
    });

    // Only apply renderer policy for PTY-backed panels if move succeeded
    if (moveSucceeded && terminal && panelKindHasPty(terminal.kind ?? "terminal")) {
      terminalInstanceService.applyRendererPolicy(id, TerminalRefreshTier.VISIBLE);
    }

    return moveSucceeded;
  },

  toggleTerminalLocation: (id) => {
    const terminal = get().panelsById[id];
    if (!terminal) return;

    if (terminal.location === "dock") {
      get().moveTerminalToGrid(id);
    } else {
      get().moveTerminalToDock(id);
    }
  },
});
