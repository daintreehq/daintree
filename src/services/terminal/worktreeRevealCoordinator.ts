import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { isDocumentHidden, revealUntilStable } from "./revealUntilStable";

// Per-attempt budget for the attach-settle wait. Matches the registry's own
// default; a warm terminal resolves immediately, a cold one parks on the attach
// notification.
const ATTACH_SETTLE_TIMEOUT_MS = 1500;
// waitForAttachSettled REJECTS on timeout and deregisters its waiter, so a
// terminal that settles just after the deadline would never wake us again
// (#11070). Re-arm the wait instead of abandoning the obligation.
const ATTACH_WAIT_ATTEMPTS = 3;
// Cap concurrent reveal loops so a large grid never turns the switch into a
// single long task — every panel in the incoming worktree mounts in the same
// commit, so their attach notifications all land on one tick. Mirrors
// REVEAL_CONCURRENCY in repaintActiveWorktreeTerminals.
const REVEAL_CONCURRENCY = 2;

interface Obligation {
  id: string;
  /** The `_policyGeneration` stamp of the policy pass that armed this. */
  generation: number;
  /**
   * Bumped by every attach notification. An in-flight discharge captures the
   * stamp it started on, so a remount that lands mid-discharge supersedes it
   * rather than letting the older pass clear a newer obligation.
   */
  attachStamp: number;
  inFlight: boolean;
}

export interface WorktreeRevealCoordinator {
  /**
   * Replace the tracked set wholesale with the terminals whose policy wake just
   * reported "not paintable". Wholesale replacement is what bounds the map: a
   * terminal that never mounts is dropped by the next policy pass rather than
   * accumulating.
   */
  replace: (generation: number, ids: Iterable<string>) => void;
  /** A terminal's XtermAdapter just completed a live `attach()`. */
  notifyAttached: (id: string) => void;
  /** Drop every obligation (store reset). */
  clear: () => void;
  /** Introspection for tests. */
  pendingIds: () => string[];
}

/**
 * Owns the retry-until-paintable repaint that a worktree switch needs and the
 * store action cannot deliver (#11640).
 *
 * `applyWorktreeTerminalPolicy` runs synchronously inside `selectWorktree` /
 * `setActiveWorktree`, i.e. BEFORE React re-renders. The incoming worktree's
 * terminals are still unmounted at that point, their hosts parked in
 * `TerminalOffscreenManager`'s `content-visibility: hidden` container, so
 * `wake()` bottoms out in `hostHasRenderableDims()` → `checkVisibility()` →
 * false and returns without repainting. That verdict used to be discarded, so
 * the WebGL reacquire, atlas repair, refresh, reflow and fresh geometry
 * reconcile were all silently skipped on every switch and correctness rested
 * entirely on `attach()`'s single geometry pass landing on a settled box.
 *
 * This turns that false return into a tracked obligation discharged from the
 * component mount instead: the panel remounts into the live grid, XtermAdapter
 * fires `onAttached`, and the obligation runs through the same
 * {@link revealUntilStable} loop the project-view switch has used since #10362.
 *
 * Discharge is driven ONLY by the attach notification, never eagerly at arm
 * time. A warm parked terminal already satisfies `isAttachSettled` (its host
 * sits in the offscreen container, which is connected), so an eager pass would
 * resolve instantly and then burn the whole frame budget against a host that is
 * still `content-visibility: hidden` — on the switch's critical path. The mount
 * is the event that makes the host paintable, so the mount is the trigger.
 */
export function createWorktreeRevealCoordinator(): WorktreeRevealCoordinator {
  let pending = new Map<string, Obligation>();
  let active = 0;
  const slotWaiters: Array<() => void> = [];

  const acquireSlot = (): Promise<void> => {
    if (active < REVEAL_CONCURRENCY) {
      active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      slotWaiters.push(() => {
        active++;
        resolve();
      });
    });
  };

  const releaseSlot = (): void => {
    active--;
    slotWaiters.shift()?.();
  };

  const discharge = (obligation: Obligation): void => {
    // Already chasing this obligation. A notification that arrives mid-flight
    // bumps attachStamp, which the in-flight pass detects as stale and re-drives
    // from its own finally — so the newer mount is never dropped.
    if (obligation.inFlight) return;
    obligation.inFlight = true;

    const stamp = obligation.attachStamp;
    const isStale = (): boolean =>
      pending.get(obligation.id) !== obligation || obligation.attachStamp !== stamp;

    void (async () => {
      let holdsSlot = false;
      try {
        let attached = false;
        for (let attempt = 0; attempt < ATTACH_WAIT_ATTEMPTS; attempt++) {
          if (isStale()) return;
          try {
            await terminalInstanceService.waitForAttachSettled(obligation.id, {
              timeoutMs: ATTACH_SETTLE_TIMEOUT_MS,
            });
            attached = true;
            break;
          } catch {
            // Timed out — fall through and re-arm the wait (it resolves at once
            // if the attach landed in the gap).
          }
        }
        // Out of patience. Leave the obligation armed so a later remount, or the
        // next policy pass, can still pick it up.
        if (!attached || isStale()) return;

        // The slot is taken AFTER the attach wait so a terminal parked on a slow
        // attach can't starve one that is ready to paint.
        await acquireSlot();
        holdsSlot = true;
        if (isStale()) return;

        // repaintForReveal, NOT revealTerminal: revealTerminal reports `true` for
        // a MISSING instance ("gone, nothing to retry"), which would instantly
        // bank both confirm paints against a terminal that is still registering.
        // repaintForReveal reports false, so the loop keeps retrying.
        const painted = await revealUntilStable(
          obligation.id,
          (target) => terminalInstanceService.repaintForReveal(target),
          () => isStale() || isDocumentHidden(),
          "[worktreeReveal]"
        );
        // Discharge only on a confirmed paint. A false return (frame budget spent
        // on an unpaintable host, or the document went hidden) leaves the
        // obligation armed for the next mount.
        //
        // Re-check staleness rather than object identity alone: revealUntilStable
        // yields one more frame AFTER its final confirm paint and returns without
        // another abort check, so a remount can land in that gap. Its
        // notification is swallowed by the inFlight guard, so deleting here on
        // identity alone would retire an obligation the newer mount still needs
        // and leave `finally` with nothing to re-drive. Nothing can interleave
        // between this synchronous check and the delete.
        if (painted && !isStale()) {
          pending.delete(obligation.id);
        }
      } finally {
        if (holdsSlot) releaseSlot();
        obligation.inFlight = false;
        // A remount landed while this pass was running: it was superseded, so
        // re-drive against the newer stamp.
        if (pending.get(obligation.id) === obligation && obligation.attachStamp !== stamp) {
          discharge(obligation);
        }
      }
    })();
  };

  return {
    replace(generation, ids) {
      const next = new Map<string, Obligation>();
      for (const id of ids) {
        const existing = pending.get(id);
        // Carry a live entry across a same-generation replay rather than
        // replacing it: `applyPendingWorktreeSelection` re-runs the policy with
        // the CURRENT generation, and swapping the object there would strand an
        // in-flight discharge as permanently stale.
        if (existing && existing.generation === generation) {
          next.set(id, existing);
          continue;
        }
        next.set(id, { id, generation, attachStamp: 0, inFlight: false });
      }
      pending = next;
    },

    notifyAttached(id) {
      const obligation = pending.get(id);
      if (!obligation) return;
      obligation.attachStamp++;
      discharge(obligation);
    },

    clear() {
      pending = new Map<string, Obligation>();
    },

    pendingIds() {
      return Array.from(pending.keys());
    },
  };
}

const coordinator = createWorktreeRevealCoordinator();

export function replaceWorktreeRevealObligations(generation: number, ids: Iterable<string>): void {
  coordinator.replace(generation, ids);
}

export function notifyWorktreeTerminalAttached(id: string): void {
  coordinator.notifyAttached(id);
}

export function clearWorktreeRevealObligations(): void {
  coordinator.clear();
}

export function pendingWorktreeRevealIds(): string[] {
  return coordinator.pendingIds();
}
