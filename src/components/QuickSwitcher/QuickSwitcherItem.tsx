import { cn } from "@/lib/utils";
import { PALETTE_ROW_CLASS } from "@/components/ui/paletteRowStyles";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import { FolderGit2 } from "@/components/icons";
import type { QuickSwitcherItem as QuickSwitcherItemData } from "@/hooks/useQuickSwitcher";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export interface QuickSwitcherItemProps {
  item: QuickSwitcherItemData;
  isSelected: boolean;
  onSelect: (item: QuickSwitcherItemData) => void;
  onHover?: () => void;
  ariaDescribedBy?: string;
}

export function QuickSwitcherItem({
  item,
  isSelected,
  onSelect,
  onHover,
  ariaDescribedBy,
}: QuickSwitcherItemProps) {
  return (
    <button
      id={`qs-option-${item.id}`}
      type="button"
      tabIndex={-1}
      onPointerDown={(e) => e.preventDefault()}
      onPointerMove={onHover}
      className={cn(
        PALETTE_ROW_CLASS,
        "group w-full flex items-center gap-3 px-3 py-2 rounded-[var(--radius-md)] text-left",
        "text-daintree-text/70",
        "hover:bg-overlay-subtle hover:text-daintree-text"
      )}
      onClick={() => onSelect(item)}
      aria-selected={isSelected}
      aria-label={item.title}
      aria-describedby={ariaDescribedBy}
      role="option"
    >
      <span className="shrink-0 text-daintree-text/70" aria-hidden="true">
        {item.type === "terminal" ? (
          <TerminalIcon kind={item.terminalKind} chrome={item.chrome} />
        ) : (
          <FolderGit2 className="w-4 h-4" />
        )}
      </span>

      <div className="flex-1 min-w-0 overflow-hidden">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-daintree-text truncate">{item.title}</span>
          <span
            className={cn(
              "shrink-0 px-1.5 py-0.5 text-xs rounded-[var(--radius-sm)] border",
              item.type === "terminal"
                ? "bg-overlay-medium text-daintree-text/70 border-border-strong"
                : "bg-status-success/10 text-status-success border-status-success/30"
            )}
          >
            {item.type === "terminal"
              ? (item.chrome?.agentId ?? item.chrome?.processId ?? "terminal")
              : "worktree"}
          </span>
        </div>
        {item.subtitle && (
          <Tooltip autoDismiss={false}>
            <TooltipTrigger asChild>
              <div className="text-xs text-daintree-text/50 truncate transition-colors group-aria-selected:text-daintree-text/60">
                {item.subtitle}
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom">{item.subtitle}</TooltipContent>
          </Tooltip>
        )}
      </div>
    </button>
  );
}
