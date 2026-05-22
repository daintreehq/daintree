import { terminalClient } from "@/clients";
import { TerminalRefreshTier } from "@/types";
import type { ManagedTerminal } from "./types";
import { TIER_DOWNGRADE_HYSTERESIS_MS } from "./types";

export interface RendererPolicyDeps {
  getInstance: (id: string) => ManagedTerminal | undefined;
  wakeAndRestore: (id: string) => Promise<boolean>;
  onPostWake?: (id: string) => void;
  onResumeFlush?: (id: string) => void;
  onTierApplied?: (id: string, tier: TerminalRefreshTier, managed: ManagedTerminal) => void;
  applyDeferredResize?: (id: string) => void;
}

// Backend cadence hint sent to the PTY host alongside the binary
// "active"/"background" tier. The PTY host's ActivityMonitor uses this as its
// polling interval; in the absence of a hint it falls back to
// active=50ms / background=500ms. VISIBLE-unfocused (the new tier introduced
// in #8596 for sibling working agents) maps to 200ms so the backend feed rate
// actually decreases below FOCUSED without dropping to BACKGROUND. Keep the
// values aligned with the {@link TerminalRefreshTier} milliseconds.
function backendPollingIntervalForTier(tier: TerminalRefreshTier): number {
  switch (tier) {
    case TerminalRefreshTier.BURST:
    case TerminalRefreshTier.FOCUSED:
      return 50;
    case TerminalRefreshTier.VISIBLE:
      return 200;
    case TerminalRefreshTier.BACKGROUND:
      return 500;
  }
}

export class TerminalRendererPolicy {
  private lastBackendTier = new Map<string, "active" | "background">();
  private lastBackendPollingMs = new Map<string, number>();
  private knownTerminalIds = new Set<string>();
  private wakeGeneration = new Map<string, number>();
  private deps: RendererPolicyDeps;

  constructor(deps: RendererPolicyDeps) {
    this.deps = deps;
  }

  getLastBackendTier(id: string): "active" | "background" | undefined {
    return this.lastBackendTier.get(id);
  }

  setBackendTier(id: string, tier: "active" | "background", pollingIntervalMs?: number): void {
    this.knownTerminalIds.add(id);
    const prevTier = this.lastBackendTier.get(id);
    const prevPolling = this.lastBackendPollingMs.get(id);
    const tierChanged = prevTier !== tier;
    const pollingChanged = pollingIntervalMs !== undefined && prevPolling !== pollingIntervalMs;
    if (!tierChanged && !pollingChanged) {
      return;
    }
    this.lastBackendTier.set(id, tier);
    if (pollingIntervalMs !== undefined) {
      this.lastBackendPollingMs.set(id, pollingIntervalMs);
    }
    terminalClient.setActivityTier(id, tier, pollingIntervalMs);
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
      // First apply after mount: `lastAppliedTier` is undefined, so the
      // backend has not yet received its cadence hint for this terminal. Seed
      // it now even when the resolved tier already matches the
      // getRefreshTier() default — otherwise a fleet-demoted initial mount
      // would skip `setBackendTier` and the PTY host would stay at the
      // 50ms ActivityMonitor default. Subsequent identical applies are a
      // no-op because `setBackendTier` itself dedupes (#8596 review).
      if (managed.lastAppliedTier === undefined) {
        managed.lastAppliedTier = tier;
        const backendTier: "active" | "background" =
          tier === TerminalRefreshTier.BACKGROUND ? "background" : "active";
        this.setBackendTier(id, backendTier, backendPollingIntervalForTier(tier));
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
    const hysteresisMs = TIER_DOWNGRADE_HYSTERESIS_MS;
    managed.tierChangeTimer = window.setTimeout(() => {
      const current = this.deps.getInstance(id);
      if (current && current.pendingTier === tier) {
        this.applyRendererPolicyImmediate(id, current, tier);
        current.pendingTier = undefined;
      }
      if (current) {
        current.tierChangeTimer = undefined;
      }
    }, hysteresisMs);
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
    this.setBackendTier(id, backendTier, backendPollingIntervalForTier(tier));

    if (backendTier === "background" && prevBackendTier === "active") {
      // Invalidate any in-flight wake: if a BACKGROUND→active wake is still
      // pending when the terminal is re-backgrounded, its resolved callback
      // must not refresh/flush into a now-hidden pane (reintroduces the CPU
      // burn this gate eliminates). The next real activation starts a fresh
      // generation.
      this.bumpWakeGeneration(id);
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

            // Sync xterm's grid to dims captured while background BEFORE
            // refresh, otherwise refresh paints into a buffer sized for the
            // previous (foreground) geometry and the user sees garbled output
            // for one frame.
            this.deps.applyDeferredResize?.(id);
            current.terminal.refresh(0, current.terminal.rows - 1);

            if (ok) {
              this.deps.onPostWake?.(id);
            }

            // Flush bytes held while backgrounded AFTER scrollback restore +
            // refresh. wakeAndRestore calls terminal.reset() during replay;
            // flushing earlier would wipe these bytes.
            this.deps.onResumeFlush?.(id);
          })
          .catch(() => {
            if (this.wakeGeneration.get(id) !== wakeGeneration) return;
            const current = this.deps.getInstance(id);
            if (!current || current !== wakeTarget) return;
            current.needsWake = true;

            // Force a refresh on failure as a recovery mechanism.
            // Even if wakeAndRestore fails, this ensures the terminal attempts to render
            // whatever content it has, preventing stuck display states.
            this.deps.applyDeferredResize?.(id);
            current.terminal.refresh(0, current.terminal.rows - 1);

            // Wake failed, but the terminal is active again — flush held
            // bytes so the user isn't left with a stalled pane.
            this.deps.onResumeFlush?.(id);
          });
      } else {
        // needsWake is false, but we're transitioning to active tier.
        // Force a refresh to ensure the terminal renderer is in sync.
        this.deps.applyDeferredResize?.(id);
        managed.terminal.refresh(0, managed.terminal.rows - 1);

        // No wake needed, but transitioning to active — flush any bytes
        // held while backgrounded.
        this.deps.onResumeFlush?.(id);
      }
    }

    this.deps.onTierApplied?.(id, tier, managed);
  }

  clearTierState(id: string): void {
    this.clearManagedTierState(id);
    this.lastBackendTier.delete(id);
    this.lastBackendPollingMs.delete(id);
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
    this.lastBackendPollingMs.clear();
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
