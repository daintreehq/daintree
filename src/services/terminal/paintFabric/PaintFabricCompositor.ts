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
import type { TerminalPaintPlane } from "../TerminalInstanceService";
import { logWarn } from "@/utils/logger";
import { PaintSurfaceRegistry, type PaintSurface } from "./PaintSurfaceRegistry";
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

export interface PaintSurfaceDiagnostics {
  surfaceId: string;
  isDefault: boolean;
  terminalCount: number;
  scrollbackRestorePendingCount: number;
  scrollbackRestoreInProgressCount: number;
}

// requestAnimationFrame exists in every real renderer; the timeout fallback
// keeps the coalescing path deterministic under Node-environment tests.
const scheduleFrame: (callback: () => void) => void =
  typeof requestAnimationFrame === "function"
    ? (callback) => void requestAnimationFrame(() => callback())
    : (callback) => void setTimeout(callback, 16);

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
  }

  private carried(id: string): CarriedTerminalState {
    let state = this.carriedStateById.get(id);
    if (!state) {
      state = {};
      this.carriedStateById.set(id, state);
    }
    return state;
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

    const live = sourceCall(() => source.plane.get(id), null);
    if (!live) {
      this.registry.release(id);
      this.registry.place(id, target.id);
      this.rebindSubscriptions(id, target.plane);
      return false;
    }

    const args = this.createArgsById.get(id);
    if (!args) {
      throw new Error(
        `Cannot transfer terminal ${id}: it was not created through the fabric, so its creation args are unknown`
      );
    }

    const agentState = sourceCall(() => source.plane.getAgentState(id), undefined);
    const focused = sourceCall(() => source.plane.isFocused(id), false);
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
      // surface that never built it.
      this.registry.release(id);
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
    if (carried?.promotedAgentId != null) {
      target.plane.applyAgentPromotion(id, carried.promotedAgentId);
    }
    if (carried?.inputLocked !== undefined) target.plane.setInputLocked(id, carried.inputLocked);
    if (agentState !== undefined) target.plane.setAgentState(id, agentState);
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

  getHoveredLinkText(id: string): string | null {
    return this.plane(id).getHoveredLinkText(id);
  }

  getHoveredFilePath(id: string): string | null {
    return this.plane(id).getHoveredFilePath(id);
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
      return managed;
    } catch (error) {
      if (claimed && !surface.plane.get(id)) this.registry.release(id);
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

  wake(id: string): void {
    this.plane(id).wake(id);
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
      return managed;
    } catch (error) {
      if (claimed && !surface.plane.get(id)) this.registry.release(id);
      throw error;
    }
  }

  get(id: string): ManagedTerminal | null {
    return this.plane(id).get(id);
  }

  getInstanceForE2E(id: string): ManagedTerminal | undefined {
    return this.plane(id).getInstanceForE2E(id);
  }

  getWebGLStateForE2E(id: string): { wantsSize: number; active: boolean; mode: string } {
    return this.plane(id).getWebGLStateForE2E(id);
  }

  triggerTerminalLinkForE2E(id: string, url: string, event?: MouseEvent): void {
    this.plane(id).triggerTerminalLinkForE2E(id, url, event);
  }

  getCachedSelection(id: string): string {
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
    return this.plane(id).attach(id, container);
  }

  getAttachGeneration(id: string): number {
    return this.plane(id).getAttachGeneration(id);
  }

  detach(id: string, container: HTMLElement | null): void {
    this.plane(id).detach(id, container);
  }

  detachForProjectSwitch(id: string): void {
    this.plane(id).detachForProjectSwitch(id);
  }

  fit(id: string): { cols: number; rows: number } | null {
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

  // One logical pass spans every surface: surfaces receiving ids supersede
  // their own in-flight pass (the service's per-instance abort), and surfaces
  // with no ids in this pass get an explicit cancel so their stale chunked
  // work cannot keep reflowing a survivor set the fabric has already moved
  // past. Shards of the same logical pass are dispatched together and never
  // cancel each other.
  runResizePass(ids: string[]): void {
    if (ids.length === 0) return;
    const groups = this.groupBySurface(ids);
    if (this.registry.surfaceCount() > 1) {
      const inPass = new Set(groups.map((group) => group.plane));
      for (const plane of this.planes()) {
        if (!inPass.has(plane)) plane.cancelActiveResizePass();
      }
    }
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
    this.plane(id).setAgentState(id, state);
  }

  addAltBufferListener(id: string, callback: (isAltBuffer: boolean) => void): () => void {
    return this.trackSubscription(id, "altBuffer", (plane) =>
      plane.addAltBufferListener(id, callback)
    );
  }

  getAltBufferState(id: string): boolean {
    return this.plane(id).getAltBufferState(id);
  }

  getSynchronizedOutputMode(id: string): boolean | null {
    return this.plane(id).getSynchronizedOutputMode(id);
  }

  getAgentState(id: string): AgentState | undefined {
    return this.plane(id).getAgentState(id);
  }

  addAgentStateListener(id: string, callback: AgentStateCallback): () => void {
    return this.trackSubscription(id, "agentState", (plane) =>
      plane.addAgentStateListener(id, callback)
    );
  }

  captureBufferText(id: string, maxChars?: number): string {
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
    this.plane(id).setFocused(id, isFocused);
  }

  isFocused(id: string): boolean {
    return this.plane(id).isFocused(id);
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

  updateOptions(id: string, options: Partial<Terminal["options"]>): void {
    this.plane(id).updateOptions(id, options);
  }

  applyGlobalOptions(options: Partial<Terminal["options"]>): void {
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
    return this.plane(id).isHibernated(id);
  }

  isWebGLActive(id: string): boolean {
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
    this.scrollbackRestoreAggregateListeners.clear();
  }

  restoreFetchedState(id: string, serializedState: string | null): Promise<boolean> {
    return this.plane(id).restoreFetchedState(id, serializedState);
  }

  fetchAndRestore(id: string): Promise<boolean> {
    return this.plane(id).fetchAndRestore(id);
  }

  restoreFromSerialized(id: string, serializedState: string): boolean {
    return this.plane(id).restoreFromSerialized(id, serializedState);
  }

  restoreFromSerializedIncremental(id: string, serializedState: string): Promise<boolean> {
    return this.plane(id).restoreFromSerializedIncremental(id, serializedState);
  }

  setInputLocked(id: string, locked: boolean): void {
    this.carried(id).inputLocked = locked;
    this.plane(id).setInputLocked(id, locked);
  }
}
