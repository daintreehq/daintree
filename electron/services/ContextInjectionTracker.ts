import type { CopyTreeStopReason } from "../../shared/types/ipc/copyTree.js";

/** Why a run stopped: the user cancelled it, or its caller reported a reason. */
export type InjectionStop = "cancelled" | CopyTreeStopReason;

// `copytree:inject` waits on the driver lease and `copytree:cancel` doesn't, so
// a cancel sent right after its inject can arrive before the run registers.
// Kept briefly and few: only a run that begins soon after can claim one.
const EARLY_STOP_TTL_MS = 30_000;
const EARLY_STOP_LIMIT = 64;

export class ContextInjectionTracker {
  private injectionsInProgress = new Set<string>();
  private stops = new Map<string, InjectionStop>();
  private activeInjectionIds = new Map<string, string>();
  private earlyStops = new Map<string, { stop: InjectionStop; at: number }>();

  isTerminalInjecting(terminalId: string): boolean {
    return this.injectionsInProgress.has(terminalId);
  }

  beginInjection(terminalId: string, injectionId: string): void {
    this.injectionsInProgress.add(terminalId);
    this.activeInjectionIds.set(terminalId, injectionId);
    this.pruneEarlyStops();
    const early = this.earlyStops.get(injectionId);
    if (early) {
      this.earlyStops.delete(injectionId);
      this.stops.set(injectionId, early.stop);
    }
  }

  finishInjection(terminalId: string, injectionId: string): void {
    this.injectionsInProgress.delete(terminalId);
    this.activeInjectionIds.delete(terminalId);
    this.stops.delete(injectionId);
  }

  isCancelled(injectionId: string): boolean {
    return this.stops.has(injectionId);
  }

  /** The first stop recorded for a run: a later cancel-all doesn't rewrite why it stopped. */
  getStop(injectionId: string): InjectionStop | undefined {
    return this.stops.get(injectionId);
  }

  /**
   * Stop a run. Returns whether it was active; one that isn't yet is held for
   * a short while in case its inject is still on the way.
   */
  markCancelled(injectionId: string, reason?: CopyTreeStopReason): boolean {
    const stop: InjectionStop = reason ?? "cancelled";
    const isActive = Array.from(this.activeInjectionIds.values()).includes(injectionId);
    if (isActive) {
      if (!this.stops.has(injectionId)) this.stops.set(injectionId, stop);
      return true;
    }
    this.pruneEarlyStops();
    if (!this.earlyStops.has(injectionId)) {
      if (this.earlyStops.size >= EARLY_STOP_LIMIT) {
        const oldest = this.earlyStops.keys().next().value;
        if (oldest !== undefined) this.earlyStops.delete(oldest);
      }
      this.earlyStops.set(injectionId, { stop, at: Date.now() });
    }
    return false;
  }

  markAllCancelled(): number {
    const ids = Array.from(this.activeInjectionIds.values());
    for (const id of ids) {
      if (!this.stops.has(id)) this.stops.set(id, "cancelled");
    }
    return ids.length;
  }

  getActiveCount(): number {
    return this.activeInjectionIds.size;
  }

  cleanupTerminal(terminalId: string): void {
    const injectionId = this.activeInjectionIds.get(terminalId);
    if (injectionId) {
      this.stops.delete(injectionId);
    }
    this.injectionsInProgress.delete(terminalId);
    this.activeInjectionIds.delete(terminalId);
  }

  onProjectSwitch(): void {
    this.injectionsInProgress.clear();
    this.stops.clear();
    this.activeInjectionIds.clear();
    this.earlyStops.clear();
  }

  private pruneEarlyStops(): void {
    const cutoff = Date.now() - EARLY_STOP_TTL_MS;
    for (const [id, entry] of this.earlyStops) {
      if (entry.at > cutoff) break;
      this.earlyStops.delete(id);
    }
  }
}

export const contextInjectionTracker = new ContextInjectionTracker();
