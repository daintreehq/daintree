import type { WorktreeState } from "@/types";
import { cn } from "@/lib/utils";
import { ChevronRight, MoreHorizontal, Trash2 } from "lucide-react";
import {
  WorktreeMenuItems,
  type WorktreeMenuActions,
  type WorktreeMenuComponents,
} from "../WorktreeMenuItems";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuMeta,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip";

/** Exported so a test can mount the menu through the real dropdown primitives. */
export const DROPDOWN_COMPONENTS: WorktreeMenuComponents = {
  Item: DropdownMenuItem,
  Label: DropdownMenuLabel,
  Separator: DropdownMenuSeparator,
  Shortcut: DropdownMenuShortcut,
  Meta: DropdownMenuMeta,
  Sub: DropdownMenuSub,
  SubTrigger: DropdownMenuSubTrigger,
  SubContent: DropdownMenuSubContent,
  RadioGroup: DropdownMenuRadioGroup,
  RadioItem: DropdownMenuRadioItem,
};

interface WorktreeActionsToolbarProps {
  isCollapsed: boolean;
  isActive: boolean;
  onCleanupWorktree?: () => void;
  canCollapse: boolean;
  onToggleCollapse?: (e: React.MouseEvent) => void;
  contentId?: string;
  menu: WorktreeMenuActions;
  worktree: WorktreeState;
  isPinned: boolean;
}

// APG toolbar keyboard support: arrow keys move focus between the toolbar's
// buttons (wrapping), Home/End jump to the ends. Handled only while focus is
// on a toolbar button, and stopped from bubbling so card/grid-level arrow-key
// domains don't also react. Dropdown content is portaled, so menu keystrokes
// never reach this handler.
function handleToolbarKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Home" && e.key !== "End") {
    return;
  }
  const buttons = Array.from(
    e.currentTarget.querySelectorAll<HTMLButtonElement>("button:not([disabled])")
  );
  const active = document.activeElement;
  const currentIndex = buttons.findIndex((button) => button === active);
  if (currentIndex === -1 || buttons.length < 2) return;
  e.preventDefault();
  e.stopPropagation();
  const nextIndex =
    e.key === "Home"
      ? 0
      : e.key === "End"
        ? buttons.length - 1
        : (currentIndex + (e.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
  buttons[nextIndex]?.focus();
}

export function WorktreeActionsToolbar({
  isCollapsed,
  isActive,
  onCleanupWorktree,
  canCollapse,
  onToggleCollapse,
  contentId,
  menu,
  worktree,
  isPinned,
}: WorktreeActionsToolbarProps) {
  return (
    <div
      data-testid="worktree-actions-wrapper"
      data-worktree-row-toolbar=""
      role="toolbar"
      aria-label="Worktree actions"
      onKeyDown={handleToolbarKeyDown}
      className={cn(
        "flex items-center gap-0.5 shrink-0 transition-opacity duration-150",
        isCollapsed
          ? "opacity-100"
          : isActive
            ? "opacity-100"
            : "opacity-50 delay-0 group-hover/card:opacity-100 group-hover/card:delay-75 group-has-[:focus-visible]/card:opacity-100 group-has-[:focus-visible]/card:delay-0 group-has-[[data-state=open]]/card:opacity-100 group-has-[[data-state=open]]/card:delay-0"
      )}
    >
      {onCleanupWorktree && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onCleanupWorktree();
              }}
              data-no-dnd
              className="sidebar-action-button p-1.5 text-status-error/70 hover:text-status-error rounded transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
              aria-label="Delete worktree"
              data-testid="worktree-cleanup-button"
            >
              <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">Delete worktree</TooltipContent>
        </Tooltip>
      )}
      {canCollapse && (
        <button
          onClick={onToggleCollapse}
          data-no-dnd
          className="sidebar-action-button p-1.5 text-daintree-text/60 hover:text-text-primary rounded transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
          aria-expanded={!isCollapsed}
          aria-controls={isCollapsed ? undefined : contentId}
          aria-label={isCollapsed ? "Expand card" : "Collapse card"}
        >
          <ChevronRight
            data-animated-chevron
            className={cn(
              "w-3.5 h-3.5 transition-transform duration-150",
              isCollapsed ? "rotate-0" : "rotate-90"
            )}
            aria-hidden="true"
          />
        </button>
      )}
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button
                onClick={(e) => e.stopPropagation()}
                data-no-dnd
                className="sidebar-action-button p-1.5 text-daintree-text/60 hover:text-text-primary rounded transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
                aria-label="More actions"
                data-testid="worktree-actions-menu"
              >
                <MoreHorizontal className="w-3.5 h-3.5" />
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="top">More actions</TooltipContent>
        </Tooltip>
        <DropdownMenuContent
          align="end"
          side="bottom"
          sideOffset={4}
          collisionPadding={8}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.stopPropagation()}
          className="w-64"
        >
          <WorktreeMenuItems
            worktree={worktree}
            components={DROPDOWN_COMPONENTS}
            isPinned={isPinned}
            {...menu}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
