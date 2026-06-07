import { terminalClient } from "@/clients";
import { usePanelStore } from "@/store/panelStore";
import { TerminalRefreshTier } from "@/types";
import { logWarn } from "@/utils/logger";
import type { ManagedTerminal } from "./types";
import { INCREMENTAL_RESTORE_CONFIG } from "./types";

const WAKE_RATE_LIMIT_MS = 1000;
const WAKE_RETRY_DELAY_MS = 100;
const WAKE_MAX_RETRIES = 10;

// When a wake declines the snapshot (active selection or missing serialized
// state) the host has already discarded the suspended terminal's buffered
// output, so leaving the decline unretried strands the pane on stale content
// while every status indicator reports it live (#9894). Re-attempt the wake a
// few times so the resync lands once the blocking condition clears (the
// selection is released, the snapshot becomes available). Bounded because a
// genuinely null snapshot is an unrecoverable gap, not a transient one.
const WAKE_DECLINE_RETRY_DELAY_MS = 300;
const WAKE_DECLINE_MAX_RETRIES = 3;

export interface WakeManagerDeps {
  getInstance: (id: string) => ManagedTerminal | undefined;
  hasInstance: (id: string) => boolean;
  restoreFromSerialized: (id: string, state: string) => boolean;
  restoreFromSerializedIncremental: (id: string, state: string) => Promise<boolean>;
  // Optional guard (#9906): when the terminal has been backgrounded, a
  // scheduled wake must not fire its stale `wake-terminal` IPC. Absent (in
  // tests), the guard is a no-op and wakes proceed as before.
  isBackgrounded?: (id: string) => boolean;
  /**
   * Invoked once per decline sequence when a wake cannot apply the snapshot and
   * the gap is user-visible (missing serialized state). Used to draw the
   * data-loss marker. Not called for the selection-guard decline: injecting a
   * marker would write into the terminal the guard is deliberately leaving
   * untouched while the user drags a selection.
   */
  onDeclined?: (id: string) => void;
}

export class TerminalWakeManager {
  private lastWakeTime = new Map<string, number>();
  private pendingWakes = new Map<string, { retries: number; timeoutId: NodeJS.Timeout }>();
  private pendingRateLimitedWakes = new Map<string, NodeJS.Timeout>();
  private declineRetries = new Map<string, { attempt: number; timeoutId: NodeJS.Timeout }>();
  private inFlightWakes = new Map<string, Promise<boolean>>();
  private deps: WakeManagerDeps;

  constructor(deps: WakeManagerDeps) {
    this.deps = deps;
  }

  hasInFlightWake(id: string): boolean {
    return this.inFlightWakes.has(id);
  }

  /**
   * A wake that has been requested but not yet started: instance-retry
   * scheduled, coalesced behind the rate limit, or a declined-wake retry
   * waiting to re-attempt the snapshot. Its eventual wakeAndRestore resets the
   * terminal during replay, so flushing held bytes ahead of it would feed them
   * into a buffer that's about to be wiped — the reconciliation watchdog reads
   * this before its stalled-bytes flush (#9894).
   */
  hasPendingWake(id: string): boolean {
    return (
      this.pendingWakes.has(id) ||
      this.pendingRateLimitedWakes.has(id) ||
      this.declineRetries.has(id)
    );
  }

  async wakeAndRestore(id: string): Promise<boolean> {
    const inFlight = this.inFlightWakes.get(id);
    if (inFlight) {
      return inFlight;
    }

    const wakePromise = (async () => {
      try {
        const managed = this.deps.getInstance(id);
        if (!managed) return false;

        // xterm v6 clears selection when terminal.reset() is called during
        // restoreFromSerialized. Skip the restore if the user has an active
        // text selection to avoid destroying their drag-selection. Schedule a
        // retry (no marker — the marker would write into the terminal the guard
        // is protecting) so the resync lands once the selection is released.
        if (managed.terminal.hasSelection()) {
          this.noteDecline(id, false);
          return false;
        }

        const { state } = await terminalClient.wake(id);

        // Re-check after async: selection may have started while we were awaiting.
        if (managed.terminal.hasSelection()) {
          this.noteDecline(id, false);
          return false;
        }

        // No serialized snapshot to replay. The host discarded the buffered
        // output on suspend, so the pane is now stale — surface the gap and
        // retry in case the snapshot becomes available. Alternate-screen TUIs
        // fall through here too: addon-serialize includes the alt-buffer frame
        // (\x1b[?1049h + content), so a present snapshot correctly repaints the
        // TUI rather than being silently treated as a no-op resync.
        if (!state) {
          this.noteDecline(id, true);
          return false;
        }

        const restoreOk =
          state.length > INCREMENTAL_RESTORE_CONFIG.indicatorThresholdBytes
            ? await this.deps.restoreFromSerializedIncremental(id, state)
            : this.deps.restoreFromSerialized(id, state);

        // Surface replay failures (write timeout, parse error) to the same
        // banner the hydration path uses (#8535). The restore methods swallow
        // internal errors and stash a classified error on the managed
        // terminal; the boolean return is the source of truth. Re-read via
        // getInstance so a mid-wake instance replacement (LRU eviction +
        // respawn under the same id) is handled — the captured `managed`
        // reference may be stale.
        if (!restoreOk) {
          const current = this.deps.getInstance(id);
          const restoreError =
            current?.lastScrollbackRestoreError ?? managed.lastScrollbackRestoreError;
          if (restoreError) {
            usePanelStore.getState().setScrollbackRestoreError(id, restoreError);
            logWarn(`Scrollback restore failed for wake of ${id}`, { error: restoreError });
          }
          return false;
        }

        if (this.deps.getInstance(id) === managed) {
          managed.terminal.refresh(0, managed.terminal.rows - 1);
          // A previous failed wake of this terminal may have left a banner
          // in the panel store. Mirror the hydration retry path's cleanup
          // (#8535): clear it now that the replay has succeeded.
          usePanelStore.getState().clearScrollbackRestoreError(id);
        }
        // A successful replay resynced the pane — cancel any decline retry left
        // over from an earlier declined wake of this terminal, regardless of
        // which caller invoked wakeAndRestore (direct RendererPolicy /
        // visibility-restore wakes don't run triggerWake's success branch).
        // Otherwise the stale timer fires a redundant reset on an active pane.
        this.clearDeclineRetry(id);
        return true;
      } catch (error) {
        console.warn(`[TerminalWakeManager] Failed to wake terminal ${id}:`, error);
        return false;
      }
    })();

    this.inFlightWakes.set(id, wakePromise);
    void wakePromise.finally(() => {
      if (this.inFlightWakes.get(id) === wakePromise) {
        this.inFlightWakes.delete(id);
      }
    });
    return wakePromise;
  }

  private triggerWake(id: string): void {
    const startedAt = Date.now();
    void this.wakeAndRestore(id).then((success) => {
      if (success) {
        // wakeAndRestore already cancels any pending decline retry on success.
        this.lastWakeTime.set(id, startedAt);
      } else {
        this.lastWakeTime.delete(id);
      }
    });
  }

  /**
   * Begin (or no-op into an in-progress) decline-retry sequence for a wake that
   * could not apply the snapshot. The data-loss marker, if requested, is drawn
   * once at the start of the sequence — not on every retry — so a prolonged
   * stale window doesn't stack marker lines.
   */
  private noteDecline(id: string, injectMarker: boolean): void {
    if (this.declineRetries.has(id)) {
      // A sequence is already running for this id: the retry loop owns
      // rescheduling and the marker (if any) was already drawn.
      return;
    }
    if (injectMarker) {
      this.deps.onDeclined?.(id);
    }
    this.scheduleDeclineRetry(id, 1);
  }

  private scheduleDeclineRetry(id: string, attempt: number): void {
    if (attempt > WAKE_DECLINE_MAX_RETRIES) {
      this.declineRetries.delete(id);
      return;
    }
    const timeoutId = setTimeout(() => {
      void this.runDeclineRetry(id, attempt);
    }, WAKE_DECLINE_RETRY_DELAY_MS);
    this.declineRetries.set(id, { attempt, timeoutId });
  }

  private async runDeclineRetry(id: string, attempt: number): Promise<void> {
    const managed = this.deps.getInstance(id);
    // Bail if the terminal went away or was re-backgrounded: a background
    // terminal re-wakes through the tier-transition path (needsWake stays
    // armed), so retrying here would refresh into a hidden pane. The entry is
    // kept until now so a concurrent decline from wakeAndRestore no-ops in
    // noteDecline rather than starting a duplicate sequence.
    if (!managed || managed.lastAppliedTier === TerminalRefreshTier.BACKGROUND) {
      this.declineRetries.delete(id);
      return;
    }

    const startedAt = Date.now();
    const success = await this.wakeAndRestore(id);
    if (success) {
      this.lastWakeTime.set(id, startedAt);
      this.declineRetries.delete(id);
      return;
    }
    this.lastWakeTime.delete(id);
    this.scheduleDeclineRetry(id, attempt + 1);
  }

  private clearDeclineRetry(id: string): void {
    const pending = this.declineRetries.get(id);
    if (pending) {
      clearTimeout(pending.timeoutId);
      this.declineRetries.delete(id);
    }
  }

  wake(id: string): void {
    // Clear any pending retry for this terminal
    const pending = this.pendingWakes.get(id);
    if (pending) {
      clearTimeout(pending.timeoutId);
      this.pendingWakes.delete(id);
    }

    if (!this.deps.hasInstance(id)) {
      // Instance doesn't exist yet - schedule a retry
      this.scheduleWakeRetry(id, 0);
      return;
    }

    const now = Date.now();
    const lastWake = this.lastWakeTime.get(id) ?? 0;

    if (now - lastWake < WAKE_RATE_LIMIT_MS) {
      // Coalesce: a fast switch-away-then-back must not be silently dropped
      // (#8562). Schedule one trailing-edge call at the end of the rate-limit
      // window. Subsequent calls inside the window clear and reschedule, so
      // any burst collapses to a single deferred wake.
      const existing = this.pendingRateLimitedWakes.get(id);
      if (existing) {
        clearTimeout(existing);
      }
      const delay = Math.max(0, WAKE_RATE_LIMIT_MS - (now - lastWake));
      const timeoutId = setTimeout(() => {
        this.pendingRateLimitedWakes.delete(id);
        // The terminal may have been backgrounded between scheduling and now
        // (#9906). Firing the wake here would send a stale `wake-terminal` IPC
        // that promotes the host tier to "active" against a hidden pane —
        // exactly the late-wake desync. cancelPendingWake covers the case where
        // the BACKGROUND tier has been applied; this guard also covers the
        // window before the debounced tier apply runs, since backgroundedTerminals
        // is updated synchronously when the pane is hidden.
        if (this.deps.hasInstance(id) && this.deps.isBackgrounded?.(id) !== true) {
          this.triggerWake(id);
        }
      }, delay);
      this.pendingRateLimitedWakes.set(id, timeoutId);
      return;
    }

    this.triggerWake(id);
  }

  private scheduleWakeRetry(id: string, retryCount: number): void {
    if (retryCount >= WAKE_MAX_RETRIES) {
      console.warn(`[TerminalWakeManager] Giving up on wake for ${id} after ${retryCount} retries`);
      return;
    }

    const timeoutId = setTimeout(() => {
      this.pendingWakes.delete(id);

      if (this.deps.hasInstance(id)) {
        // Don't wake a terminal that was backgrounded while the retry was
        // queued (#9906) — same stale-IPC hazard as the rate-limited path.
        if (this.deps.isBackgrounded?.(id) === true) {
          return;
        }
        // Instance now exists, proceed with wake
        const now = Date.now();
        const lastWake = this.lastWakeTime.get(id) ?? 0;

        if (now - lastWake >= WAKE_RATE_LIMIT_MS) {
          this.triggerWake(id);
        }
      } else {
        // Still no instance, schedule another retry
        this.scheduleWakeRetry(id, retryCount + 1);
      }
    }, WAKE_RETRY_DELAY_MS);

    this.pendingWakes.set(id, { retries: retryCount, timeoutId });
  }

  /**
   * Cancel scheduled-but-not-started wakes when a terminal is backgrounded
   * (#9906). A trailing-edge rate-limited wake (or an instance-retry) that
   * fires after the BACKGROUND transition sends a stale `wake-terminal` IPC,
   * promoting the host tier to "active" against a hidden pane. Cancelling here
   * stops the IPC before it leaves the renderer. Unlike clearWakeState this
   * preserves lastWakeTime (so the rate-limit window survives a quick
   * background/foreground) and inFlightWakes (an already-started wake completes
   * and is neutralized by the policy's wake-generation guard).
   */
  cancelPendingWake(id: string): void {
    const pending = this.pendingWakes.get(id);
    if (pending) {
      clearTimeout(pending.timeoutId);
      this.pendingWakes.delete(id);
    }

    const rateLimited = this.pendingRateLimitedWakes.get(id);
    if (rateLimited) {
      clearTimeout(rateLimited);
      this.pendingRateLimitedWakes.delete(id);
    }
  }

  clearWakeState(id: string): void {
    this.lastWakeTime.delete(id);
    this.inFlightWakes.delete(id);

    const pending = this.pendingWakes.get(id);
    if (pending) {
      clearTimeout(pending.timeoutId);
      this.pendingWakes.delete(id);
    }

    const rateLimited = this.pendingRateLimitedWakes.get(id);
    if (rateLimited) {
      clearTimeout(rateLimited);
      this.pendingRateLimitedWakes.delete(id);
    }

    this.clearDeclineRetry(id);
  }

  dispose(): void {
    this.lastWakeTime.clear();
    this.inFlightWakes.clear();

    // Clear all pending wake retries
    for (const [, pending] of this.pendingWakes) {
      clearTimeout(pending.timeoutId);
    }
    this.pendingWakes.clear();

    for (const [, timeoutId] of this.pendingRateLimitedWakes) {
      clearTimeout(timeoutId);
    }
    this.pendingRateLimitedWakes.clear();

    for (const [, pending] of this.declineRetries) {
      clearTimeout(pending.timeoutId);
    }
    this.declineRetries.clear();
  }
}
