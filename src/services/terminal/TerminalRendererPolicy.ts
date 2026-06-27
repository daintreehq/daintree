import { terminalClient } from "@/clients";
import { TerminalRefreshTier } from "@/types";
import type { ManagedTerminal } from "./types";
import { TIER_DOWNGRADE_HYSTERESIS_MS } from "./types";

export interface RendererPolicyDeps {
  getInstance: (id: string) => ManagedTerminal | undefined;
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

    // #9779: A pending BACKGROUND downgrade in the hysteresis window means the
    // ingest queue is holding bytes (the computed-tier gate). If the computed
    // tier flaps back to an active tier before the timer fires, the applied tier
    // never transitions through "background", so applyRendererPolicyImmediate's
    // resume-flush branch never runs and the held bytes strand until the next
    // chunk self-heals (indefinitely if the producer is also quiet). Flush here
    // at the debounce-cancellation site, before any branch clears the timer.
    // resumeFlush re-checks the live computed tier and the queue length, so this
    // is a safe no-op when nothing is held or the terminal is still backgrounded.
    if (
      managed.pendingTier === TerminalRefreshTier.BACKGROUND &&
      managed.tierChangeTimer !== undefined &&
      tier !== TerminalRefreshTier.BACKGROUND
    ) {
      this.deps.onResumeFlush?.(id);
    }

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

    if (backendTier === "active" && prevBackendTier !== "active") {
      // Hibernation removed: the pane stays fully live in the background (host
      // streams, renderer parses live), so the buffer is already current. The
      // foreground transition is a PLAIN REPAINT — no wake/resync. Sync xterm's
      // grid to dims captured while background BEFORE refresh so we don't paint
      // into a buffer sized for the old geometry, repaint the live buffer, run
      // the post-wake reflow/unpause (handlePostWake — a no-op for alt-screen),
      // and flush any straggler bytes. WebGL reacquire + addon/scrollback
      // restore happen in onTierApplied below.
      this.deps.applyDeferredResize?.(id);
      managed.terminal.refresh(0, managed.terminal.rows - 1);
      this.deps.onPostWake?.(id);
      this.deps.onResumeFlush?.(id);
    }

    this.deps.onTierApplied?.(id, tier, managed);
  }

  /**
   * Watchdog repair path: the backend tier diverged to "background" while the
   * applied renderer tier is active (a host-side rewrite recorded by
   * initializeBackendTier, or a lost setActivityTier). The public
   * applyRendererPolicy early-returns on tier equality, so re-applying the
   * same active tier through it can never re-send the backend tier — run the
   * immediate apply directly so the backend re-receives "active" and the
   * background→active repaint/flush path runs.
   */
  reassertActiveTier(id: string): void {
    const managed = this.deps.getInstance(id);
    if (!managed) return;
    const tier = managed.lastAppliedTier ?? managed.getRefreshTier();
    if (tier === TerminalRefreshTier.BACKGROUND) return;
    if (this.lastBackendTier.get(id) !== "background") return;
    // Cancel any pending hysteresis downgrade (mirrors the isUpgrade path in
    // applyRendererPolicy) — a stale BACKGROUND timer firing right after this
    // repair would re-background the terminal and undo it.
    if (managed.tierChangeTimer !== undefined) {
      clearTimeout(managed.tierChangeTimer);
      managed.tierChangeTimer = undefined;
    }
    managed.pendingTier = undefined;
    this.applyRendererPolicyImmediate(id, managed, tier);
  }

  clearTierState(id: string): void {
    this.clearManagedTierState(id);
    this.lastBackendTier.delete(id);
    this.lastBackendPollingMs.delete(id);
    this.knownTerminalIds.delete(id);
  }

  /**
   * Initialize the backend tier state for a terminal that was reconnected.
   * This ensures the frontend knows the actual backend tier state after project
   * switch so a later transition back to active correctly re-sends the tier (and
   * runs the plain-repaint foreground path) instead of dedupe-dropping it.
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
  }

  dispose(): void {
    for (const id of this.knownTerminalIds) {
      this.clearManagedTierState(id);
    }
    this.knownTerminalIds.clear();
    this.lastBackendTier.clear();
    this.lastBackendPollingMs.clear();
  }

  private clearManagedTierState(id: string): void {
    const managed = this.deps.getInstance(id);
    if (!managed) return;
    if (managed.tierChangeTimer !== undefined) {
      clearTimeout(managed.tierChangeTimer);
      managed.tierChangeTimer = undefined;
    }
    managed.pendingTier = undefined;
  }
}
