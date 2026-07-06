import type { Terminal } from "@xterm/xterm";
import type { AgentState, TerminalRefreshTier } from "@/types";
import type {
  ManagedTerminal,
  RefreshTierProvider,
  AgentStateCallback,
  PostCompleteHook,
} from "../types";
import type { UnseenOutputSnapshot } from "../TerminalUnseenOutputTracker";
import type { TerminalPaintPlane } from "../TerminalInstanceService";
import { PaintSurfaceRegistry, type PaintSurface } from "./PaintSurfaceRegistry";

export type PlacementPolicy = (terminalId: string, registry: PaintSurfaceRegistry) => PaintSurface;

interface PaintFabricCompositorOptions {
  // First surface is the default. Phase 0 passes exactly one.
  surfaces: PaintSurface[];
  choosePlacement?: PlacementPolicy;
}

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
export class PaintFabricCompositor implements TerminalPaintPlane {
  private registry = new PaintSurfaceRegistry();
  private choosePlacement: PlacementPolicy;

  constructor(options: PaintFabricCompositorOptions) {
    if (options.surfaces.length === 0) {
      throw new Error("PaintFabricCompositor requires at least one surface");
    }
    options.surfaces.forEach((surface, index) =>
      this.registry.registerSurface(surface, { isDefault: index === 0 })
    );
    this.choosePlacement = options.choosePlacement ?? ((_, registry) => registry.defaultSurface());
  }

  getRegistryForTests(): PaintSurfaceRegistry {
    return this.registry;
  }

  private plane(id: string): TerminalPaintPlane {
    return (this.registry.surfaceFor(id) ?? this.registry.defaultSurface()).plane;
  }

  private planes(): TerminalPaintPlane[] {
    return this.registry.surfaces().map((surface) => surface.plane);
  }

  private claim(id: string): { surface: PaintSurface; claimed: boolean } {
    const existing = this.registry.surfaceFor(id);
    if (existing) return { surface: existing, claimed: false };
    const surface = this.choosePlacement(id, this.registry);
    this.registry.place(id, surface.id);
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
    const { surface, claimed } = this.claim(id);
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
    const { surface, claimed } = this.claim(id);
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

  scheduleBatchResize(ids: string[]): void {
    this.groupBySurface(ids).forEach(({ plane, ids: group }) => plane.scheduleBatchResize(group));
  }

  runResizePass(ids: string[]): void {
    this.groupBySurface(ids).forEach(({ plane, ids: group }) => plane.runResizePass(group));
  }

  scrollToBottom(id: string): void {
    this.plane(id).scrollToBottom(id);
  }

  scrollToLastActivity(id: string): void {
    this.plane(id).scrollToLastActivity(id);
  }

  subscribeUnseenOutput(id: string, listener: () => void): () => void {
    return this.plane(id).subscribeUnseenOutput(id, listener);
  }

  subscribeHibernation(id: string, listener: () => void): () => void {
    return this.plane(id).subscribeHibernation(id, listener);
  }

  subscribeScrollbackRestoreState(listener: () => void): () => void {
    const unsubscribes = this.planes().map((plane) =>
      plane.subscribeScrollbackRestoreState(listener)
    );
    return () => unsubscribes.forEach((unsubscribe) => unsubscribe());
  }

  notifyScrollbackRestoreListeners(): void {
    this.planes().forEach((plane) => plane.notifyScrollbackRestoreListeners());
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
    return this.plane(id).addAltBufferListener(id, callback);
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
    return this.plane(id).addAgentStateListener(id, callback);
  }

  captureBufferText(id: string, maxChars?: number): string {
    return this.plane(id).captureBufferText(id, maxChars);
  }

  registerPostCompleteHook(id: string, callback: PostCompleteHook): () => void {
    return this.plane(id).registerPostCompleteHook(id, callback);
  }

  unregisterPostCompleteHook(id: string): void {
    this.plane(id).unregisterPostCompleteHook(id);
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
    this.plane(id).applyRendererPolicy(id, tier);
  }

  updateRefreshTierProvider(id: string, provider: RefreshTierProvider): void {
    this.plane(id).updateRefreshTierProvider(id, provider);
  }

  boostRefreshRate(id: string): void {
    this.plane(id).boostRefreshRate(id);
  }

  initializeBackendTier(id: string, tier: "active" | "background"): void {
    this.plane(id).initializeBackendTier(id, tier);
  }

  reduceScrollback(id: string, targetLines: number): void {
    this.plane(id).reduceScrollback(id, targetLines);
  }

  restoreScrollback(id: string): void {
    this.plane(id).restoreScrollback(id);
  }

  applyAgentPromotion(id: string, agentId: string): void {
    this.plane(id).applyAgentPromotion(id, agentId);
  }

  clearAgentPromotion(id: string): void {
    this.plane(id).clearAgentPromotion(id);
  }

  restoreScrollbackAllForeground(): void {
    this.planes().forEach((plane) => plane.restoreScrollbackAllForeground());
  }

  addExitListener(id: string, cb: (exitCode: number) => void): () => void {
    return this.plane(id).addExitListener(id, cb);
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
  }

  dispose(): void {
    this.planes().forEach((plane) => plane.dispose());
    this.registry.releaseAll();
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
    this.plane(id).setInputLocked(id, locked);
  }
}
