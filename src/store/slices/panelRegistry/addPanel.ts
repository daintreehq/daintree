import type { TerminalRuntimeStatus } from "@/types";
import type { PanelRegistryStoreApi, PanelRegistrySlice, TerminalInstance } from "./types";
import { terminalClient, projectClient } from "@/clients";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { TerminalRefreshTier } from "@/types";
import {
  panelKindUsesTerminalUi,
  getPanelKindConfig,
  getExtensionFallbackDefaults,
} from "@shared/config/panelKindRegistry";
import { getTerminalAppearanceSnapshot } from "@/hooks/useTerminalAppearance";
import { getScrollbackForType, PERFORMANCE_MODE_SCROLLBACK } from "@/utils/scrollbackConfig";
import { getXtermOptions } from "@/config/xtermConfig";
import { deriveTerminalRuntimeIdentity } from "@/utils/terminalChrome";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useLayoutConfigStore } from "@/store/layoutConfigStore";
import { usePanelLimitStore, evaluatePanelLimit } from "@/store/panelLimitStore";
import { notify } from "@/lib/notify";
import { saveNormalized } from "./persistence";
import {
  getDefaultTitle,
  DOCK_TERM_WIDTH,
  DOCK_TERM_HEIGHT,
  DOCK_PREWARM_WIDTH_PX,
  DOCK_PREWARM_HEIGHT_PX,
} from "./helpers";
import { logDebug, logWarn, logError } from "@/utils/logger";
import { collectPanelIdForBatch, isHydrationBatchActive } from "./hydrationBatch";

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

type Set = PanelRegistryStoreApi["setState"];
type Get = PanelRegistryStoreApi["getState"];

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

export const createAddPanelActions = (
  set: Set,
  get: Get
): Pick<PanelRegistrySlice, "addPanel"> => ({
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
        notify({
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
          notify({
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

    const requestedKind = options.kind ?? "terminal";

    // Handle panels that use custom UI (browser, dev-preview, extensions) separately
    if (!panelKindUsesTerminalUi(requestedKind)) {
      const id = options.requestedId || `${requestedKind}-${crypto.randomUUID()}`;
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
        ephemeral: options.ephemeral,
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
          // Fold dock activation into this commit so the watchdog effect in
          // `DockPanelOffscreenContainer` cannot observe `activeDockTerminalId`
          // set across a microtask boundary from the panel landing in
          // `dockTerminals`. See #6590.
          if (options.activateDockOnCreate && location === "dock") {
            // `previousFocusedId` is preserved by the panelStore.ts wrapper
            // after registry.addPanel returns; here we only fold the dock
            // activation into the same set() that commits the panel so the
            // watchdog can't observe an intermediate state.
            return {
              panelsById: newById,
              panelIds: newIds,
              activeDockTerminalId: id,
              focusedId: id,
            };
          }
          return { panelsById: newById, panelIds: newIds };
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
    const isAgent = Boolean(launchAgentId);
    // Reserve the id up front so the panel can be committed to the store before
    // any async work (env fetch, spawn IPC). #5789: commit-then-spawn collapses
    // six rapid agent clicks from serialized spawns into six parallel placeholders.
    const id = options.existingId ?? options.requestedId ?? `${kind}-${crypto.randomUUID()}`;

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
      launchAgentId,
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
      isUsingFallback: options.isUsingFallback,
      fallbackChainIndex: options.fallbackChainIndex,
      extensionState: options.extensionState,
      pluginId: ptyPluginId,
      spawnedBy: options.spawnedBy,
      ephemeral: options.ephemeral,
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
                detectedProcessId: terminal.detectedProcessId ?? existing.detectedProcessId,
                runtimeIdentity: terminal.runtimeIdentity ?? existing.runtimeIdentity,
                // Capability is sealed at spawn — values should match — but
                // preserve the existing entry if a partial reconnect omits it.
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
                detectedProcessId: terminal.detectedProcessId ?? existing.detectedProcessId,
                runtimeIdentity: terminal.runtimeIdentity ?? existing.runtimeIdentity,
                // Capability is sealed at spawn — values should match — but
                // preserve the existing entry if a partial reconnect omits it.
              }
            : terminal;
          const newById = { ...state.panelsById, [id]: preservedTerminal };
          saveNormalized(newById, state.panelIds);
          return { panelsById: newById };
        }
        const newById = { ...state.panelsById, [id]: terminal };
        const newIds = [...state.panelIds, id];
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
          return {
            panelsById: newById,
            panelIds: newIds,
            activeDockTerminalId: id,
            focusedId: id,
          };
        }
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

      if (!isAgent) {
        terminalInstanceService.prewarmTerminal(id, launchAgentId, terminalOptions, {
          offscreen: offscreenOrInactive,
          widthPx: location === "dock" ? DOCK_PREWARM_WIDTH_PX : DOCK_TERM_WIDTH,
          heightPx: location === "dock" ? DOCK_PREWARM_HEIGHT_PX : DOCK_TERM_HEIGHT,
        });
      } else {
        // Agent terminals also need prewarm for proper tier management.
        // This ensures they can receive wake signals when their worktree activates.
        const widthPx = location === "dock" ? DOCK_PREWARM_WIDTH_PX : DOCK_TERM_WIDTH;
        const heightPx = location === "dock" ? DOCK_PREWARM_HEIGHT_PX : DOCK_TERM_HEIGHT;

        terminalInstanceService.prewarmTerminal(id, launchAgentId, terminalOptions, {
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

    // Wake the renderer instance and clear attention indicators when a panel is
    // created as the active dock panel — the state activation was already
    // committed atomically in the set() above (see #6590); this only handles
    // the renderer-side side effects that `openDockTerminal` would normally
    // perform. Wrapped to mirror the prewarm block: a renderer service
    // failure should not strand the panel in `spawning` with the spawn
    // promise never started.
    if (options.activateDockOnCreate && location === "dock") {
      try {
        terminalInstanceService.wake(id);
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
        launchAgentId,
        title,
        env: mergedEnv,
        restore: options.restore,
        agentLaunchFlags: options.agentLaunchFlags,
        agentModelId: options.agentModelId,
        worktreeId: options.worktreeId,
        agentPresetId: options.agentPresetId,
        agentPresetColor: options.agentPresetColor,
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
});
