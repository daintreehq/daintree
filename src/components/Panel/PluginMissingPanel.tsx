import { Puzzle } from "lucide-react";
import { toPersistedPanelKindRef } from "@shared/config/panelKindRegistry";

export interface PluginMissingPanelProps {
  /**
   * Display identifier of the plugin that registered this panel's kind. When
   * missing, the placeholder recovers it from `kind` — see
   * {@link displayNameFor}.
   */
  pluginId?: string;
  /** Raw panel kind string used as a fallback source for the plugin name. */
  kind: string;
  /** Invoked when the user asks to permanently remove this orphaned panel. */
  onRemove: () => void;
}

/**
 * The plugin name to show. `pluginId` is authoritative; without it the manifest
 * id is recovered from the kind string through the same parse persistence uses,
 * which knows both the global (`{manifestId}.{kindId}`) and project-qualified
 * (`project:{projectId}/{manifestId}/{kindId}`) runtime forms. Splitting on the
 * first dot instead would name `daintree.github.prs` as "daintree". A kind that
 * is not plugin-shaped at all falls through to the raw string.
 */
function displayNameFor(kind: string, pluginId: string | undefined): string {
  if (pluginId) return pluginId;
  return toPersistedPanelKindRef(kind)?.pluginId ?? kind;
}

/**
 * Rendered inside ContentPanel when a panel's kind is no longer registered
 * because its owning plugin is disabled or uninstalled. The panel's
 * `extensionState` is preserved on disk so re-enabling the plugin restores
 * the panel transparently; this component exists to give the user a clear
 * signal about what is missing and an affordance to discard the panel.
 */
export function PluginMissingPanel({ pluginId, kind, onRemove }: PluginMissingPanelProps) {
  const displayName = displayNameFor(kind, pluginId);

  return (
    <div
      role="region"
      aria-label="Plugin unavailable"
      className="flex flex-1 flex-col items-center justify-center gap-3 bg-surface-panel p-6 text-text-muted"
    >
      <Puzzle className="h-8 w-8 text-text-muted" aria-hidden />
      <div className="max-w-sm text-center">
        <p className="text-sm font-medium text-text-primary">Plugin unavailable</p>
        <p className="mt-1 text-xs text-text-muted">
          This panel requires the <span className="font-mono text-text-primary">{displayName}</span>{" "}
          plugin, which is not currently active. Re-enable the plugin to restore the panel.
        </p>
      </div>
      <button
        type="button"
        onClick={onRemove}
        className="mt-2 text-xs text-text-muted underline-offset-2 transition-colors hover:text-text-primary hover:underline"
      >
        Remove panel
      </button>
    </div>
  );
}
