import { Package } from "lucide-react";
import { cn } from "@/lib/utils";

interface PluginProvenanceProps {
  pluginName: string;
  id?: string;
  className?: string;
}

/**
 * The host's attribution line for a plugin-initiated prompt.
 *
 * Every other string on those surfaces is the plugin's own, so this is the one
 * thing a plugin cannot author — which is why callers place it in host chrome
 * (a dialog's footer band, a palette's footer) rather than among the plugin's
 * copy, where "Requested by…" in a prompt string would look identical. The name
 * wraps instead of truncating: a display name padded to push the real one out
 * of view is the spoof this line exists to defeat.
 */
export function PluginProvenance({ pluginName, id, className }: PluginProvenanceProps) {
  return (
    <span
      id={id}
      data-testid="plugin-provenance"
      className={cn("flex min-w-0 items-start gap-1.5 text-xs text-text-secondary", className)}
    >
      <Package className="mt-px size-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 text-pretty [overflow-wrap:anywhere]">
        Requested by the &apos;<span className="font-medium text-text-primary">{pluginName}</span>
        &apos; plugin
      </span>
    </span>
  );
}
