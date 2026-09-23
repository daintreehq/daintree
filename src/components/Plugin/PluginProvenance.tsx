import { Package } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PluginAttribution } from "./usePluginAttribution";

interface PluginProvenanceProps {
  attribution: PluginAttribution;
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
 * of view is the spoof this line exists to defeat. The manifest id rides beside
 * it because the name is the plugin's own claim and the id is what the plugin
 * list shows.
 */
export function PluginProvenance({ attribution, id, className }: PluginProvenanceProps) {
  return (
    <span
      id={id}
      data-testid="plugin-provenance"
      className={cn("flex min-w-0 items-start gap-1.5 text-xs text-text-secondary", className)}
    >
      <Package className="mt-px size-3.5 shrink-0" aria-hidden="true" />
      {/* The quoted name is one inline box, so a narrow footer moves it to the
          next line whole instead of splitting the identity across two. A name
          wider than the line still wraps inside its own box. */}
      <span className="min-w-0 [overflow-wrap:anywhere]">
        Requested by the{" "}
        <span className="inline-block max-w-full">
          &apos;<span className="font-medium text-text-primary">{attribution.name}</span>&apos;
        </span>{" "}
        plugin
        {attribution.manifestId && (
          <>
            {" "}
            <span className="inline-block max-w-full font-mono">({attribution.manifestId})</span>
          </>
        )}
      </span>
    </span>
  );
}
