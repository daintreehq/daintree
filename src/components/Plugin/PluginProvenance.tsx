import { Package } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PluginAttribution } from "@/hooks/usePluginAttribution";
import type { PluginUiPromptWaited } from "@shared/types/pluginUiPrompt";

interface PluginProvenanceProps {
  attribution: PluginAttribution;
  id?: string;
  className?: string;
  /** Set when the prompt waited on its host for someone to attach. */
  waited?: PluginUiPromptWaited;
}

/**
 * "3:12 AM" for today, "Mar 4, 3:12 AM" otherwise. A waiting prompt may be
 * hours old, and the person answering should know what they're answering.
 */
export function formatAskedAt(askedAt: number, now = Date.now()): string {
  const asked = new Date(askedAt);
  const sameDay = asked.toDateString() === new Date(now).toDateString();
  return asked.toLocaleString(undefined, {
    ...(sameDay ? {} : { month: "short", day: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  });
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
export function PluginProvenance({ attribution, id, className, waited }: PluginProvenanceProps) {
  return (
    <span
      id={id}
      data-testid="plugin-provenance"
      className={cn("flex min-w-0 items-start gap-1.5 text-xs text-text-secondary", className)}
    >
      <Package className="mt-px size-3.5 shrink-0" aria-hidden="true" />
      {/* "'Name' plugin" is one inline box, so a narrow footer moves it to the
          next line whole instead of splitting the identity or stranding
          "plugin". A name wider than the line still wraps inside its own box. */}
      <span className="min-w-0 [overflow-wrap:anywhere]">
        Requested by the{" "}
        <span className="inline-block max-w-full">
          &apos;<span className="font-medium text-text-primary">{attribution.name}</span>&apos;{" "}
          plugin
        </span>
        {/* Its own line, in the install confirm's id treatment, so it reads
            as the plugin's identifier rather than trailing prose. */}
        {attribution.manifestId && (
          <span className="mt-0.5 block font-mono text-2xs">{attribution.manifestId}</span>
        )}
        {waited && (
          <span className="mt-0.5 block" data-testid="plugin-prompt-waited">
            Asked on {waited.hostName} at {formatAskedAt(waited.askedAt)}, while nobody was attached
          </span>
        )}
      </span>
    </span>
  );
}
