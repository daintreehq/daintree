import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import { cn } from "@/lib/utils";
import { getPrStateColor, getPrStateGlyph } from "@/lib/prStateGlyph";
import type { PR } from "@shared/types/forge";

interface PrHeaderProps {
  pr: PR;
}

export function PrHeader({ pr }: PrHeaderProps) {
  // The PR badges' mark: shape and colour by state, so a merged or draft PR
  // doesn't read as an open one here.
  const PrGlyph = getPrStateGlyph(pr.state, pr.isDraft);
  return (
    // A read-only context strip, so a subtle lift and hairline rather than the
    // field chrome around it — the strong border made it read as an input.
    <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-[var(--radius-md)] bg-overlay-subtle border border-border-subtle text-sm min-w-0">
      <PrGlyph
        className={cn("w-4 h-4 shrink-0", getPrStateColor(pr.state, pr.isDraft))}
        aria-hidden="true"
      />
      <TruncatedTooltip content={`PR #${pr.number} — ${pr.title}`}>
        <span className="text-text-primary min-w-0 truncate">
          PR <span className="font-medium text-text-primary">#{pr.number}</span>
          <span className="ml-1"> {pr.title}</span>
        </span>
      </TruncatedTooltip>
    </div>
  );
}
