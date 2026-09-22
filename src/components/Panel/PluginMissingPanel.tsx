import { Puzzle } from "lucide-react";
import { toPersistedPanelKindRef } from "@shared/config/panelKindRegistry";
import { EmptyState } from "@/components/ui/EmptyState";
import { Button } from "@/components/ui/button";

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
 *
 * The body scrolls rather than clips: a pane can be shorter than the
 * explanation, and the action has to stay reachable.
 */
export function PluginMissingPanel({ pluginId, kind, onRemove }: PluginMissingPanelProps) {
  const displayName = displayNameFor(kind, pluginId);

  return (
    <div
      role="region"
      aria-label="Plugin unavailable"
      className="flex flex-1 min-h-0 flex-col overflow-y-auto bg-surface-panel"
    >
      <EmptyState
        variant="zero-data"
        scale="canvas"
        icon={<Puzzle />}
        title="Plugin unavailable"
        description={
          <>
            This panel needs the <span className="font-mono text-text-primary">{displayName}</span>{" "}
            plugin, which isn't active. Re-enable the plugin to restore the panel.
          </>
        }
        action={
          <Button variant="ghost" size="sm" onClick={onRemove}>
            Remove panel
          </Button>
        }
        className="my-auto"
      />
    </div>
  );
}
