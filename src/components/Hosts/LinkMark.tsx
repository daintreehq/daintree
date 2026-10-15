import { Circle, CircleDashed } from "lucide-react";
import { cn } from "@/lib/utils";
import { SEVERITY_GLYPH } from "@/lib/statusSeverity";
import type { HostLinkTone } from "./hostModel";

const WarningGlyph = SEVERITY_GLYPH.warning;

/**
 * Filled while the link is up, hollow while it isn't, dashed while it's being
 * dialled, and the warning triangle where the link needs a look: shape carries
 * the state, not colour. Lucide strokes in `currentColor`, which forced colours
 * repaint rather than erase.
 *
 * `className` sizes the box it sits in; the glyph keeps its own size, so a
 * narrower slot lets it overhang rather than shrink below legibility.
 */
export function LinkMark({ tone, className }: { tone: HostLinkTone; className?: string }) {
  const Glyph = tone === "attention" ? WarningGlyph : tone === "connecting" ? CircleDashed : Circle;
  return (
    <span
      className={cn("flex h-5 w-3 shrink-0 items-center justify-center", className)}
      aria-hidden="true"
    >
      <Glyph
        data-link-tone={tone}
        strokeWidth={tone === "attention" ? 2 : 2.5}
        className={cn(
          "shrink-0",
          tone === "attention" ? "h-3 w-3 text-status-warning" : "h-2.5 w-2.5",
          tone === "live" && "fill-current text-text-primary",
          (tone === "offline" || tone === "connecting") && "text-text-secondary"
        )}
      />
    </span>
  );
}
