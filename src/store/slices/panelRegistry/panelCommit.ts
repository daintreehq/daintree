import type { AddPanelCommitOptions, PanelRegistryStoreApi } from "./types";
import type { AddPanelOptions } from "@shared/types/addPanelOptions";
import {
  isGridPanelLocation,
  isPtyPanel,
  type PanelInstance,
  type PanelKind,
  type PanelLocation,
  type PtyPanelData,
  type TabGroup,
  type TabGroupLocation,
} from "@shared/types/panel";
import { getNarrowPanel } from "./selectors";
import { resolvePanelKindPolicy } from "@shared/config/panelKindRegistry";
import { peek as peekTerminalService } from "@/services/terminal/terminalInstanceServiceAccessor";
import { saveNormalized } from "./persistence";
import { logDebug } from "@/utils/logger";
import { collectPanelIdForBatch, isHydrationBatchActive } from "./hydrationBatch";
import { newerObservation, sanitizeLiveRestoreProvenance } from "@shared/utils/restoreProvenance";
import type { SpawnProvenance } from "@shared/utils/scheduledRunProvenance";
import {
  addToWorktreeIndex,
  panelMatchesWorktreeScope,
  transferBetweenWorktreeIndex,
} from "./worktreeIndex";

export type CarrierPanel = Parameters<typeof getNarrowPanel>[0][string];

/**
 * Earliest position any of `ids` holds in `order`, or `-1` when none appear.
 * Each ordered structure resolves the anchor against itself: a cross-worktree
 * transfer appends to the destination bucket without moving the flat id, so
 * bucket order is not guaranteed to be flat order projected by worktree, and
 * reusing one structure's answer in the other would misplace the copy.
 */
export type RegistryState = ReturnType<PanelRegistryStoreApi["getState"]>;

/**
 * The source an update keeps, with the scheduled run that came with it: taken
 * from whichever side has a source, never one half from each (#15977).
 */
function keptSpawnProvenance(
  next: SpawnProvenance,
  existing: SpawnProvenance | undefined
): SpawnProvenance {
  const from = next.spawnedBy !== undefined ? next : existing;
  return { spawnedBy: from?.spawnedBy, scheduledRun: from?.scheduledRun };
}

/**
 * Restore target recorded on a panel born parked. A replayed hydration keeps
 * the entry already in the map (see `commitParked`), so the record follows it
 * and the save made inside the commit writes the target a restore will use.
 */
export function parkedRestoreTarget(
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
export function commitParked(
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

export function earliestIndexOf(order: readonly string[], ids: readonly string[]): number {
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
export function resolveInsertAfterAnchor(
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

export function isHeldForRecovery(panel: CarrierPanel | undefined): boolean {
  return (
    panel !== undefined &&
    panel.location !== "trash" &&
    isPtyPanel(panel) &&
    panel.restoreRecovery !== undefined
  );
}

/** Still exactly as its host's loss of its terminal left it, under `restartKey`. */
export function showsLostTerminal(panel: CarrierPanel | undefined, restartKey: number): boolean {
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
 *
 * The run's first prompt (#14592) is carried the same way only while the same
 * run goes on. A launch that replaces the pane's process (a held pane started,
 * a lost terminal relaunched) decides it from its own options, since starting
 * over must clear it.
 */
export function carryLivePaneRecords(
  incoming: CarrierPanel,
  existing: PtyPanelData | undefined,
  replacesRun: boolean
): CarrierPanel {
  if (!existing || !isPtyPanel(incoming)) return incoming;
  const firstPrompt = replacesRun ? undefined : existing.firstPrompt;
  if (!existing.scratchpad && !firstPrompt) return incoming;
  return {
    ...incoming,
    ...(existing.scratchpad && { scratchpad: existing.scratchpad }),
    ...(firstPrompt && { firstPrompt }),
  };
}

export function gridFocusPatch(
  commit: AddPanelCommitOptions | undefined,
  location: string,
  id: string
): { focusedId?: string; previousFocusedId?: string | null } {
  if (!commit?.focus || location !== "grid" || !commit.focus.stillApplies()) return {};
  const { previousFocusedId } = commit.focus;
  return previousFocusedId === id ? { focusedId: id } : { focusedId: id, previousFocusedId };
}

/**
 * Commits a PTY panel record. The hydration-batch and runtime branches stay
 * separate on purpose: the batch defers the `panelIds` append and persist to
 * its flush, while the runtime commit anchors, persists and folds dock
 * activation and focus into the same `set()`.
 */
export function commitPtyPanel(
  set: PanelRegistryStoreApi["setState"],
  args: {
    id: string;
    terminal: PanelInstance;
    options: AddPanelOptions;
    requestedKind: PanelKind;
    location: PanelLocation;
    isReconnect: boolean;
    replacesLost: number | undefined;
    commit: AddPanelCommitOptions | undefined;
  }
): void {
  const { id, terminal, options, requestedKind, location, isReconnect, replacesLost, commit } =
    args;
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
  if (isHydrationBatchActive() && !options.replacesRestoreRecovery && replacesLost === undefined) {
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
              ...keptSpawnProvenance(ptyTerminal, existingPty),
              // Same for the plugin hold and its owner, and for how restore
              // last rebuilt the pane (#14017).
              launchedByPluginId: ptyTerminal.launchedByPluginId ?? existingPty?.launchedByPluginId,
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
      const carried = carryLivePaneRecords(preservedTerminal, existingPty, false);
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
              ...keptSpawnProvenance(ptyTerminal, existingPty2),
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
          [id]: carryLivePaneRecords(
            preservedTerminal,
            existingPty2,
            options.replacesRestoreRecovery === true || replacesLost !== undefined
          ),
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
}
