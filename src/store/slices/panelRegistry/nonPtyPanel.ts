import type { TerminalRuntimeStatus } from "@/types";
import type { AddPanelCommitOptions, PanelRegistryStoreApi } from "./types";
import type { AddPanelOptions } from "@shared/types/addPanelOptions";
import type { PanelInstance, PanelKind } from "@shared/types/panel";
import {
  normalizeDockLocation,
  getPanelKindConfig,
  getExtensionFallbackDefaults,
  resolvePanelKindPolicy,
} from "@shared/config/panelKindRegistry";
import { getWorktreeSelectionSnapshot } from "@/store/storeAccessors";
import { saveNormalized } from "./persistence";
import { getDefaultTitle } from "./helpers";
import { logDebug } from "@/utils/logger";
import { collectPanelIdForBatch, isHydrationBatchActive } from "./hydrationBatch";
import { addToWorktreeIndex, transferBetweenWorktreeIndex } from "./worktreeIndex";
import {
  commitParked,
  gridFocusPatch,
  parkedRestoreTarget,
  resolveInsertAfterAnchor,
} from "./panelCommit";

/** Creates a panel that uses custom UI (browser, dev-preview, extensions) rather than a PTY. */
export function addNonPtyPanel(
  set: PanelRegistryStoreApi["setState"],
  get: PanelRegistryStoreApi["getState"],
  options: AddPanelOptions,
  commit: AddPanelCommitOptions | undefined,
  requestedKind: PanelKind
): string {
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
