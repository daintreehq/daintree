import { terminalClient } from "@/clients";
import { TerminalRefreshTier } from "@/types";
import type { ManagedTerminal } from "./types";
import { TIER_DOWNGRADE_HYSTERESIS_MS } from "./types";

export interface RendererPolicyDeps {
  getInstance: (id: string) => ManagedTerminal | undefined;
  wakeAndRestore: (id: string) => Promise<boolean>;
  onPostWake?: (id: string) => void;
  onTierApplied?: (id: string, tier: TerminalRefreshTier, managed: ManagedTerminal) => void;
}

export class TerminalRendererPolicy {
  private lastBackendTier = new Map<string, "active" | "background">();
  private knownTerminalIds = new Set<string>();
  private wakeGeneration = new Map<string, number>();
  private deps: RendererPolicyDeps;

  constructor(deps: RendererPolicyDeps) {
    this.deps = deps;
  }

  getLastBackendTier(id: string): "active" | "background" | undefined {
    return this.lastBackendTier.get(id);
  }

  setBackendTier(id: string, tier: "active" | "background"): void {
    this.knownTerminalIds.add(id);
    const prev = this.lastBackendTier.get(id);
    if (prev === tier) {
      return;
    }
    this.lastBackendTier.set(id, tier);
    terminalClient.setActivityTier(id, tier);
  }

  applyRendererPolicy(id: string, tier: TerminalRefreshTier): void {
    this.knownTerminalIds.add(id);
    const managed = this.deps.getInstance(id);
    if (!managed) return;

    if (tier === TerminalRefreshTier.FOCUSED || tier === TerminalRefreshTier.BURST) {
      managed.lastActiveTime = Date.now();
    }

    const currentAppliedTier =
      managed.lastAppliedTier ?? managed.getRefreshTier() ?? TerminalRefreshTier.FOCUSED;

    if (tier === currentAppliedTier) {
      if (managed.tierChangeTimer !== undefined) {
        clearTimeout(managed.tierChangeTimer);
        managed.tierChangeTimer = undefined;
        managed.pendingTier = undefined;
      }
      return;
    }

    const isUpgrade = tier < currentAppliedTier;

    if (isUpgrade) {
      if (managed.tierChangeTimer !== undefined) {
        clearTimeout(managed.tierChangeTimer);
        managed.tierChangeTimer = undefined;
      }
      managed.pendingTier = undefined;
      this.applyRendererPolicyImmediate(id, managed, tier);
      return;
    }

    if (managed.pendingTier === tier && managed.tierChangeTimer !== undefined) {
      return;
    }

    if (managed.tierChangeTimer !== undefined) {
      clearTimeout(managed.tierChangeTimer);
    }

    managed.pendingTier = tier;
    managed.tierChangeTimer = window.setTimeout(() => {
      const current = this.deps.getInstance(id);
      if (current && current.pendingTier === tier) {
        this.applyRendererPolicyImmediate(id, current, tier);
        current.pendingTier = undefined;
      }
      if (current) {
        current.tierChangeTimer = undefined;
      }
    }, TIER_DOWNGRADE_HYSTERESIS_MS);
  }

  private applyRendererPolicyImmediate(
    id: string,
    managed: ManagedTerminal,
    tier: TerminalRefreshTier
  ): void {
    managed.lastAppliedTier = tier;

    const backendTier: "active" | "background" =
      tier === TerminalRefreshTier.BACKGROUND ? "background" : "active";
    const prevBackendTier = this.lastBackendTier.get(id) ?? "active";
    this.setBackendTier(id, backendTier);

    if (backendTier === "background" && prevBackendTier === "active") {
      managed.needsWake = true;
    }

    if (backendTier === "active" && prevBackendTier !== "active") {
      if (managed.needsWake !== false) {
        const wakeGeneration = this.bumpWakeGeneration(id);
        const wakeTarget = managed;
        void this.deps
          .wakeAndRestore(id)
          .then((ok) => {
            if (this.wakeGeneration.get(id) !== wakeGeneration) return;
            const current = this.deps.getInstance(id);
            if (!current || current !== wakeTarget) return;
            current.needsWake = ok ? false : true;

            current.terminal.refresh(0, current.terminal.rows - 1);

            if (ok) {
              this.deps.onPostWake?.(id);
            }
          })
          .catch(() => {
            if (this.wakeGeneration.get(id) !== wakeGeneration) return;
            const current = this.deps.getInstance(id);
            if (!current || current !== wakeTarget) return;
            current.needsWake = true;

            // Force a refresh on failure as a recovery mechanism.
            // Even if wakeAndRestore fails, this ensures the terminal attempts to render
            // whatever content it has, preventing stuck display states.
            current.terminal.refresh(0, current.terminal.rows - 1);
          });
      } else {
        // needsWake is false, but we're transitioning to active tier.
        // Force a refresh to ensure the terminal renderer is in sync.
        managed.terminal.refresh(0, managed.terminal.rows - 1);
      }
    }

    this.deps.onTierApplied?.(id, tier, managed);
  }

  clearTierState(id: string): void {
    this.clearManagedTierState(id);
    this.lastBackendTier.delete(id);
    this.knownTerminalIds.delete(id);
    this.wakeGeneration.delete(id);
  }

  /**
   * Initialize the backend tier state for a terminal that was reconnected.
   * This ensures the frontend knows the actual backend tier state after project switch,
   * allowing proper wake behavior when transitioning back to active.
   */
  initializeBackendTier(id: string, tier: "active" | "background"): void {
    this.knownTerminalIds.add(id);
    // Validate tier value for defensive programming
    if (tier !== "active" && tier !== "background") {
      console.warn(
        `[TerminalRendererPolicy] Invalid tier "${tier}" for terminal ${id}, defaulting to "active"`
      );
      tier = "active";
    }

    this.lastBackendTier.set(id, tier);

    // If initializing to background, set needsWake to ensure wake happens on next activation
    if (tier === "background") {
      const managed = this.deps.getInstance(id);
      if (managed) {
        managed.needsWake = true;
      }
    }
  }

  dispose(): void {
    for (const id of this.knownTerminalIds) {
      this.clearManagedTierState(id);
    }
    this.knownTerminalIds.clear();
    this.lastBackendTier.clear();
    this.wakeGeneration.clear();
  }

  private clearManagedTierState(id: string): void {
    this.bumpWakeGeneration(id);
    const managed = this.deps.getInstance(id);
    if (!managed) return;
    if (managed.tierChangeTimer !== undefined) {
      clearTimeout(managed.tierChangeTimer);
      managed.tierChangeTimer = undefined;
    }
    managed.pendingTier = undefined;
  }

  private bumpWakeGeneration(id: string): number {
    const next = (this.wakeGeneration.get(id) ?? 0) + 1;
    this.wakeGeneration.set(id, next);
    return next;
  }
}
