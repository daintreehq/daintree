import { useEffect, useState } from "react";
import { PlugZap, RotateCw } from "lucide-react";
import type { PluginWorkerStatus } from "@shared/types/plugin";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";

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
  stalled: boolean
): PluginWorkerPresentation {
  if (!worker) return { kind: "content" };
  switch (worker.state) {
    case "ready":
      return { kind: "content" };
    case "starting":
    case "activating":
      // A first activation is covered by the Suspense skeleton the lazy import
      // already drives; this branch is the one that matters *after* mount, when
      // a crashed worker is being respawned under a panel showing stale content.
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
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    if (since === null) {
      setStalled(false);
      return;
    }
    const elapsed = Date.now() - since;
    if (elapsed >= PLUGIN_WORKER_STALL_MS) {
      setStalled(true);
      return;
    }
    setStalled(false);
    const timer = setTimeout(() => setStalled(true), PLUGIN_WORKER_STALL_MS - elapsed);
    return () => clearTimeout(timer);
  }, [since]);
  return stalled;
}

export interface PluginViewRuntimeStatusProps {
  presentation: PluginWorkerPresentation;
  panelDisplayName: string;
  /** Retire the backend generation and start a fresh one. */
  onRestartPlugin: () => void;
  restarting: boolean;
}

/**
 * The host-owned half of a plugin panel: what the shell draws when the plugin's
 * backend, rather than its view, is the thing that went wrong (#12278).
 *
 * Rendered OUTSIDE the plugin's ErrorBoundary and Suspense, and outside its
 * style root, so a crashed backend can't take its own error report down with it
 * and a plugin's stylesheet can't restyle the control that recovers from it.
 *
 * Only one recovery action, and only one accent: `InlineStatusBanner` enforces
 * the single-action rule for `severity="error"` at the type level, and the
 * design system allows at most one load-bearing accent per focus region. "Reload
 * view" is deliberately absent here — it recreates the view against the SAME
 * backend, which is exactly what a panel in this state does not have. It stays
 * on the diagnostics fallback, where the backend is healthy and the view is not.
 */
export function PluginViewRuntimeStatus({
  presentation,
  panelDisplayName,
  onRestartPlugin,
  restarting,
}: PluginViewRuntimeStatusProps) {
  if (presentation.kind === "content") return null;

  if (presentation.kind === "reloading") {
    // T1 ambient chrome: a respawn is under way and nothing is asked of the
    // user, so this states the fact and offers nothing to click.
    return (
      <InlineStatusBanner
        icon={RotateCw}
        severity="info"
        role="status"
        ariaLive="polite"
        title="Reloading plugin"
        description={`${panelDisplayName} is reconnecting to its plugin.`}
      />
    );
  }

  if (presentation.kind === "stalled") {
    return (
      <InlineStatusBanner
        icon={RotateCw}
        severity="warning"
        role="status"
        ariaLive="polite"
        title="Plugin is taking a while to start"
        // Deliberately not "the plugin has died": nothing here proves that. The
        // wait is unusual and the user is offered a way out; that is the whole
        // claim.
        description={`${panelDisplayName} hasn't finished reconnecting.`}
        action={{
          id: "restart-plugin",
          label: "Restart plugin",
          onClick: onRestartPlugin,
          loading: restarting,
          disabled: restarting,
        }}
      />
    );
  }

  return (
    <InlineStatusBanner
      icon={PlugZap}
      severity="error"
      title={presentation.title}
      // No promise about saved state. `persistState` is admission into a
      // debounced save path, not a durable write acknowledgement, so the copy
      // must not claim anything survived (#12278).
      description={presentation.description}
      contextLine={panelDisplayName}
      action={{
        id: "restart-plugin",
        label: "Restart plugin",
        onClick: onRestartPlugin,
        loading: restarting,
        disabled: restarting,
      }}
    />
  );
}

/**
 * Re-exported so the content layer's own gating reads from one place rather
 * than re-deriving a second loading threshold.
 */
export const PLUGIN_RESTART_FEEDBACK_MS = UI_DOHERTY_THRESHOLD;
