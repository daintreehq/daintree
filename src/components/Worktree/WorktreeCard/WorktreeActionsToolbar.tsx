import { useState, type ReactNode } from "react";
import type { WorktreeState } from "@/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
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
  /** The sidebar grid owns the row's keyboard model; see `rovingProps`. */
  managedByGrid?: boolean;
  /** The sidebar's View ▸ submenu, so "More actions" carries what right-click does. */
  viewSubmenu?: ReactNode;
  isCollapsed: boolean;
  onCleanupWorktree?: () => void;
  canCollapse: boolean;
  onToggleCollapse?: (e: React.MouseEvent) => void;
  contentId?: string;
  menu: WorktreeMenuActions;
  worktree: WorktreeState;
  isPinned: boolean;
}

type ToolbarButtonKey = "delete" | "collapse" | "more";

// Every card shows the same three buttons in the same ink, active or not,
// expanded or collapsed. They used to fade to half opacity on inactive cards,
// which put enabled controls under 3:1 on every theme and left collapsed cards
// (which skipped the fade) brighter than their own titles. `sidebar-action-button`
// keeps the themes' sidebar hover fill.
const TOOLBAR_BUTTON_CLASS = "sidebar-action-button shrink-0 [&_svg]:size-3.5";

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
  managedByGrid = false,
  viewSubmenu,
  isCollapsed,
  onCleanupWorktree,
  canCollapse,
  onToggleCollapse,
  contentId,
  menu,
  worktree,
  isPinned,
}: WorktreeActionsToolbarProps) {
  // One Tab stop per toolbar (APG roving tabindex): the button focused last
  // keeps it, falling back to the first one rendered when that button is gone.
  const [lastFocused, setLastFocused] = useState<ToolbarButtonKey | null>(null);
  const rendered: ToolbarButtonKey[] = [
    ...(onCleanupWorktree ? (["delete"] as const) : []),
    ...(canCollapse ? (["collapse"] as const) : []),
    "more",
  ];
  const tabStop = lastFocused && rendered.includes(lastFocused) ? lastFocused : rendered[0];
  // In the sidebar the grid owns this row's keyboard model: its row-controls
  // mode roves every control on the card, the toolbar's buttons among them, so
  // the toolbar keeps no tab stop or arrow handling of its own to fight it.
  const rovingProps = (key: ToolbarButtonKey) => ({
    tabIndex: managedByGrid ? -1 : key === tabStop ? 0 : -1,
    onFocus: () => setLastFocused(key),
  });

  return (
    <div
      data-testid="worktree-actions-wrapper"
      data-worktree-row-toolbar=""
      role="toolbar"
      aria-label="Worktree actions"
      onKeyDown={managedByGrid ? undefined : handleToolbarKeyDown}
      className="flex shrink-0 items-center gap-0.5"
    >
      {onCleanupWorktree && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={(e) => {
                e.stopPropagation();
                onCleanupWorktree();
              }}
              data-no-dnd
              {...rovingProps("delete")}
              // Sidebar chrome stays neutral at rest; the red belongs to
              // pointing at it, focusing it, and the confirm.
              className={cn(
                TOOLBAR_BUTTON_CLASS,
                "hover:text-status-error focus-visible:text-status-error"
              )}
              aria-label="Delete worktree"
              data-testid="worktree-cleanup-button"
            >
              <Trash2 aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">Delete worktree</TooltipContent>
        </Tooltip>
      )}
      {canCollapse && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={onToggleCollapse}
              data-no-dnd
              {...rovingProps("collapse")}
              className={TOOLBAR_BUTTON_CLASS}
              aria-expanded={!isCollapsed}
              aria-controls={isCollapsed ? undefined : contentId}
              aria-label={isCollapsed ? "Expand card" : "Collapse card"}
            >
              <ChevronRight
                data-animated-chevron
                className={cn(
                  "transition-transform duration-150 ease-out",
                  isCollapsed ? "rotate-0" : "rotate-90"
                )}
                aria-hidden="true"
              />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">
            {isCollapsed ? "Expand card" : "Collapse card"}
          </TooltipContent>
        </Tooltip>
      )}
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={(e) => e.stopPropagation()}
                data-no-dnd
                {...rovingProps("more")}
                className={TOOLBAR_BUTTON_CLASS}
                aria-label="More actions"
                data-testid="worktree-actions-menu"
              >
                <MoreHorizontal aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="top">More actions</TooltipContent>
        </Tooltip>
        <DropdownMenuContent
          align="end"
          side="bottom"
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.stopPropagation()}
          className="w-64"
        >
          <WorktreeMenuItems
            worktree={worktree}
            components={DROPDOWN_COMPONENTS}
            isPinned={isPinned}
            {...menu}
            viewSubmenu={viewSubmenu}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
