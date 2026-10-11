import { ChevronRight } from "lucide-react";
import { CountBadge } from "@/components/ui/badge";
import { PALETTE_SECTION_LABEL_CLASS } from "@/components/ui/paletteRowStyles";
import { pluralize } from "@/lib/pluralize";
import { cn } from "@/lib/utils";

const SECTION_BAR_CLASS =
  "canopy-inbox-heading flex h-9 w-full shrink-0 items-center gap-1.5 px-3 text-left";

/**
 * One section heading of the inbox. Every heading is the same bar — the same
 * height, inset and label position — whether its section folds or not and
 * whether it is open or shut; only the chevron at its far end turns.
 */
export function SectionBar({
  id,
  label,
  count,
  trailing,
  fold,
}: {
  id: string;
  label: string;
  count: number;
  trailing?: React.ReactNode;
  fold?: {
    expanded: boolean;
    controls: string;
    onToggle: () => void;
    /** Down from the bar into its first row. */
    onEnter: () => void;
  };
}) {
  const heading = (
    <span id={id} className={cn(PALETTE_SECTION_LABEL_CLASS, "flex items-center gap-1.5")}>
      {label}
      <CountBadge label={pluralize(count, "run")}>{count}</CountBadge>
    </span>
  );
  if (!fold) {
    return (
      <div className={cn(SECTION_BAR_CLASS, "justify-between")}>
        {heading}
        {trailing}
      </div>
    );
  }
  return (
    <button
      type="button"
      aria-expanded={fold.expanded}
      aria-controls={fold.controls}
      onClick={fold.onToggle}
      onKeyDown={(event) => {
        if (event.key !== "ArrowDown" || !fold.expanded) return;
        event.preventDefault();
        event.stopPropagation();
        fold.onEnter();
      }}
      className={cn(
        SECTION_BAR_CLASS,
        "justify-between outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-selection-outline"
      )}
    >
      {heading}
      <ChevronRight
        aria-hidden="true"
        className={cn(
          "size-3.5 shrink-0 text-text-secondary transition-transform duration-150 motion-reduce:transition-none",
          fold.expanded && "rotate-90"
        )}
      />
    </button>
  );
}
