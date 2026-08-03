import type { Terminal } from "@xterm/xterm";
import type { AgentState, TerminalRefreshTier } from "@/types";
import type {
  ManagedTerminal,
  RefreshTierProvider,
  AgentStateCallback,
  PostCompleteHook,
} from "../types";
import { GRID_RESIZE_COALESCE_MS } from "../types";
import type { UnseenOutputSnapshot } from "../TerminalUnseenOutputTracker";
import type { TerminalGeometry } from "@shared/types/terminal";
import type { TerminalPaintPlane } from "../TerminalInstanceService";
import { logWarn } from "@/utils/logger";
import { PaintSurfaceRegistry, surfaceKind, type PaintSurface } from "./PaintSurfaceRegistry";
import {
  defaultSurfacePlacement,
  type PlacementContext,
  type PlacementPolicy,
} from "./placementPolicies";

export type { PlacementContext, PlacementPolicy } from "./placementPolicies";

interface PaintFabricCompositorOptions {
  // First surface is the default unless a later one is marked default.
  surfaces: PaintSurface[];
  choosePlacement?: PlacementPolicy;
}

// A per-id subscription the compositor made on a surface on a caller's
// behalf. Kept so the cross-surface move path can rebind it to the new owning
// surface — without this, listeners subscribed before placement (or before a
// move) stay stranded on the old surface and silently never fire again
// (Phase 1 watch-list: "subscription rebinding on placement").
interface TrackedSubscription {
  kind: "unseenOutput" | "hibernation" | "agentState" | "exit" | "altBuffer" | "postCompleteHook";
  plane: TerminalPaintPlane;
  resubscribe: (plane: TerminalPaintPlane) => () => void;
  unsubscribe: () => void;
}

// The creation arguments the fabric last routed for a terminal. A
// cross-surface transfer re-creates the terminal on the target surface with
// exactly these, so the move is a re-parent, not a re-configure.
interface CapturedCreateArgs {
  launchAgentId: string | undefined;
  options: ConstructorParameters<typeof Terminal>[0];
  getRefreshTier?: RefreshTierProvider;
  onInput?: (data: string) => void;
  getCwd?: () => string;
}

// Route-through state the compositor shadows so a moved terminal carries its
// visibility/tier/promotion/lock state to the new surface (cross-surface
// invariant 7: never "visible" on one surface and "paused" on another after a
// move). Written on the occasional control path, never per output chunk.
interface CarriedTerminalState {
  visible?: boolean;
  backendTier?: "active" | "background";
  rendererTier?: TerminalRefreshTier;
  // null records an explicit clearAgentPromotion, distinct from "never set".
  promotedAgentId?: string | null;
  inputLocked?: boolean;
}

// Compositor-side mirror of the sync-read half of TerminalPaintPlane for
// terminals owned by view-hosted surfaces. Synchronous methods (`get`,
// `captureBufferText`, `getAgentState`, `isFocused`, `fit`, `resize`) cannot
// cross a process boundary — there is no sync renderer↔renderer IPC — so the
// compositor answers them from this mirror instead of splitting the interface
// (the load-bearing Phase 1V decision, recorded in
// docs/architecture/terminal-paint-fabric.md). Written on control paths and
// via applyMirrorPatch (the surface view's state push), never per output
// chunk.
export interface TerminalSyncMirror {
  agentState?: AgentState;
  focused?: boolean;
  bufferText?: string;
}

export type TerminalSyncMirrorPatch = Partial<TerminalSyncMirror>;

export interface PaintSurfaceDiagnostics {
  surfaceId: string;
  isDefault: boolean;
  terminalCount: number;
  scrollbackRestorePendingCount: number;
  scrollbackRestoreInProgressCount: number;
}

// requestAnimationFrame exists in every real renderer; the timeout fallback
// keeps the coalescing path deterministic under Node-environment tests.
const FRAME_FALLBACK_MS = 16;
const scheduleFrame: (callback: () => void) => void =
  typeof requestAnimationFrame === "function"
    ? (callback) => void requestAnimationFrame(() => callback())
    : (callback) => void setTimeout(callback, FRAME_FALLBACK_MS);

// The paint fabric's thin main-thread compositor: implements the exact
// renderer-facing surface of terminalInstanceService and routes each call to
// the surface that owns the target terminal. Pure bookkeeping + event routing
// — terminal bytes flow pty-host↔surface directly and never pass through this
// class; if it ever appears in per-frame LoAF attribution, the design has
// failed (docs/architecture/terminal-paint-fabric.md).
//
// Routing kinds:
// - route: per-terminal call, delegated to the owning surface (unplaced ids
//   fall back to the default surface, matching the bare service's unknown-id
//   no-op behavior).
// - claim: creation entry points (getOrCreate, prewarmTerminal) assign
//   placement via the policy before delegating; a failed creation releases a
//   placement it claimed.
// - group: multi-id calls partition by owning surface so per-surface batching
//   semantics (coalescing, settle waits) are preserved within each surface.
// - fan-out / sum: whole-project calls hit every surface; numeric aggregates
//   sum across surfaces.
// - tracked: per-id subscriptions are recorded so placement moves rebind them
//   to the new owning surface.
// - aggregate: batch-scoped listeners are owned here and notified exactly
//   once per logical change, however many surfaces exist (Phase 1 watch-list:
//   "aggregate-notify dedup").
export class PaintFabricCompositor implements TerminalPaintPlane {
  private registry = new PaintSurfaceRegistry();
  private choosePlacement: PlacementPolicy;
  private subscriptionsById = new Map<string, Set<TrackedSubscription>>();
  private createArgsById = new Map<string, CapturedCreateArgs>();
  private carriedStateById = new Map<string, CarriedTerminalState>();
  private syncMirrorsById = new Map<string, TerminalSyncMirror>();
  // Compositor-side liveness ledger: ids whose create resolved on SOME
  // surface and that haven't been destroyed since. This is the evidence
  // releaseFailedClaim uses for view surfaces, whose planes cannot answer a
  // synchronous liveness probe across the process boundary.
  private liveTerminalIds = new Set<string>();
  private scrollbackRestoreAggregateListeners = new Set<() => void>();
  private surfaceForwarderUnsubs = new Map<string, () => void>();
  private gridResizeTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly gridResizePendingIds = new Set<string>();

  constructor(options: PaintFabricCompositorOptions) {
    if (options.surfaces.length === 0) {
      throw new Error("PaintFabricCompositor requires at least one surface");
    }
    options.surfaces.forEach((surface, index) =>
      this.registerSurface(surface, { isDefault: index === 0 })
    );
    this.choosePlacement = options.choosePlacement ?? defaultSurfacePlacement;
  }

  getRegistryForTests(): PaintSurfaceRegistry {
    return this.registry;
  }

  // Surfaces can join after construction (a re-hosted crashed surface, a
  // WebContentsView surface finishing its async boot). The forwarder
  // subscription is what lets plane-internal notifications (a destroy mid
  // restore) reach the compositor-owned aggregate listener set.
  registerSurface(surface: PaintSurface, options: { isDefault?: boolean } = {}): void {
    this.registry.registerSurface(surface, options);
    this.surfaceForwarderUnsubs.set(
      surface.id,
      surface.plane.subscribeScrollbackRestoreState(() =>
        this.notifyAggregateScrollbackRestoreListeners()
      )
    );
  }

  private plane(id: string): TerminalPaintPlane {
    return (this.registry.surfaceFor(id) ?? this.registry.defaultSurface()).plane;
  }

  private planes(): TerminalPaintPlane[] {
    return this.registry.surfaces().map((surface) => surface.plane);
  }

  private claim(
    id: string,
    context: PlacementContext
  ): { surface: PaintSurface; claimed: boolean } {
    const existing = this.registry.surfaceFor(id);
    if (existing) return { surface: existing, claimed: false };
    const surface = this.choosePlacement(id, this.registry, context);
    this.registry.place(id, surface.id);
    // Subscriptions made before placement were materialized on the default
    // surface; the terminal is about to exist here instead.
    this.rebindSubscriptions(id, surface.plane);
    return { surface, claimed: true };
  }

  // Overlapping create calls can interleave with a failed sibling's release:
  // call A claims, its build is aborted (destroy-during-create) and its catch
  // releases the placement while call B — which piggybacked on the claim — is
  // still in flight and about to succeed. B's success re-records ownership so
  // a live terminal can never end up unplaced.
  private healPlacement(id: string, surface: PaintSurface): void {
    if (this.registry.surfaceFor(id) === null) {
      this.registry.place(id, surface.id);
    }
  }

  // A failed create only releases the placement it claimed: a transfer may
  // have re-homed the id while the doomed build was still in flight, and an
  // id-keyed release here would strip the NEW surface's ownership. Runs
  // inside the create's catch, so the live-instance probe must never throw —
  // a dead surface would otherwise mask the original create error AND strand
  // the stale placement.
  private releaseFailedClaim(id: string, surface: PaintSurface, claimed: boolean): void {
    if (!claimed) return;
    let liveOnSurface = false;
    if (surfaceKind(surface) === "view") {
      // A view-hosted plane cannot answer a synchronous liveness probe, so
      // consult the compositor's own ledger: an overlapping create that
      // already succeeded marked the id live (and a still-in-flight one will
      // re-record ownership via healPlacement after this release).
      liveOnSurface = this.liveTerminalIds.has(id);
    } else {
      try {
        liveOnSurface = surface.plane.get(id) !== null;
      } catch {
        // Unreadable surface — nothing live worth keeping the claim for.
      }
    }
    if (liveOnSurface) return;
    if (this.registry.surfaceFor(id)?.id !== surface.id) return;
    this.registry.release(id);
  }

  private groupBySurface(ids: string[]): Array<{ plane: TerminalPaintPlane; ids: string[] }> {
    if (this.registry.surfaceCount() === 1) {
      return [{ plane: this.registry.defaultSurface().plane, ids }];
    }
    const groups = new Map<PaintSurface, string[]>();
    for (const id of ids) {
      const surface = this.registry.surfaceFor(id) ?? this.registry.defaultSurface();
      const group = groups.get(surface);
      if (group) group.push(id);
      else groups.set(surface, [id]);
    }
    return Array.from(groups, ([surface, groupIds]) => ({ plane: surface.plane, ids: groupIds }));
  }

  private trackSubscription(
    id: string,
    kind: TrackedSubscription["kind"],
    resubscribe: (plane: TerminalPaintPlane) => () => void
  ): () => void {
    const plane = this.plane(id);
    const entry: TrackedSubscription = {
      kind,
      plane,
      resubscribe,
      unsubscribe: resubscribe(plane),
    };
    let entries = this.subscriptionsById.get(id);
    if (!entries) {
      entries = new Set();
      this.subscriptionsById.set(id, entries);
    }
    entries.add(entry);
    return () => {
      entry.unsubscribe();
      const current = this.subscriptionsById.get(id);
      if (!current) return;
      current.delete(entry);
      if (current.size === 0) this.subscriptionsById.delete(id);
    };
  }

  private rebindSubscriptions(id: string, plane: TerminalPaintPlane): void {
    const entries = this.subscriptionsById.get(id);
    if (!entries) return;
    for (const entry of entries) {
      if (entry.plane === plane) continue;
      entry.unsubscribe();
      entry.plane = plane;
      entry.unsubscribe = entry.resubscribe(plane);
    }
  }

  private dropTerminalBookkeeping(id: string): void {
    const entries = this.subscriptionsById.get(id);
    if (entries) {
      // The owning surface already dropped its listener sets in destroy();
      // releasing our references mirrors the bare service's
      // subscriptions-do-not-survive-destroy semantics.
      for (const entry of entries) entry.unsubscribe();
      this.subscriptionsById.delete(id);
    }
    this.createArgsById.delete(id);
    this.carriedStateById.delete(id);
    this.syncMirrorsById.delete(id);
    this.liveTerminalIds.delete(id);
  }

  private carried(id: string): CarriedTerminalState {
    let state = this.carriedStateById.get(id);
    if (!state) {
      state = {};
      this.carriedStateById.set(id, state);
    }
    return state;
  }

  private owningSurface(id: string): PaintSurface {
    return this.registry.surfaceFor(id) ?? this.registry.defaultSurface();
  }

  private isViewOwned(id: string): boolean {
    return surfaceKind(this.owningSurface(id)) === "view";
  }

  private mirror(id: string): TerminalSyncMirror {
    let mirror = this.syncMirrorsById.get(id);
    if (!mirror) {
      mirror = {};
      this.syncMirrorsById.set(id, mirror);
    }
    return mirror;
  }

  /**
   * State-push entry point for view-hosted surfaces: the surface renderer
   * reports control-path state changes (agent state, focus, buffer snapshot)
   * and the compositor folds them into the sync-read mirror so the sync half
   * of TerminalPaintPlane keeps answering without crossing the process
   * boundary. Skips undefined fields so a partial patch never erases known
   * state. Patches for ids not currently view-owned are dropped — a stale
   * push racing a transfer/destroy must not resurrect mirror state the local
   * plane (or nobody) now owns.
   */
  applyMirrorPatch(id: string, patch: TerminalSyncMirrorPatch): void {
    if (!this.isViewOwned(id)) return;
    const mirror = this.mirror(id);
    if (patch.agentState !== undefined) mirror.agentState = patch.agentState;
    if (patch.focused !== undefined) mirror.focused = patch.focused;
    if (patch.bufferText !== undefined) mirror.bufferText = patch.bufferText;
  }

  getMirrorForTests(id: string): TerminalSyncMirror | undefined {
    return this.syncMirrorsById.get(id);
  }

  private readAgentState(surface: PaintSurface, id: string): AgentState | undefined {
    if (surfaceKind(surface) === "view") return this.syncMirrorsById.get(id)?.agentState;
    return surface.plane.getAgentState(id);
  }

  private readFocused(surface: PaintSurface, id: string): boolean {
    if (surfaceKind(surface) === "view") return this.syncMirrorsById.get(id)?.focused ?? false;
    return surface.plane.isFocused(id);
  }

  /**
   * Cross-surface re-parent: re-create the terminal on the target surface
   * from its captured creation args, restore the pty-host's canonical
   * serialized scrollback (the host owns the bytes, which is what makes the
   * move byte-for-byte), carry visibility/tier/promotion/agent state across,
   * and rebind every tracked subscription. The pty itself never stops — only
   * the renderer-side xterm instance moves.
   *
   * Returns true when a live terminal moved, false for a placement-only move
   * (no live instance yet) or a same-surface no-op.
   */
  async transferTerminal(id: string, targetSurfaceId: string): Promise<boolean> {
    const target = this.registry.surfaceById(targetSurfaceId);
    if (!target) {
      throw new Error(`Unknown paint surface: ${targetSurfaceId}`);
    }
    const source = this.registry.surfaceFor(id) ?? this.registry.defaultSurface();
    if (source.id === target.id) return false;
    return this.moveTerminal(id, source, target, { bestEffortSource: false });
  }

  private async moveTerminal(
    id: string,
    source: PaintSurface,
    target: PaintSurface,
    opts: { bestEffortSource: boolean }
  ): Promise<boolean> {
    const sourceCall = <T>(read: () => T, fallback: T): T => {
      if (!opts.bestEffortSource) return read();
      try {
        return read();
      } catch (error) {
        logWarn("Paint fabric: source surface call failed during move", { id, error });
        return fallback;
      }
    };

    let live: ManagedTerminal | null = null;
    let assumeLive = false;
    let sourceUnreadable = false;
    if (surfaceKind(source) === "view") {
      // No ManagedTerminal exists across a process boundary, so a view-hosted
      // source cannot answer a liveness probe; the compositor's own ledger
      // (marked on create success, cleared on destroy) decides whether the
      // move is a rebuild or placement-only.
      assumeLive = this.liveTerminalIds.has(id);
    } else if (opts.bestEffortSource) {
      try {
        live = source.plane.get(id);
      } catch (error) {
        // A crashed surface cannot answer; if the fabric created this
        // terminal (args captured), assume it was live and rebuild it on the
        // target — the "never drop a terminal" half of retireSurface.
        sourceUnreadable = true;
        logWarn("Paint fabric: source surface unreadable during move", { id, error });
      }
    } else {
      live = source.plane.get(id);
    }

    const args = this.createArgsById.get(id);
    const rebuild = live !== null || assumeLive || (sourceUnreadable && args !== undefined);
    if (!rebuild) {
      // Placement-only move. Destroy on the source anyway: an in-flight
      // getOrCreate may have claimed this id without a live instance yet, and
      // destroy-during-create cancels that build (a no-op for unknown ids) so
      // the old surface can never end up holding a live terminal the
      // registry routes elsewhere.
      sourceCall(() => source.plane.destroy(id), undefined);
      this.registry.release(id);
      this.registry.place(id, target.id);
      this.rebindSubscriptions(id, target.plane);
      return false;
    }

    if (!args) {
      throw new Error(
        `Cannot transfer terminal ${id}: it was not created through the fabric, so its creation args are unknown`
      );
    }

    const agentState = sourceCall(() => this.readAgentState(source, id), undefined);
    const focused = sourceCall(() => this.readFocused(source, id), false);
    sourceCall(() => source.plane.destroy(id), undefined);
    this.registry.release(id);
    this.registry.place(id, target.id);

    try {
      await target.plane.getOrCreate(
        id,
        args.launchAgentId,
        args.options,
        args.getRefreshTier,
        args.onInput,
        args.getCwd
      );
    } catch (error) {
      // The terminal now exists nowhere; drop the placement so the caller's
      // retry (a fresh getOrCreate) claims cleanly instead of routing to a
      // surface that never built it. The mirror and liveness ledger drop
      // with it — stale agent/focus/buffer state must not answer for a
      // terminal that no longer exists anywhere.
      this.registry.release(id);
      this.syncMirrorsById.delete(id);
      this.liveTerminalIds.delete(id);
      throw error;
    }

    const restored = await target.plane.fetchAndRestore(id);
    if (!restored) {
      logWarn("Paint fabric: scrollback restore failed after cross-surface move", { id });
    }

    const carried = this.carriedStateById.get(id);
    if (carried?.backendTier !== undefined) {
      target.plane.initializeBackendTier(id, carried.backendTier);
    }
    if (carried?.visible !== undefined) target.plane.setVisible(id, carried.visible);
    if (carried?.rendererTier !== undefined) {
      target.plane.applyRendererPolicy(id, carried.rendererTier);
    }
    // null records an explicit clearAgentPromotion — re-clear on the target,
    // because getOrCreate with the captured launchAgentId re-promotes.
    if (typeof carried?.promotedAgentId === "string") {
      target.plane.applyAgentPromotion(id, carried.promotedAgentId);
    } else if (carried?.promotedAgentId === null) {
      target.plane.clearAgentPromotion(id);
    }
    if (carried?.inputLocked !== undefined) target.plane.setInputLocked(id, carried.inputLocked);
    if (agentState !== undefined) target.plane.setAgentState(id, agentState);
    // Keep the sync-read mirror consistent with the new owner: a view-hosted
    // target answers sync reads from the mirror, so seed it with the state
    // the move carried; a local target is authoritative, so the mirror drops.
    if (surfaceKind(target) === "view") {
      this.applyMirrorPatch(id, { agentState, focused });
    } else {
      this.syncMirrorsById.delete(id);
    }
    this.rebindSubscriptions(id, target.plane);
    if (focused) {
      target.plane.setFocused(id, true);
      target.plane.focus(id);
    }
    return true;
  }

  /**
   * Phase 3 resilience: evacuate every terminal from a surface onto its
   * least-loaded siblings (best-effort reads from the source, which may be a
   * crashed view), then unregister it. Terminals are never dropped — the
   * fallback direction is always co-location, degrading toward the single
   * surface view (docs/architecture/terminal-paint-fabric.md, kill switches).
   * Returns the ids that were re-homed.
   */
  async retireSurface(surfaceId: string): Promise<string[]> {
    const source = this.registry.surfaceById(surfaceId);
    if (!source) {
      throw new Error(`Unknown paint surface: ${surfaceId}`);
    }
    if (this.registry.defaultSurface().id === surfaceId) {
      throw new Error(`Cannot retire the default paint surface: ${surfaceId}`);
    }
    const evacuees = this.registry.placementsFor(surfaceId);
    for (const id of evacuees) {
      // Choose per-terminal so load spreads instead of dogpiling the first
      // sibling; exclude the dying surface by choosing among the others.
      const target = this.chooseSiblingSurface(surfaceId, id);
      await this.moveTerminal(id, source, target, { bestEffortSource: true });
    }
    this.registry.unregisterSurface(surfaceId);
    this.surfaceForwarderUnsubs.get(surfaceId)?.();
    this.surfaceForwarderUnsubs.delete(surfaceId);
    try {
      source.plane.dispose();
    } catch (error) {
      logWarn("Paint fabric: disposing retired surface failed", { surfaceId, error });
    }
    return evacuees;
  }

  private chooseSiblingSurface(excludeSurfaceId: string, _terminalId: string): PaintSurface {
    let best: PaintSurface | null = null;
    let bestCount = Number.POSITIVE_INFINITY;
    for (const surface of this.registry.surfaces()) {
      if (surface.id === excludeSurfaceId) continue;
      const count = this.registry.placementCount(surface.id);
      if (count < bestCount) {
        best = surface;
        bestCount = count;
      }
    }
    if (!best) {
      throw new Error("Paint fabric has no sibling surface to co-locate onto");
    }
    return best;
  }

  /**
   * Per-surface breakdown for the project diagnostics view (Phase 3): the
   * project's health is worst-surface plus this breakdown, not one blended
   * number that hides a struggling surface behind a healthy one.
   */
  getSurfaceDiagnostics(): PaintSurfaceDiagnostics[] {
    const defaultId = this.registry.defaultSurface().id;
    return this.registry.surfaces().map((surface) => ({
      surfaceId: surface.id,
      isDefault: surface.id === defaultId,
      terminalCount: this.registry.placementCount(surface.id),
      scrollbackRestorePendingCount: surface.plane.getScrollbackRestorePendingCount(),
      scrollbackRestoreInProgressCount: surface.plane.getScrollbackRestoreInProgressCount(),
    }));
  }

  setGPUHardwareAvailable(available: boolean): void {
    this.planes().forEach((plane) => plane.setGPUHardwareAvailable(available));
  }

  refreshWebGLMode(): void {
    this.planes().forEach((plane) => plane.refreshWebGLMode());
  }

  notifyUserInput(id: string, data?: string): void {
    this.plane(id).notifyUserInput(id, data);
  }

  notifyEnterPressed(id: string): void {
    this.plane(id).notifyEnterPressed(id);
  }

  // The remaining sync reads return documented safe defaults for view-owned
  // terminals: hover/selection are DOM-local concerns the surface view
  // handles on its own side, and renderer-internal flags (hibernation, WebGL
  // activity, alt-buffer) read as inactive until the wiring front extends the
  // mirror to carry the ones that prove load-bearing cross-view.
  getHoveredLinkText(id: string): string | null {
    if (this.isViewOwned(id)) return null;
    return this.plane(id).getHoveredLinkText(id);
  }

  getHoveredFilePath(id: string): string | null {
    if (this.isViewOwned(id)) return null;
    return this.plane(id).getHoveredFilePath(id);
  }

  getHoveredFileKind(id: string): "file" | "directory" | null {
    if (this.isViewOwned(id)) return null;
    return this.plane(id).getHoveredFileKind(id);
  }

  openHoveredLink(id: string, event?: MouseEvent): Promise<void> {
    return this.plane(id).openHoveredLink(id, event);
  }

  clearDirectingState(id: string): void {
    this.plane(id).clearDirectingState(id);
  }

  async prewarmTerminal(
    id: string,
    launchAgentId: string | undefined,
    options: ConstructorParameters<typeof Terminal>[0],
    params?: { offscreen?: boolean; widthPx?: number; heightPx?: number }
  ): Promise<ManagedTerminal> {
    const { surface, claimed } = this.claim(id, { launchAgentId, options });
    this.createArgsById.set(id, { launchAgentId, options });
    try {
      const managed = await surface.plane.prewarmTerminal(id, launchAgentId, options, params);
      this.healPlacement(id, surface);
      this.liveTerminalIds.add(id);
      return managed;
    } catch (error) {
      this.releaseFailedClaim(id, surface, claimed);
      throw error;
    }
  }

  suppressNextExit(id: string, ttlMs?: number): void {
    this.plane(id).suppressNextExit(id, ttlMs);
  }

  stopPolling(): void {
    this.planes().forEach((plane) => plane.stopPolling());
  }

  setVisible(id: string, isVisible: boolean, expectedGeneration?: number): void {
    this.carried(id).visible = isVisible;
    this.plane(id).setVisible(id, isVisible, expectedGeneration);
  }

  lockResize(id: string, locked: boolean, customTtlMs?: number): void {
    this.plane(id).lockResize(id, locked, customTtlMs);
  }

  suppressResizesDuringLayoutTransition(panelIds: string[], durationMs: number): void {
    this.groupBySurface(panelIds).forEach(({ plane, ids }) =>
      plane.suppressResizesDuringLayoutTransition(ids, durationMs)
    );
  }

  suppressResizesDuringProjectSwitch(panelIds: string[], durationMs: number): void {
    this.groupBySurface(panelIds).forEach(({ plane, ids }) =>
      plane.suppressResizesDuringProjectSwitch(ids, durationMs)
    );
  }

  setTargetSize(id: string, cols: number, rows: number): void {
    this.plane(id).setTargetSize(id, cols, rows);
  }

  clearResizeSuppression(id: string): void {
    this.plane(id).clearResizeSuppression(id);
  }

  wake(id: string): boolean {
    return this.plane(id).wake(id);
  }

  wakeForFocus(id: string): void {
    this.plane(id).wakeForFocus(id);
  }

  fullWakeForVisibilityRestore(id: string): Promise<void> {
    return this.plane(id).fullWakeForVisibilityRestore(id);
  }

  repaintForReveal(id: string, opts?: { trustDomVisibility?: boolean }): boolean {
    return this.plane(id).repaintForReveal(id, opts);
  }

  reconcileRevealGeometry(id: string): boolean {
    return this.plane(id).reconcileRevealGeometry(id);
  }

  revealTerminal(id: string): Promise<boolean> {
    return this.plane(id).revealTerminal(id);
  }

  injectDataLossMarker(id: string, droppedBytes: number): void {
    this.plane(id).injectDataLossMarker(id, droppedBytes);
  }

  async getOrCreate(
    id: string,
    launchAgentId: string | undefined,
    options: ConstructorParameters<typeof Terminal>[0],
    getRefreshTier?: RefreshTierProvider,
    onInput?: (data: string) => void,
    getCwd?: () => string
  ): Promise<ManagedTerminal> {
    const { surface, claimed } = this.claim(id, { launchAgentId, options });
    this.createArgsById.set(id, {
      launchAgentId,
      options,
      getRefreshTier,
      onInput,
      getCwd,
    });
    try {
      const managed = await surface.plane.getOrCreate(
        id,
        launchAgentId,
        options,
        getRefreshTier,
        onInput,
        getCwd
      );
      this.healPlacement(id, surface);
      this.liveTerminalIds.add(id);
      return managed;
    } catch (error) {
      this.releaseFailedClaim(id, surface, claimed);
      throw error;
    }
  }

  get(id: string): ManagedTerminal | null {
    // A view-hosted surface has no live ManagedTerminal in this process —
    // callers needing state go through the mirror-backed sync reads instead.
    if (this.isViewOwned(id)) return null;
    return this.plane(id).get(id);
  }

  getInstanceForE2E(id: string): ManagedTerminal | undefined {
    if (this.isViewOwned(id)) return undefined;
    return this.plane(id).getInstanceForE2E(id);
  }

  getWebGLStateForE2E(id: string): { wantsSize: number; active: boolean; mode: string } {
    return this.plane(id).getWebGLStateForE2E(id);
  }

  triggerTerminalLinkForE2E(id: string, url: string, event?: MouseEvent): void {
    this.plane(id).triggerTerminalLinkForE2E(id, url, event);
  }

  getCachedSelection(id: string): string {
    if (this.isViewOwned(id)) return "";
    return this.plane(id).getCachedSelection(id);
  }

  waitForInstance(id: string, options?: { timeoutMs?: number }): Promise<void> {
    return this.plane(id).waitForInstance(id, options);
  }

  waitForAttachSettled(id: string, options?: { timeoutMs?: number }): Promise<void> {
    return this.plane(id).waitForAttachSettled(id, options);
  }

  waitForFullySettled(id: string, options?: { timeoutMs?: number }): Promise<void> {
    return this.plane(id).waitForFullySettled(id, options);
  }

  async waitForAllFullySettled(ids: string[], options?: { timeoutMs?: number }): Promise<void> {
    await Promise.all(
      this.groupBySurface(ids).map(({ plane, ids: group }) =>
        plane.waitForAllFullySettled(group, options)
      )
    );
  }

  notifyRestoreSettledWaiters(id: string): void {
    this.plane(id).notifyRestoreSettledWaiters(id);
  }

  attach(id: string, container: HTMLElement): ManagedTerminal | null {
    // DOM attachment cannot cross views: a view-hosted terminal's geometry
    // flows through the surface-view bounds protocol
    // (shared/types/paintFabricSurface.ts), not a container element.
    if (this.isViewOwned(id)) return null;
    return this.plane(id).attach(id, container);
  }

  getAttachGeneration(id: string): number {
    if (this.isViewOwned(id)) return 0;
    return this.plane(id).getAttachGeneration(id);
  }

  detach(id: string, container: HTMLElement | null): void {
    if (this.isViewOwned(id)) return;
    this.plane(id).detach(id, container);
  }

  detachForProjectSwitch(id: string): void {
    this.plane(id).detachForProjectSwitch(id);
  }

  fit(id: string): { cols: number; rows: number } | null {
    // Sync geometry cannot cross a process boundary; view-hosted surfaces
    // size their terminals from the bounds protocol on their side.
    if (this.isViewOwned(id)) return null;
    return this.plane(id).fit(id);
  }

  flushResize(id: string): void {
    this.plane(id).flushResize(id);
  }

  cancelPendingResize(id: string): void {
    this.plane(id).cancelPendingResize(id);
  }

  sendPtyResize(id: string, cols: number, rows: number): void {
    this.plane(id).sendPtyResize(id, cols, rows);
  }

  resize(
    id: string,
    width: number,
    height: number,
    options?: { immediate?: boolean }
  ): { cols: number; rows: number } | null {
    if (this.isViewOwned(id)) return null;
    return this.plane(id).resize(id, width, height, options);
  }

  applyBackgroundWindowResize(width: number, height: number): void {
    this.planes().forEach((plane) => plane.applyBackgroundWindowResize(width, height));
  }

  resetBackgroundResizeBasis(): void {
    this.planes().forEach((plane) => plane.resetBackgroundResizeBasis());
  }

  // Cross-surface pass coalescing happens here, on the bare service's exact
  // timing, so one logical burst becomes ONE logical pass partitioned across
  // surfaces — per-surface timers would turn one burst into K passes that
  // supersede each other's chunked work (Phase 1 watch-list: "cross-surface
  // resize-pass coordination").
  scheduleBatchResize(ids: string[]): void {
    if (ids.length === 0) return;
    for (const id of ids) this.gridResizePendingIds.add(id);
    if (this.gridResizeTimer !== undefined) {
      clearTimeout(this.gridResizeTimer);
    }
    this.gridResizeTimer = setTimeout(() => {
      this.gridResizeTimer = undefined;
      const pendingIds = [...this.gridResizePendingIds];
      this.gridResizePendingIds.clear();
      scheduleFrame(() => this.runResizePass(pendingIds));
    }, GRID_RESIZE_COALESCE_MS);
  }

  // One logical pass may span several surfaces, but callers are allowed to
  // request a scoped subset (for example a two-pane divider). Dispatch each
  // shard without cancelling absent surfaces: their pending ids are still
  // fresh-measurement obligations and must survive an unrelated narrower
  // pass. Call cancelActiveResizePass() explicitly when all active surface
  // work is genuinely invalid.
  runResizePass(ids: string[]): void {
    if (ids.length === 0) return;
    const groups = this.groupBySurface(ids);
    groups.forEach(({ plane, ids: group }) => plane.runResizePass(group));
  }

  cancelActiveResizePass(): void {
    this.planes().forEach((plane) => plane.cancelActiveResizePass());
  }

  scrollToBottom(id: string): void {
    this.plane(id).scrollToBottom(id);
  }

  scrollToLastActivity(id: string): void {
    this.plane(id).scrollToLastActivity(id);
  }

  subscribeUnseenOutput(id: string, listener: () => void): () => void {
    return this.trackSubscription(id, "unseenOutput", (plane) =>
      plane.subscribeUnseenOutput(id, listener)
    );
  }

  subscribeHibernation(id: string, listener: () => void): () => void {
    return this.trackSubscription(id, "hibernation", (plane) =>
      plane.subscribeHibernation(id, listener)
    );
  }

  // Aggregate (batch-scoped) listeners are compositor-owned: one logical
  // state change notifies each listener exactly once, however many surfaces
  // exist. Per-surface forwarders (registerSurface) route plane-internal
  // notifications (destroy-during-restore) into the same set.
  subscribeScrollbackRestoreState(listener: () => void): () => void {
    this.scrollbackRestoreAggregateListeners.add(listener);
    return () => {
      this.scrollbackRestoreAggregateListeners.delete(listener);
    };
  }

  notifyScrollbackRestoreListeners(): void {
    this.notifyAggregateScrollbackRestoreListeners();
  }

  private notifyAggregateScrollbackRestoreListeners(): void {
    for (const listener of this.scrollbackRestoreAggregateListeners) {
      try {
        listener();
      } catch (error) {
        logWarn("Scrollback restore listener error", { error });
      }
    }
  }

  getScrollbackRestorePendingCount(): number {
    return this.planes().reduce((sum, plane) => sum + plane.getScrollbackRestorePendingCount(), 0);
  }

  getScrollbackRestoreInProgressCount(): number {
    return this.planes().reduce(
      (sum, plane) => sum + plane.getScrollbackRestoreInProgressCount(),
      0
    );
  }

  getScrollbackRestoreTotalCount(): number {
    return this.planes().reduce((sum, plane) => sum + plane.getScrollbackRestoreTotalCount(), 0);
  }

  getUnseenOutputSnapshot(id: string): UnseenOutputSnapshot {
    return this.plane(id).getUnseenOutputSnapshot(id);
  }

  getLastWheelAt(id: string): number {
    return this.plane(id).getLastWheelAt(id);
  }

  resumeAutoScroll(id: string): void {
    this.plane(id).resumeAutoScroll(id);
  }

  setAgentState(id: string, state: AgentState): void {
    if (this.isViewOwned(id)) this.mirror(id).agentState = state;
    this.plane(id).setAgentState(id, state);
  }

  addAltBufferListener(id: string, callback: (isAltBuffer: boolean) => void): () => void {
    return this.trackSubscription(id, "altBuffer", (plane) =>
      plane.addAltBufferListener(id, callback)
    );
  }

  getAltBufferState(id: string): boolean {
    if (this.isViewOwned(id)) return false;
    return this.plane(id).getAltBufferState(id);
  }

  getSynchronizedOutputMode(id: string): boolean | null {
    if (this.isViewOwned(id)) return null;
    return this.plane(id).getSynchronizedOutputMode(id);
  }

  getAgentState(id: string): AgentState | undefined {
    return this.readAgentState(this.owningSurface(id), id);
  }

  addAgentStateListener(id: string, callback: AgentStateCallback): () => void {
    return this.trackSubscription(id, "agentState", (plane) =>
      plane.addAgentStateListener(id, callback)
    );
  }

  captureBufferText(id: string, maxChars?: number): string {
    if (this.isViewOwned(id)) {
      // Match the bare service's boundary semantics: default capture window
      // of 20000 chars (TerminalInstanceService.captureBufferText), nothing
      // for a non-positive budget, tail-truncated like the bottom-up scan.
      const limit = maxChars ?? 20_000;
      if (limit <= 0) return "";
      const text = this.syncMirrorsById.get(id)?.bufferText ?? "";
      return text.slice(-limit);
    }
    return this.plane(id).captureBufferText(id, maxChars);
  }

  registerPostCompleteHook(id: string, callback: PostCompleteHook): () => void {
    return this.trackSubscription(id, "postCompleteHook", (plane) =>
      plane.registerPostCompleteHook(id, callback)
    );
  }

  unregisterPostCompleteHook(id: string): void {
    this.plane(id).unregisterPostCompleteHook(id);
    // Drop the tracked entries too, or a later move would resurrect a hook
    // the caller explicitly unregistered.
    const entries = this.subscriptionsById.get(id);
    if (!entries) return;
    for (const entry of entries) {
      if (entry.kind !== "postCompleteHook") continue;
      entries.delete(entry);
    }
    if (entries.size === 0) this.subscriptionsById.delete(id);
  }

  setFocused(id: string, isFocused: boolean): void {
    if (this.isViewOwned(id)) this.mirror(id).focused = isFocused;
    this.plane(id).setFocused(id, isFocused);
  }

  isFocused(id: string): boolean {
    return this.readFocused(this.owningSurface(id), id);
  }

  focus(id: string): void {
    this.plane(id).focus(id);
  }

  resetRenderer(id: string): boolean {
    return this.plane(id).resetRenderer(id);
  }

  handleBackendRecovery(): void {
    this.planes().forEach((plane) => plane.handleBackendRecovery());
  }

  // Option updates fold into the captured create-args so a later transfer
  // rebuilds the terminal with its CURRENT options, not its original ones.
  updateOptions(id: string, options: Partial<Terminal["options"]>): void {
    const args = this.createArgsById.get(id);
    if (args) args.options = { ...args.options, ...options };
    this.plane(id).updateOptions(id, options);
  }

  applyGlobalOptions(options: Partial<Terminal["options"]>): void {
    for (const args of this.createArgsById.values()) {
      args.options = { ...args.options, ...options };
    }
    this.planes().forEach((plane) => plane.applyGlobalOptions(options));
  }

  repairFontGrid(): void {
    this.planes().forEach((plane) => plane.repairFontGrid());
  }

  applyRendererPolicy(id: string, tier: TerminalRefreshTier): void {
    this.carried(id).rendererTier = tier;
    this.plane(id).applyRendererPolicy(id, tier);
  }

  updateRefreshTierProvider(id: string, provider: RefreshTierProvider): void {
    const args = this.createArgsById.get(id);
    if (args) args.getRefreshTier = provider;
    this.plane(id).updateRefreshTierProvider(id, provider);
  }

  boostRefreshRate(id: string): void {
    this.plane(id).boostRefreshRate(id);
  }

  initializeBackendTier(id: string, tier: "active" | "background"): void {
    this.carried(id).backendTier = tier;
    this.plane(id).initializeBackendTier(id, tier);
  }

  reduceScrollback(id: string, targetLines: number): void {
    this.plane(id).reduceScrollback(id, targetLines);
  }

  restoreScrollback(id: string): void {
    this.plane(id).restoreScrollback(id);
  }

  applyAgentPromotion(id: string, agentId: string): void {
    this.carried(id).promotedAgentId = agentId;
    this.plane(id).applyAgentPromotion(id, agentId);
  }

  clearAgentPromotion(id: string): void {
    this.carried(id).promotedAgentId = null;
    this.plane(id).clearAgentPromotion(id);
  }

  restoreScrollbackAllForeground(): void {
    this.planes().forEach((plane) => plane.restoreScrollbackAllForeground());
  }

  addExitListener(id: string, cb: (exitCode: number) => void): () => void {
    return this.trackSubscription(id, "exit", (plane) => plane.addExitListener(id, cb));
  }

  isHibernated(id: string): boolean {
    if (this.isViewOwned(id)) return false;
    return this.plane(id).isHibernated(id);
  }

  isWebGLActive(id: string): boolean {
    if (this.isViewOwned(id)) return false;
    return this.plane(id).isWebGLActive(id);
  }

  destroy(id: string): void {
    this.plane(id).destroy(id);
    this.registry.release(id);
    this.dropTerminalBookkeeping(id);
  }

  dispose(): void {
    if (this.gridResizeTimer !== undefined) {
      clearTimeout(this.gridResizeTimer);
      this.gridResizeTimer = undefined;
    }
    this.gridResizePendingIds.clear();
    this.surfaceForwarderUnsubs.forEach((unsubscribe) => unsubscribe());
    this.surfaceForwarderUnsubs.clear();
    this.planes().forEach((plane) => plane.dispose());
    this.registry.releaseAll();
    this.subscriptionsById.clear();
    this.createArgsById.clear();
    this.carriedStateById.clear();
    this.syncMirrorsById.clear();
    this.liveTerminalIds.clear();
    this.scrollbackRestoreAggregateListeners.clear();
  }

  restoreFetchedState(
    id: string,
    serializedState: string | null,
    captureGeometry?: TerminalGeometry
  ): Promise<boolean> {
    return this.plane(id).restoreFetchedState(id, serializedState, captureGeometry);
  }

  fetchAndRestore(id: string): Promise<boolean> {
    return this.plane(id).fetchAndRestore(id);
  }

  restoreFromSerialized(
    id: string,
    serializedState: string,
    captureGeometry?: TerminalGeometry
  ): boolean {
    return this.plane(id).restoreFromSerialized(id, serializedState, captureGeometry);
  }

  restoreFromSerializedIncremental(
    id: string,
    serializedState: string,
    captureGeometry?: TerminalGeometry
  ): Promise<boolean> {
    return this.plane(id).restoreFromSerializedIncremental(id, serializedState, captureGeometry);
  }

  setInputLocked(id: string, locked: boolean): void {
    this.carried(id).inputLocked = locked;
    this.plane(id).setInputLocked(id, locked);
  }
}
