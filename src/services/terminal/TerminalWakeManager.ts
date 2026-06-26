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
  /**
   * Force a backgrounded alt-screen pane to repaint its full frame on wake by
   * driving a real SIGWINCH, instead of replaying a serialized snapshot into
   * the live TUI (#10807). Must fire an actual resize: a same-size re-assert is
   * a host no-op (TerminalProcess hard-skips same-size resizes), so the impl
   * jiggles the pty rows. Optional / no-op in tests.
   */
  resyncAltBufferOnWake?: (id: string) => void;
}

export interface WakeResult {
  ok: boolean;
  /**
   * True only when the host's serialized main-buffer snapshot was actually
   * replayed into the still-current xterm instance (restoreFromSerialized /
   * incremental succeeded). Selection skips, missing state, failures, and a
   * mid-wake instance swap all resolve with `false` — xterm was not
   * reset+replayed for the live instance, so bytes held while backgrounded
   * must still be flushed. Alt-buffer wakes never replay a snapshot (#10807):
   * they resync via a SIGWINCH redraw and resolve `false` so held bytes flush.
   * Callers use this to choose between
   * flushing the held ingest queue and discarding it (the snapshot already
   * contains those bytes — flushing would double-paint them, #9910).
   */
  replayedMainBuffer: boolean;
}

export class TerminalWakeManager {
  private lastWakeTime = new Map<string, number>();
  private pendingWakes = new Map<string, { retries: number; timeoutId: NodeJS.Timeout }>();
  private pendingRateLimitedWakes = new Map<string, NodeJS.Timeout>();
  private declineRetries = new Map<string, { attempt: number; timeoutId: NodeJS.Timeout }>();
  private inFlightWakes = new Map<string, Promise<WakeResult>>();
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

  async wakeAndRestore(id: string): Promise<WakeResult> {
    const inFlight = this.inFlightWakes.get(id);
    if (inFlight) {
      return inFlight;
    }

    const wakePromise = (async (): Promise<WakeResult> => {
      try {
        const managed = this.deps.getInstance(id);
        if (!managed) return { ok: false, replayedMainBuffer: false };

        // xterm v6 clears selection when terminal.reset() is called during
        // restoreFromSerialized. Skip the restore if the user has an active
        // text selection to avoid destroying their drag-selection. Schedule a
        // retry (no marker — the marker would write into the terminal the guard
        // is protecting) so the resync lands once the selection is released.
        if (managed.terminal.hasSelection()) {
          this.noteDecline(id, false);
          return { ok: false, replayedMainBuffer: false };
        }

        const { state, noChange } = await terminalClient.wake(id, {
          canSkipUnchanged: managed.wakeSynced === true,
        });

        // Alt-screen TUIs (OpenCode, vim, lazygit, any agent with blockAltScreen
        // disabled) paint an absolutely-positioned frame from the live PTY
        // stream. The host wake snapshot is the raw alt frame (\x1b[?1049h +
        // cells); replaying it via restoreFromSerialized's reset()+write desyncs
        // the running app's cursor/scroll-region model, so its live
        // cursor-relative deltas land at the wrong rows (#10807 — the regression
        // bdf7d6f01 caused by deleting this guard). Never replay into a live alt
        // buffer. terminalClient.wake above already resumed the host pty; resync
        // by forcing a clean SIGWINCH redraw instead. Placed before the noChange
        // and !state branches so every alt wake redraws: a wakeSynced pane must
        // not skip the repaint, and a null-state wake redraws rather than
        // declining as stale.
        if (managed.isAltBuffer) {
          // Selection that began during the await: we never reset() on this
          // path so the drag-select survives, but the resize-driven repaint
          // would disrupt it. Defer with a retry, mirroring the main-buffer
          // selection guard below.
          if (managed.terminal.hasSelection()) {
            managed.wakeSynced = false;
            this.noteDecline(id, false);
            return { ok: false, replayedMainBuffer: false };
          }
          this.clearDeclineRetry(id);
          if (this.deps.getInstance(id) === managed) {
            // A real redraw is forced, so the wake legitimately succeeds
            // (ok:true) and the policy/visibility caller clears needsWake —
            // unlike the stale-leaving early-return bdf7d6f01 removed (#9894).
            // (triggerWake's bare path only records lastWakeTime; needsWake is
            // owned by TerminalRendererPolicy.) everWoken gates the null-state
            // marker (see the !state branch); wakeSynced lets the host skip a
            // wasted re-serialize next wake (the snapshot is never replayed).
            managed.everWoken = true;
            managed.wakeSynced = true;
            usePanelStore.getState().clearScrollbackRestoreError(id);
            this.deps.resyncAltBufferOnWake?.(id);
          }
          // replayedMainBuffer:false → callers flush (not discard) the held
          // ingest bytes; the forced repaint supersedes them, so the pane is
          // never stale-but-reported-live (#9894).
          return { ok: true, replayedMainBuffer: false };
        }

        // Host proved nothing mutated the buffer since this pane's last
        // faithful sync — the pane is already current, so skip reset+replay
        // (which also means there's no selection to protect). Held bytes are
        // still flushed by callers via `replayedMainBuffer: false`; they are
        // part of the synced stream, not covered by a snapshot.
        if (noChange) {
          if (this.deps.getInstance(id) !== managed) {
            // Instance replaced mid-wake: the fresh xterm never held the
            // synced content the skip was granted against.
            return { ok: false, replayedMainBuffer: false };
          }
          this.clearDeclineRetry(id);
          return { ok: true, replayedMainBuffer: false };
        }

        // Re-check after async: selection may have started while we were awaiting.
        if (managed.terminal.hasSelection()) {
          // The host may have just serve-marked this window against a snapshot
          // the pane is now declining — drop the sync claim so the retry
          // forces a real serialize.
          managed.wakeSynced = false;
          this.noteDecline(id, false);
          return { ok: false, replayedMainBuffer: false };
        }

        // No serialized snapshot to replay. Distinguish two cases that both
        // satisfy `!state` at the renderer: PtyEventRouter coerces an absent
        // host snapshot (null/undefined) to null, and a fresh terminal's
        // empty-string serialize() output is falsy — both fall into this branch.
        //
        //  - A fresh terminal that has never successfully restored (#10309).
        //    There is no prior content to have lost, so this is a clean no-op
        //    wake, not a data-loss event. Return without a marker or retry.
        //    needsWake stays armed via TerminalRendererPolicy, so the terminal
        //    re-attempts on its next tier transition once the host has a
        //    snapshot.
        //  - A terminal that previously restored and now wakes with no snapshot:
        //    the host discarded its buffered output, so the pane is stale.
        //    Retry in case the snapshot becomes available, but draw no marker —
        //    genuine host-side drops surface through the OSC 57301 path (#8375),
        //    not the wake-decline path.
        //
        // Alt-screen panes never reach here: they are handled by the
        // isAltBuffer branch above (redraw, not replay — #10807). This path is
        // main-buffer only.
        if (!state) {
          managed.wakeSynced = false;
          if (managed.everWoken) {
            this.noteDecline(id, false);
          }
          return { ok: false, replayedMainBuffer: false };
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
          managed.wakeSynced = false;
          const current = this.deps.getInstance(id);
          const restoreError =
            current?.lastScrollbackRestoreError ?? managed.lastScrollbackRestoreError;
          if (restoreError) {
            usePanelStore.getState().setScrollbackRestoreError(id, restoreError);
            logWarn(`Scrollback restore failed for wake of ${id}`, { error: restoreError });
          }
          return { ok: false, replayedMainBuffer: false };
        }

        // A successful replay resynced the pane — cancel any decline retry left
        // over from an earlier declined wake of this terminal, regardless of
        // which caller invoked wakeAndRestore (direct RendererPolicy /
        // visibility-restore wakes don't run triggerWake's success branch).
        // Otherwise the stale timer fires a redundant reset on an active pane.
        this.clearDeclineRetry(id);

        if (this.deps.getInstance(id) === managed) {
          // Mark the instance as having successfully restored at least once
          // (#10309). Set inside the identity guard so a mid-wake LRU eviction
          // + respawn under the same id doesn't stamp the flag on a stale
          // reference. Gates the wake-decline marker on subsequent null-state
          // wakes — see the `!state` branch above.
          managed.everWoken = true;
          // The pane now holds exactly the served snapshot; the host
          // serve-marked this window at the matching epoch, so subsequent
          // wakes may skip while nothing mutates the buffer.
          managed.wakeSynced = true;
          managed.terminal.refresh(0, managed.terminal.rows - 1);
          // A previous failed wake of this terminal may have left a banner
          // in the panel store. Mirror the hydration retry path's cleanup
          // (#8535): clear it now that the replay has succeeded.
          usePanelStore.getState().clearScrollbackRestoreError(id);
          return { ok: true, replayedMainBuffer: true };
        }
        // Instance replaced mid-wake (LRU eviction + respawn under the same
        // id): the replay landed in a stale terminal, so don't claim a
        // main-buffer replay for the id — callers would wrongly discard the
        // replacement's held bytes.
        return { ok: true, replayedMainBuffer: false };
      } catch (error) {
        console.warn(`[TerminalWakeManager] Failed to wake terminal ${id}:`, error);
        // The host may have served (and serve-marked) a snapshot this pane
        // never applied — drop the sync claim so the next wake serializes.
        const current = this.deps.getInstance(id);
        if (current) {
          current.wakeSynced = false;
        }
        return { ok: false, replayedMainBuffer: false };
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
    void this.wakeAndRestore(id).then(({ ok }) => {
      if (ok) {
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
    const { ok } = await this.wakeAndRestore(id);
    if (ok) {
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
