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
  menu,
  countNoun = "run",
}: {
  id: string;
  label: string;
  /** Left off for a section with nothing in it: its own words say so, not a 0. */
  count?: number;
  /** What the count counts, for the screen reader. */
  countNoun?: string;
  trailing?: React.ReactNode;
  fold?: {
    expanded: boolean;
    controls: string;
    onToggle: () => void;
    /** Down from the bar into its first row. */
    onEnter: () => void;
    /** Up from the bar, back into the list above it. */
    onLeaveUp?: () => void;
    buttonRef?: React.Ref<HTMLButtonElement>;
  };
  /** The section's own menu, beside a folding bar rather than inside its button. */
  menu?: React.ReactNode;
}) {
  const heading = (
    <span id={id} className={cn(PALETTE_SECTION_LABEL_CLASS, "flex items-center gap-1.5")}>
      {label}
      {count !== undefined && <CountBadge label={pluralize(count, countNoun)}>{count}</CountBadge>}
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
  // Split off: the compiler otherwise reads every field of `fold` as a ref read.
  const { buttonRef, ...foldState } = fold;
  const bar = (
    <button
      ref={buttonRef}
      type="button"
      aria-expanded={foldState.expanded}
      aria-controls={foldState.controls}
      onClick={foldState.onToggle}
      onKeyDown={(event) => {
        if (event.key === "ArrowUp" && foldState.onLeaveUp) {
          event.preventDefault();
          event.stopPropagation();
          foldState.onLeaveUp();
          return;
        }
        if (event.key !== "ArrowDown" || !foldState.expanded) return;
        event.preventDefault();
        event.stopPropagation();
        foldState.onEnter();
      }}
      className={cn(
        SECTION_BAR_CLASS,
        "justify-between outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-selection-outline",
        menu !== undefined && "min-w-0 flex-1"
      )}
    >
      {heading}
      <ChevronRight
        aria-hidden="true"
        className={cn(
          "size-3.5 shrink-0 text-text-secondary transition-transform duration-150 motion-reduce:transition-none",
          foldState.expanded && "rotate-90"
        )}
      />
    </button>
  );
  if (menu === undefined) return bar;
  return (
    <div className="flex w-full shrink-0 items-center pr-1.5">
      {bar}
      {menu}
    </div>
  );
}
