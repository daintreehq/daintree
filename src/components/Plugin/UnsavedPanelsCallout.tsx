import { Callout } from "@/components/ui/Callout";
import { pluralize } from "@/lib/pluralize";
import type { PluginUnsavedPanel } from "@shared/types/pluginUnsavedPanels";

/**
 * Names the panels, in any project view, whose unsaved work an action on their
 * plugin would discard (#15031). Renders nothing when there are none, so a
 * clean plugin's dialog reads exactly as it did before.
 */
export function UnsavedPanelsCallout({
  verb,
  panels,
  className,
}: {
  /** The action as a gerund, leading the title: "Disabling", "Updating". */
  verb: string;
  panels: readonly PluginUnsavedPanel[];
  className?: string;
}) {
  if (panels.length === 0) return null;
  return (
    <Callout
      severity="warning"
      className={className}
      title={`${verb} discards unsaved work in ${pluralize(panels.length, "panel")}`}
      data-testid="plugin-unsaved-panels"
    >
      <ul className="space-y-0.5">
        {panels.map((panel) => (
          <li key={`${panel.projectId ?? ""}\u0000${panel.panelId}`}>
            <span className="text-text-primary">{panel.title || "Untitled panel"}</span>
            {panel.projectName && ` · ${panel.projectName}`}
          </li>
        ))}
      </ul>
    </Callout>
  );
}
