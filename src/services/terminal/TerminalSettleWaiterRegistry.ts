import type { ManagedTerminal } from "./types";
import { agentLifecycleLedger } from "./lifecycleLedger";

interface Waiter {
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: number;
}

// Default timeout for the restore-aware settle waits (`waitForFullySettled`,
// `waitForAllFullySettled`). Aligned to the 30s Tier 1→3 promotion rule
// (CLAUDE.md "Runtime Signals"): a settle that hasn't completed within 30s has
// stalled past the point where an ambient indicator is appropriate, so the
// gate gives up and surfaces the still-pending set rather than blocking
// indefinitely. The wait is notification-driven (scheduler fires on each
// restore state transition); the timer is only the safety fallback, so
// Chromium 148 background-timer throttling in a hidden view at most delays the
// fallback, never the correct completion path.
const TERMINAL_BATCH_SETTLE_TIMEOUT_MS = 30000;

export interface TerminalSettleWaiterRegistryDeps {
  getInstance: (id: string) => ManagedTerminal | undefined;
  // Fires (synchronously) when an attach-settle notification finds a deferred
  // visibility wake pending — the reveal machinery lives on the service.
  triggerDeferredVisibilityWake: (id: string) => void;
}

/**
 * Owns the three waiter maps (readiness, attach-settled, fully-settled) that
 * `TerminalInstanceService` exposes as `waitForInstance` / `waitForAttachSettled`
 * / `waitForFullySettled` / `waitForAllFullySettled`, plus the settle
 * predicates (`isAttachSettled`, `isFullySettled`) those waits gate on.
 */
export class TerminalSettleWaiterRegistry {
  private readinessWaiters = new Map<string, Waiter[]>();
  private attachSettledWaiters = new Map<string, Waiter[]>();
  private fullySettledWaiters = new Map<string, Waiter[]>();

  constructor(private deps: TerminalSettleWaiterRegistryDeps) {}

  waitForInstance(id: string, options: { timeoutMs?: number } = {}): Promise<void> {
    const existing = this.deps.getInstance(id);
    if (existing) {
      return Promise.resolve();
    }

    const timeoutMs = options.timeoutMs ?? 5000;

    return new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.removeReadinessWaiter(id, resolve);
        reject(new Error(`Terminal ${id} frontend readiness timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      const waiters = this.readinessWaiters.get(id) || [];
      waiters.push({ resolve, reject, timeout });
      this.readinessWaiters.set(id, waiters);
    });
  }

  waitForAttachSettled(id: string, options: { timeoutMs?: number } = {}): Promise<void> {
    if (this.isAttachSettled(id)) {
      return Promise.resolve();
    }

    const timeoutMs = options.timeoutMs ?? 1500;

    return new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.removeAttachSettledWaiter(id, resolve);
        reject(new Error(`Terminal ${id} attach settle timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      const waiters = this.attachSettledWaiters.get(id) || [];
      waiters.push({ resolve, reject, timeout });
      this.attachSettledWaiters.set(id, waiters);
    });
  }

  isAttachSettled(id: string): boolean {
    const managed = this.deps.getInstance(id);
    if (!managed) return false;
    return (
      managed.isOpened &&
      managed.isAttaching !== true &&
      managed.hostElement.isConnected &&
      managed.terminal.element !== undefined
    );
  }

  notifyReadinessWaiters(id: string): void {
    const waiters = this.readinessWaiters.get(id);
    if (!waiters) return;

    for (const waiter of waiters) {
      clearTimeout(waiter.timeout);
      waiter.resolve();
    }

    this.readinessWaiters.delete(id);
  }

  private removeReadinessWaiter(id: string, resolve: () => void): void {
    const waiters = this.readinessWaiters.get(id);
    if (!waiters) return;

    const index = waiters.findIndex((w) => w.resolve === resolve);
    if (index >= 0) {
      waiters.splice(index, 1);
    }

    if (waiters.length === 0) {
      this.readinessWaiters.delete(id);
    }
  }

  notifyAttachSettledWaiters(id: string): void {
    if (!this.isAttachSettled(id)) return;

    // Consume a deferred visibility wake that was skipped while this terminal
    // was mid-attach (#9702). Read and clear the flag before dispatching so a
    // re-entrant call can't double-fire; fullWakeForVisibilityRestore guards
    // against stale/replaced instances on its own.
    const managed = this.deps.getInstance(id);
    const deferredWake = managed?.pendingVisibilityWake === true;
    if (managed) managed.pendingVisibilityWake = false;

    // Record the first live-attach geometry in the lifecycle ledger (once per
    // launch generation — recordFirstAttach ignores later attaches). Pairs
    // with the 80x24 initial dims stamped at launch so a support bundle can
    // show whether a pane ever converged from boot geometry.
    if (managed) {
      const generation = agentLifecycleLedger.currentGeneration(id);
      if (generation !== undefined) {
        agentLifecycleLedger.recordFirstAttach(
          id,
          generation,
          managed.terminal.cols,
          managed.terminal.rows
        );
      }
    }

    const waiters = this.attachSettledWaiters.get(id);
    if (waiters) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timeout);
        waiter.resolve();
      }
      this.attachSettledWaiters.delete(id);
    }

    // Visual attach is one half of "fully settled". If restore already
    // finished while this terminal was mid-attach, attach completing now is
    // the moment it becomes fully settled — drain those waiters too.
    this.notifyFullySettledWaitersIfReady(id);

    if (deferredWake) {
      this.deps.triggerDeferredVisibilityWake(id);
    }
  }

  private removeAttachSettledWaiter(id: string, resolve: () => void): void {
    const waiters = this.attachSettledWaiters.get(id);
    if (!waiters) return;

    const index = waiters.findIndex((w) => w.resolve === resolve);
    if (index >= 0) {
      waiters.splice(index, 1);
    }

    if (waiters.length === 0) {
      this.attachSettledWaiters.delete(id);
    }
  }

  /**
   * Resolves once a terminal is *fully* settled — both visually attached
   * ({@link isAttachSettled}) and past its scrollback-restore lifecycle. Unlike
   * {@link waitForAttachSettled}, which only gates on visual attach, this waits
   * for the restore state machine to leave its in-flux states.
   *
   * A restore failure still settles the wait (the terminal is usable, just
   * without restored scrollback); callers that care about success vs. silent
   * failure inspect `lastScrollbackRestoreError` after the wait resolves.
   *
   * Precondition: call this only after restore has had a chance to be
   * scheduled (state moved to `"pending"`). A brand-new terminal whose restore
   * has not yet been queued reads as settled because its state is still
   * `"none"` — there is nothing to wait for from this method's view.
   */
  waitForFullySettled(id: string, options: { timeoutMs?: number } = {}): Promise<void> {
    if (this.isFullySettled(id)) {
      return Promise.resolve();
    }

    const timeoutMs = options.timeoutMs ?? TERMINAL_BATCH_SETTLE_TIMEOUT_MS;

    return new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.removeFullySettledWaiter(id, resolve);
        const state = this.deps.getInstance(id)?.scrollbackRestoreState ?? "missing";
        reject(
          new Error(`Terminal ${id} fully-settle timeout after ${timeoutMs}ms (restore: ${state})`)
        );
      }, timeoutMs);

      const waiters = this.fullySettledWaiters.get(id) || [];
      waiters.push({ resolve, reject, timeout });
      this.fullySettledWaiters.set(id, waiters);
    });
  }

  /**
   * Batch variant of {@link waitForFullySettled}: resolves once every panel in
   * `ids` is fully settled, governed by a single shared timeout. On timeout the
   * rejection names the still-pending panels. If a panel is destroyed mid-wait
   * its per-panel waiter rejects, which fails the whole batch — this is a
   * startup correctness gate, so a missing panel is a hard failure, not a
   * silent partial success (hence `Promise.all`, not `allSettled`).
   */
  waitForAllFullySettled(ids: string[], options: { timeoutMs?: number } = {}): Promise<void> {
    const uniqueIds = Array.from(new Set(ids));
    if (uniqueIds.length === 0) {
      return Promise.resolve();
    }

    const timeoutMs = options.timeoutMs ?? TERMINAL_BATCH_SETTLE_TIMEOUT_MS;

    return new Promise<void>((resolveBatch, rejectBatch) => {
      let settled = false;
      // Per-panel resolve handles we registered in `fullySettledWaiters`, so
      // the shared timeout can detach them in one pass rather than leaving
      // ghost waiters that fire after the batch has already rejected.
      const registered: Array<{ id: string; resolve: () => void }> = [];

      const detachAll = () => {
        for (const entry of registered) {
          this.removeFullySettledWaiter(entry.id, entry.resolve);
        }
      };

      const timeout = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        detachAll();
        const pending = uniqueIds.filter((id) => !this.isFullySettled(id));
        rejectBatch(
          new Error(`Terminals not fully settled after ${timeoutMs}ms: ${pending.join(", ")}`)
        );
      }, timeoutMs);

      const perPanel = uniqueIds.map(
        (id) =>
          new Promise<void>((resolve, reject) => {
            if (this.isFullySettled(id)) {
              resolve();
              return;
            }
            registered.push({ id, resolve });
            const waiters = this.fullySettledWaiters.get(id) || [];
            // No per-panel timer — the shared batch timeout above governs the
            // whole set. `timeout: 0` is never a live handle, so the
            // `clearTimeout` calls in the notify/destroy drain paths are no-ops.
            waiters.push({ resolve, reject, timeout: 0 });
            this.fullySettledWaiters.set(id, waiters);
          })
      );

      void Promise.all(perPanel).then(
        () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolveBatch();
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          detachAll();
          rejectBatch(error instanceof Error ? error : new Error(String(error)));
        }
      );
    });
  }

  isFullySettled(id: string): boolean {
    const managed = this.deps.getInstance(id);
    if (!managed) return false;
    if (!this.isAttachSettled(id)) return false;
    // Restore is "settled" once it is no longer in flux — not queued
    // ("pending") and not running ("in-progress"). "done" is a clean restore;
    // "none" is terminal from a waiter's view in every case it occurs:
    // restore was never scheduled (fresh terminal, no scrollback), aborted
    // before starting (project switch — outcome no longer relevant), or failed
    // and reset (lastScrollbackRestoreError set). The failure case still
    // settles: a cosmetic scrollback failure must not strand the wait, and
    // callers distinguish it via lastScrollbackRestoreError.
    return managed.scrollbackRestoreState === "done" || managed.scrollbackRestoreState === "none";
  }

  /**
   * Drains the fully-settled waiters for a terminal if it has reached the
   * settled predicate. Reads the instance fresh (never closes over a captured
   * `managed`) so a stale/replaced instance can't be acted on (#4850).
   */
  notifyFullySettledWaitersIfReady(id: string): void {
    if (!this.isFullySettled(id)) return;

    const waiters = this.fullySettledWaiters.get(id);
    if (!waiters) return;

    for (const waiter of waiters) {
      clearTimeout(waiter.timeout);
      waiter.resolve();
    }
    this.fullySettledWaiters.delete(id);
  }

  /**
   * Scheduler-facing hook: the scrollback restore scheduler calls this after
   * each terminal restore state transition (success, failure, or bail) so
   * fully-settled waiters can re-check the predicate. Public because the
   * scheduler lives in a sibling module and already calls into this singleton.
   */
  notifyRestoreSettledWaiters(id: string): void {
    this.notifyFullySettledWaitersIfReady(id);
  }

  private removeFullySettledWaiter(id: string, resolve: () => void): void {
    const waiters = this.fullySettledWaiters.get(id);
    if (!waiters) return;

    const index = waiters.findIndex((w) => w.resolve === resolve);
    if (index >= 0) {
      waiters.splice(index, 1);
    }

    if (waiters.length === 0) {
      this.fullySettledWaiters.delete(id);
    }
  }

  // Rejects every pending waiter (readiness, attach-settled, fully-settled)
  // for a destroyed terminal. Called from `TerminalInstanceService.destroy()`.
  rejectAll(id: string): void {
    const waiters = this.readinessWaiters.get(id);
    if (waiters) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timeout);
        waiter.reject(new Error(`Terminal ${id} destroyed before frontend became ready`));
      }
      this.readinessWaiters.delete(id);
    }

    const attachWaiters = this.attachSettledWaiters.get(id);
    if (attachWaiters) {
      for (const waiter of attachWaiters) {
        clearTimeout(waiter.timeout);
        waiter.reject(new Error(`Terminal ${id} destroyed before attach settled`));
      }
      this.attachSettledWaiters.delete(id);
    }

    const fullySettledWaiters = this.fullySettledWaiters.get(id);
    if (fullySettledWaiters) {
      for (const waiter of fullySettledWaiters) {
        clearTimeout(waiter.timeout);
        waiter.reject(new Error(`Terminal ${id} destroyed before fully settled`));
      }
      this.fullySettledWaiters.delete(id);
    }
  }
}
