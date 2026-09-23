import { cn } from "@/lib/utils";
import { PALETTE_ROW_CLASS } from "@/components/ui/paletteRowStyles";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import { FolderGit2 } from "@/components/icons";
import type { QuickSwitcherItem as QuickSwitcherItemData } from "@/hooks/useQuickSwitcher";
import type { FuseResultMatch } from "@/hooks/useSearchablePalette";
import { HighlightedText, findMatchIndices } from "@/components/ui/HighlightedText";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export interface QuickSwitcherItemProps {
  item: QuickSwitcherItemData;
  isSelected: boolean;
  onSelect: (item: QuickSwitcherItemData) => void;
  onHover?: () => void;
  ariaDescribedBy?: string;
  /** Fuse match ranges for this row, when it was ranked for a query. */
  matches?: readonly FuseResultMatch[];
}

/**
 * The runtime a terminal row is running, when that says something its title
 * doesn't. A plain shell titled "Terminal" labelled "terminal" said the same
 * word twice; an agent pane the user renamed still benefits from "Claude".
 * Worktree rows carry no label — the branch glyph already says what they are.
 */
function runtimeLabel(item: QuickSwitcherItemData): string | null {
  if (item.type !== "terminal") return null;
  const label = item.chrome?.label?.trim();
  if (!label) return null;
  return label.toLowerCase() === item.title.trim().toLowerCase() ? null : label;
}

export function QuickSwitcherItem({
  item,
  isSelected,
  onSelect,
  onHover,
  ariaDescribedBy,
  matches,
}: QuickSwitcherItemProps) {
  const label = runtimeLabel(item);
  // A worktree's subtitle is its absolute path, and what tells two worktrees
  // apart is the tail — the shared temp or home prefix is the same on every
  // row. So it truncates from the start. The inner span keeps its own LTR run,
  // so the path's slashes stay where they belong inside the RTL box.
  const truncateFromStart = item.type === "worktree";

  return (
    <button
      id={`qs-option-${item.id}`}
      type="button"
      tabIndex={-1}
      onPointerDown={(e) => e.preventDefault()}
      onPointerMove={onHover}
      className={cn(
        PALETTE_ROW_CLASS,
        "group w-full flex items-center gap-3 px-3 py-1.5 rounded-[var(--radius-md)] text-left",
        "text-text-secondary",
        "hover:bg-overlay-subtle"
      )}
      onClick={() => onSelect(item)}
      aria-selected={isSelected}
      aria-describedby={ariaDescribedBy}
      role="option"
    >
      <span className="shrink-0 text-text-secondary" aria-hidden="true">
        {item.type === "terminal" ? (
          <TerminalIcon kind={item.terminalKind} chrome={item.chrome} />
        ) : (
          <FolderGit2 className="w-4 h-4" />
        )}
      </span>

      <div className="flex-1 min-w-0 overflow-hidden">
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="text-sm font-medium text-text-primary truncate">
            <HighlightedText text={item.title} indices={findMatchIndices(matches, "title")} />
          </span>
          {label && <span className="shrink-0 text-xs text-text-secondary">{label}</span>}
        </div>
        {item.subtitle && (
          <Tooltip autoDismiss={false}>
            <TooltipTrigger asChild>
              <div
                className={cn(
                  "text-xs text-text-secondary truncate",
                  truncateFromStart && "[direction:rtl] text-left"
                )}
              >
                <span dir="ltr">
                  <HighlightedText
                    text={item.subtitle}
                    indices={findMatchIndices(matches, "subtitle")}
                  />
                </span>
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom">{item.subtitle}</TooltipContent>
          </Tooltip>
        )}
      </div>
    </button>
  );
}
