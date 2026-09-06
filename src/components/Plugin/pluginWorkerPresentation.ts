import { useEffect, useState } from "react";
import type { PluginWorkerStatus } from "@shared/types/plugin";

/**
 * How long a worker may sit in a transient state before the shell stops calling
 * it "reloading" and offers a way out. `user-signals.md` puts the escalation
 * from an auto-recovering T1 to an actionable T3 at 30 seconds, and this is the
 * only place that judgement is spelled.
 *
 * It is a presentation threshold, NOT a health verdict: the worker may still be
 * alive and working, so the copy says the wait is unusual rather than claiming
 * anything died. Real deadlines live in main (the `ready` handshake and the
 * activation budget), and the supervisor's own crash respawns deliberately have
 * none — which is exactly the gap this covers, because a respawn whose fork
 * fails emits nothing at all.
 */
export const PLUGIN_WORKER_STALL_MS = 30_000;

/** What the shell decided to render for a worker, given its status. */
export type PluginWorkerPresentation =
  | { kind: "content" }
  | { kind: "reloading" }
  | { kind: "stalled" }
  | { kind: "unavailable"; title: string; description: string };

/**
 * Map a worker status onto what the shell shows, keeping the plugin out of the
 * decision: a backend that is gone is a host fact, and a plugin should not get
 * to render over it (#12278).
 *
 * `null` (nothing tracked yet) and `ready` both fall through to the plugin's own
 * content. A missing status means "unknown, still hydrating", never "dead" —
 * failing the other way would flash a scary banner over every healthy panel for
 * the length of one IPC round trip.
 */
export function presentWorkerStatus(
  worker: PluginWorkerStatus | null,
  stalled: boolean,
  /**
   * Whether this panel has ever seen its backend reach `ready`. A transient
   * state before that is a FIRST activation, not a recovery.
   */
  everReady: boolean
): PluginWorkerPresentation {
  if (!worker) return { kind: "content" };
  switch (worker.state) {
    case "ready":
      return { kind: "content" };
    case "starting":
    case "activating":
      // A first activation is already covered by the Suspense skeleton the lazy
      // import drives, and this layer sits OUTSIDE that Suspense — so without
      // the `everReady` gate a freshly opened panel paints "Reloading" beside
      // its own skeleton, reporting one wait twice. This branch is the one that
      // matters after mount, when a crashed worker is being respawned under a
      // panel still showing stale content.
      if (!everReady) return { kind: "content" };
      return stalled ? { kind: "stalled" } : { kind: "reloading" };
    case "stopped":
      return {
        kind: "unavailable",
        title: "Plugin backend stopped",
        description: "This panel's plugin isn't running. Restart it to use this panel again.",
      };
    case "failed":
      return { kind: "unavailable", ...failureCopy(worker) };
  }
}

/**
 * Copy for a terminal worker failure. Branches on the closed `reason` rather
 * than `detail`, which is free-form and may carry plugin-authored text — a
 * banner title is not the place to render that unredacted.
 */
function failureCopy(worker: PluginWorkerStatus): { title: string; description: string } {
  switch (worker.reason) {
    case "crash-loop":
      return {
        title: "Plugin keeps crashing",
        description:
          "Its backend crashed repeatedly and won't restart on its own. Restarting again may not help.",
      };
    case "activation-timeout":
      return {
        title: "Plugin didn't finish starting",
        description: "Its backend stopped responding while starting up.",
      };
    case "activation-failed":
      return {
        title: "Plugin backend failed to start",
        description: "It threw while starting up, so this panel has nothing behind it.",
      };
    case "protocol-violation":
      return {
        title: "Plugin backend was stopped",
        description: "It sent something the host couldn't accept and was shut down.",
      };
    case "fork-failed":
      return {
        title: "Plugin backend couldn't start",
        description: "Its process failed to launch.",
      };
    default:
      return {
        title: "Plugin backend unavailable",
        description: "This panel's plugin isn't running.",
      };
  }
}

/**
 * True once `since` is more than {@link PLUGIN_WORKER_STALL_MS} in the past,
 * re-rendering once when the threshold passes.
 *
 * A timer rather than a derived render value because nothing else re-renders
 * this subtree while a worker sits in the same state — the whole point is that
 * no further event is coming.
 */
export function useWorkerStall(since: number | null): boolean {
  // The TIMESTAMP that stalled, not a bare boolean. A boolean is still holding
  // the previous attempt's `true` on the first render after a fresh `since`
  // arrives — only the passive effect clears it — so a brand-new attempt would
  // paint, and announce, the stalled UI for a frame.
  const [stalledSince, setStalledSince] = useState<number | null>(null);
  useEffect(() => {
    if (since === null) return;
    const elapsed = Date.now() - since;
    if (elapsed >= PLUGIN_WORKER_STALL_MS) {
      setStalledSince(since);
      return;
    }
    const timer = setTimeout(() => setStalledSince(since), PLUGIN_WORKER_STALL_MS - elapsed);
    return () => clearTimeout(timer);
  }, [since]);
  return since !== null && stalledSince === since;
}
