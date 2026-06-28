import type { TerminalRuntimeStatus } from "@/types";
import type { PanelRegistryStoreApi, PanelRegistrySlice } from "./types";
import { isPtyPanel, type PanelInstance, type PtyPanelData } from "@shared/types/panel";
import { getNarrowPanel } from "./selectors";

type CarrierPanel = Parameters<typeof getNarrowPanel>[0][string];
import { terminalClient, projectClient, globalEnvClient } from "@/clients";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { TerminalRefreshTier } from "@/types";
import {
  panelKindUsesTerminalUi,
  getPanelKindConfig,
  getExtensionFallbackDefaults,
  resolvePanelKindPolicy,
} from "@shared/config/panelKindRegistry";
import { getTerminalAppearanceSnapshot } from "@/hooks/useTerminalAppearance";
import { getScrollbackForType, PERFORMANCE_MODE_SCROLLBACK } from "@/utils/scrollbackConfig";
import { getXtermOptions, calculateTerminalDimensions } from "@/config/xtermConfig";
import { deriveTerminalRuntimeIdentity } from "@/utils/terminalChrome";
import { getWorktreeSelectionSnapshot } from "@/store/storeAccessors";
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
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { collectPanelIdForBatch, isHydrationBatchActive } from "./hydrationBatch";
import { addToWorktreeIndex, transferBetweenWorktreeIndex } from "./worktreeIndex";

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

const TERMINAL_STARTUP_ATTACH_TIMEOUT_MS = 2500;

class TerminalStartupQueue {
  private readonly tasks: Array<() => Promise<void>> = [];
  private isDraining = false;

  enqueue(task: () => Promise<void>): void {
    this.tasks.push(task);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.isDraining) return;
    this.isDraining = true;

    try {
      while (this.tasks.length > 0) {
        const task = this.tasks.shift();
        if (!task) continue;

        try {
          await task();
        } catch (error) {
          logError("[TerminalStore] Terminal startup task failed", error);
        }
      }
    } finally {
      this.isDraining = false;
      if (this.tasks.length > 0) {
        void this.drain();
      }
    }
  }
}

const terminalStartupQueue = new TerminalStartupQueue();

export const createAddPanelActions = (
  set: Set,
  get: Get
): Pick<PanelRegistrySlice, "addPanel"> => ({
  addPanel: async (options) => {
    // Panel limit enforcement: only the hard ceiling blocks a single-panel add.
    // The confirm band (>= confirmationLimit) is intentionally non-blocking —
    // adding a panel is reversible (one-click close), so the step-throttled
    // `TerminalCountWarning` banner (shown from `softWarningLimit` upward, with
    // no upper bound) is the right calibration, not a focus-stealing modal. The
    // blocking confirm survives only for batch spawns (`preflightSpawnBatchLimit`),
    // where the blast radius of many panels at once warrants it. See #10547.
    if (!options.bypassLimits) {
      const { softWarningLimit, confirmationLimit, hardLimit } = usePanelLimitStore.getState();
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
    }

    const requestedKind = options.kind ?? "terminal";

    // Handle panels that use custom UI (browser, dev-preview, extensions) separately
    if (!panelKindUsesTerminalUi(requestedKind)) {
      const id = options.requestedId || `${requestedKind}-${crypto.randomUUID()}`;
      const title = options.title || getDefaultTitle(requestedKind);

      // The scrollable grid (#8805) accepts every panel — there's no
      // screen-fit cap any more. Honor the requested location directly; the
      // hard ceiling has already been enforced upstream by `panelLimitStore`.
      const location = options.location || "grid";
      const activeWorktreeId = getWorktreeSelectionSnapshot()?.activeWorktreeId ?? null;
      // When activeWorktreeId is null (worktree store not yet hydrated — common
      // during a project switch), treat the panel as being in the active worktree
      // to avoid incorrectly backgrounding it. Mirrors the PTY branch guard
      // below; without it a non-PTY plugin panel spawned mid-switch is
      // mis-backgrounded (#10512).
      const isInActiveWorktree =
        activeWorktreeId === null || (options.worktreeId ?? null) === (activeWorktreeId ?? null);
      const shouldBackground = location === "dock" || (location === "grid" && !isInActiveWorktree);
      const runtimeStatus: TerminalRuntimeStatus = shouldBackground ? "background" : "running";

      const kindConfig = getPanelKindConfig(requestedKind);
      const kindFields = kindConfig?.createDefaults?.(options) ?? getExtensionFallbackDefaults();
      // Stamp pluginId at creation time while the registry still has the entry —
      // by render time the plugin may be gone. `options.pluginId` (from hydration
      // of an unregistered kind) wins over a live registry lookup only when the
      // registry has no matching entry.
      const pluginId = kindConfig?.extensionId ?? options.pluginId;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- panel shape is guaranteed by the registered createDefaults factory
      const terminal = {
        id,
        kind: requestedKind,
        title,
        worktreeId: options.worktreeId,
        location,
        isVisible: location === "grid",
        runtimeStatus,
        extensionState: options.extensionState,
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
        set((state) => {
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
        set((state) => {
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
          const newIds = [...state.panelIds, id];
          const newIndex = addToWorktreeIndex(state.panelIdsByWorktreeId, terminal.worktreeId, id);
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
          return { panelsById: newById, panelIds: newIds, panelIdsByWorktreeId: newIndex };
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
    const location = options.location || "grid";
    const activeWorktreeId = getWorktreeSelectionSnapshot()?.activeWorktreeId ?? null;
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
    const spawnStatus: "spawning" | "ready" | "failed" = isReconnect ? "ready" : "spawning";

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
      sessionLostOnRestore: options.sessionLostOnRestore,
      extensionState: options.extensionState,
      pluginId: ptyPluginId,
      spawnedBy: options.spawnedBy,
      focusPolicy: options.focusPolicy,
      excludeFromPersistence: options.excludeFromPersistence,
      removeOnExit: options.removeOnExit,
      startedAt: Date.now(),
      spawnStatus,
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

    if (isHydrationBatchActive()) {
      // Batched path: commit `panelsById` immediately; defer `panelIds` append.
      set((state) => {
        const existing = state.panelsById[id];
        const existingPty = existing && isPtyPanel(existing) ? existing : undefined;
        const preservedTerminal: CarrierPanel =
          existing && isReconnect
            ? {
                ...ptyTerminal,
                agentState: ptyTerminal.agentState ?? existingPty?.agentState,
                lastStateChange: ptyTerminal.lastStateChange ?? existingPty?.lastStateChange,
                exitBehavior: ptyTerminal.exitBehavior ?? existingPty?.exitBehavior,
                extensionState: ptyTerminal.extensionState ?? existing.extensionState,
                // Sticky: once detected, never downgrade on a partial reconnect payload.
                everDetectedAgent: ptyTerminal.everDetectedAgent || existingPty?.everDetectedAgent,
                // Prefer the fresh reconnect value if present; otherwise keep an existing
                // live detection (live IPC event may have landed before reconnect flush).
                detectedAgentId: ptyTerminal.detectedAgentId ?? existingPty?.detectedAgentId,
                detectedProcessId: ptyTerminal.detectedProcessId ?? existingPty?.detectedProcessId,
                runtimeIdentity: ptyTerminal.runtimeIdentity ?? existingPty?.runtimeIdentity,
                // Capability is sealed at spawn — values should match — but
                // preserve the existing entry if a partial reconnect omits it.
              }
            : ptyTerminal;
        return {
          panelsById: { ...state.panelsById, [id]: preservedTerminal },
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
      set((state) => {
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
                lastStateChange: ptyTerminal.lastStateChange ?? existingPty2?.lastStateChange,
                exitBehavior: ptyTerminal.exitBehavior ?? existingPty2?.exitBehavior,
                extensionState: ptyTerminal.extensionState ?? existing.extensionState,
                // Sticky: once detected, never downgrade on a partial reconnect payload.
                everDetectedAgent: ptyTerminal.everDetectedAgent || existingPty2?.everDetectedAgent,
                // Prefer the fresh reconnect value if present; otherwise keep an existing
                // live detection (live IPC event may have landed before reconnect flush).
                detectedAgentId: ptyTerminal.detectedAgentId ?? existingPty2?.detectedAgentId,
                detectedProcessId: ptyTerminal.detectedProcessId ?? existingPty2?.detectedProcessId,
                runtimeIdentity: ptyTerminal.runtimeIdentity ?? existingPty2?.runtimeIdentity,
                // Capability is sealed at spawn — values should match — but
                // preserve the existing entry if a partial reconnect omits it.
              }
            : ptyTerminal;
          const newById = { ...state.panelsById, [id]: preservedTerminal };
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
        const newIds = [...state.panelIds, id];
        const newIndex = addToWorktreeIndex(state.panelIdsByWorktreeId, terminal.worktreeId, id);
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
        return { panelsById: newById, panelIds: newIds, panelIdsByWorktreeId: newIndex };
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

      // Prewarm ALL terminal types to ensure the managed instance and data
      // listeners exist before the backend PTY can emit output. Do not attach
      // to an offscreen or visible DOM node here. Visible xterm.open() is
      // gated by spawnStatus below so burst-created panels realize one at a
      // time instead of all mounting xterm/WebGL during the same grid layout.
      const currentActiveWorktreeId = getWorktreeSelectionSnapshot()?.activeWorktreeId ?? null;
      const isDockOrInactive =
        location === "dock" ||
        (currentActiveWorktreeId !== null &&
          (options.worktreeId ?? null) !== (currentActiveWorktreeId ?? null));

      if (!isAgent) {
        terminalInstanceService.prewarmTerminal(id, launchAgentId, terminalOptions, {
          offscreen: false,
          widthPx: location === "dock" ? DOCK_PREWARM_WIDTH_PX : DOCK_TERM_WIDTH,
          heightPx: location === "dock" ? DOCK_PREWARM_HEIGHT_PX : DOCK_TERM_HEIGHT,
        });
      } else {
        // Agent terminals also need prewarm for proper tier management.
        // This ensures they can receive wake signals when their worktree activates.
        const widthPx = location === "dock" ? DOCK_PREWARM_WIDTH_PX : DOCK_TERM_WIDTH;
        const heightPx = location === "dock" ? DOCK_PREWARM_HEIGHT_PX : DOCK_TERM_HEIGHT;

        terminalInstanceService.prewarmTerminal(id, launchAgentId, terminalOptions, {
          offscreen: false,
          widthPx,
          heightPx,
        });

        // Only send explicit resize for active grid spawns. Background/dock
        // terminals can boot at the spawn default and will be resized on reveal.
        // Cell metrics come from calculateTerminalDimensions so the lineHeight
        // assumption stays in sync with xtermConfig.
        if (!isDockOrInactive) {
          const { cols, rows } = calculateTerminalDimensions(widthPx, heightPx, fontSize);
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

    const shouldWaitForVisibleAttach = location === "grid" && isInActiveWorktree;

    // The panel chrome is already committed. Realize backend PTY startup and
    // visible xterm.open() through a single queue so bulk recipes can add many
    // panels without making Chromium/xterm settle every terminal in the same
    // frame. spawnStatus remains "spawning" while queued, so TerminalPane shows
    // lightweight chrome instead of mounting XtermAdapter.
    terminalStartupQueue.enqueue(async () => {
      const _p0 = get().panelsById[id];
      if (!_p0 || !isPtyPanel(_p0) || _p0.spawnStatus !== "spawning") return;

      try {
        let mergedEnv: Record<string, string> | undefined = options.env;
        try {
          const [globalEnvVars, projectEnvVars] = await Promise.all([
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
          ]);

          const hasGlobal = Object.keys(globalEnvVars).length > 0;
          const hasProject = Object.keys(projectEnvVars).length > 0;
          if (hasGlobal || hasProject) {
            mergedEnv = { ...globalEnvVars, ...projectEnvVars, ...options.env };
          }
        } catch (error) {
          logWarn("[TerminalStore] Failed to fetch environment variables", { error });
        }

        const _p1 = get().panelsById[id];
        if (!_p1 || !isPtyPanel(_p1) || _p1.spawnStatus !== "spawning") return;

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
          // Launch-time context for the daintree-assistant pinned session
          // (#10647). Threaded straight through; the main-process handler only
          // consumes it for that agent and ignores it otherwise.
          actionContext: options.actionContext,
        });

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
        }

        if (mountedPanel && shouldWaitForVisibleAttach) {
          try {
            await terminalInstanceService.waitForAttachSettled(id, {
              timeoutMs: TERMINAL_STARTUP_ATTACH_TIMEOUT_MS,
            });
          } catch (error) {
            logWarn("[TerminalStore] Terminal did not attach before startup queue advanced", {
              id,
              error,
            });
          }
        }
      } catch (error) {
        logError("[TerminalStore] Failed to spawn terminal", error);
        const current = get().panelsById[id];
        if (!current || !isPtyPanel(current) || current.spawnStatus !== "spawning") return;

        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- error shape from node-pty spawn rejection
        const err = error as { code?: string; errno?: number; syscall?: string; path?: string };
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- SpawnError construction from caught IPC error
        const spawnError = {
          code: err.code ?? "UNKNOWN",
          message: formatErrorMessage(error, "Failed to start terminal process"),
          errno: err.errno,
          syscall: err.syscall,
          path: err.path,
        } as import("@shared/types/pty-host").SpawnError;

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
                spawnError,
                runtimeStatus: "error",
                ...agentPatch,
              },
            },
          };
        });

        const after = get();
        saveNormalized(after.panelsById, after.panelIds);
      }
    });

    return id;
  },
});
