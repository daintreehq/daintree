import { PlugZap, RotateCw } from "lucide-react";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { SpinningIcon } from "@/components/ui/SpinningIcon";
import type { PluginWorkerPresentation } from "@/components/Plugin/pluginWorkerPresentation";

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
export function PluginViewRuntimeBanner({
  presentation,
  panelDisplayName,
  onRestartPlugin,
  restarting,
}: PluginViewRuntimeStatusProps) {
  if (presentation.kind === "content") return null;

  if (presentation.kind === "reloading") {
    // T1 ambient pane chrome, deliberately NOT an `InlineStatusBanner`: a
    // respawn is routine, self-recovering, and asks nothing of the user, so the
    // tiers rule puts it below a banner. A tinted, titled banner on every crash
    // respawn would train the user to ignore the one that matters.
    return (
      <div
        role="status"
        aria-live="polite"
        className="flex items-center gap-1.5 px-3 py-1 text-2xs text-text-secondary"
      >
        <SpinningIcon icon={RotateCw} active className="size-3" />
        <span>Reloading {panelDisplayName}</span>
      </div>
    );
  }

  if (presentation.kind === "stalled") {
    return (
      <InlineStatusBanner
        icon={RotateCw}
        // T3, per the tiers rule: an auto-recovering state that stalls past the
        // threshold escalates to an error banner carrying a recovery action.
        severity="error"
        title="Plugin isn't finishing its restart"
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
