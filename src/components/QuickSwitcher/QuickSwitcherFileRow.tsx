import { cn } from "@/lib/utils";
import { PALETTE_ROW_CLASS } from "@/components/ui/paletteRowStyles";
import { HighlightedText, substringMatchIndices } from "@/components/ui/HighlightedText";
import { PathTail } from "@/components/ui/PathTail";
import { isMac } from "@/lib/platform";
import {
  FILE_TREE_ICON_CLASS,
  FILE_TREE_ICON_COLOR_CLASS,
  getFileTypeIcon,
} from "@/panels/file-browser/fileTypeIcons";
import type { QuickSwitcherItemProps } from "./QuickSwitcherItem";

/**
 * A file row of the file scope (#17329), as the file pane's picker draws it:
 * the type icon, the name, and its folder beside it giving way first. The
 * worktree is named once, on the scope chip.
 */
export function QuickSwitcherFileRow({
  item,
  isSelected,
  onSelect,
  onHover,
  ariaDescribedBy,
  query,
}: QuickSwitcherItemProps) {
  const { Icon } = getFileTypeIcon(item.title);
  const relativePath = item.file?.relativePath ?? item.title;
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
        "text-text-secondary"
      )}
      onClick={(e) => onSelect(item, isMac() ? e.metaKey : e.ctrlKey)}
      aria-selected={isSelected}
      aria-describedby={ariaDescribedBy}
      // The folder is drawn after the name; the path read whole says it in order.
      aria-label={relativePath}
      role="option"
    >
      <Icon
        className={cn("w-4 h-4 shrink-0", FILE_TREE_ICON_COLOR_CLASS, FILE_TREE_ICON_CLASS)}
        aria-hidden="true"
      />
      <span className="flex flex-1 min-w-0 items-baseline gap-2">
        <span className="shrink-0 max-w-[60%] truncate text-sm font-medium text-text-primary">
          <HighlightedText
            text={item.title}
            indices={substringMatchIndices(item.title, query ?? "")}
          />
        </span>
        {item.subtitle && (
          <PathTail className="min-w-0 flex-1 font-mono text-xs text-text-secondary">
            {item.subtitle}
          </PathTail>
        )}
      </span>
    </button>
  );
}
