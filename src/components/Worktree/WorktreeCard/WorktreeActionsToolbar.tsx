import type { WorktreeState } from "@/types";
import { cn } from "@/lib/utils";
import { ChevronRight, MoreHorizontal, Trash2 } from "lucide-react";
import {
  WorktreeMenuItems,
  type WorktreeLaunchAgentItem,
  type WorktreeMenuComponents,
} from "../WorktreeMenuItems";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip";

const DROPDOWN_COMPONENTS: WorktreeMenuComponents = {
  Item: DropdownMenuItem,
  Label: DropdownMenuLabel,
  Separator: DropdownMenuSeparator,
  Shortcut: DropdownMenuShortcut,
  Sub: DropdownMenuSub,
  SubTrigger: DropdownMenuSubTrigger,
  SubContent: DropdownMenuSubContent,
};

interface WorktreeActionsToolbarProps {
  isCollapsed: boolean;
  isActive: boolean;
  onCleanupWorktree?: () => void;
  canCollapse: boolean;
  onToggleCollapse?: (e: React.MouseEvent) => void;
  contentId?: string;
  menu: {
    launchAgents: WorktreeLaunchAgentItem[];
    recipes: { id: string; name: string }[];
    runningRecipeId: string | null;
    counts: {
      grid: number;
      dock: number;
      active: number;
      completed: number;
      all: number;
      waiting: number;
      working: number;
    };
    onCopyContextFull: () => void;
    onCopyContextModified: () => void;
    onCopyPath: () => void;
    onOpenEditor: () => void;
    onRevealInFinder: () => void;
    onOpenIssuePortal?: () => void;
    onOpenIssueExternal?: () => void;
    onOpenPRPortal?: () => void;
    onOpenPRExternal?: () => void;
    onRunRecipe: (recipeId: string) => void;
    onSaveLayout?: () => void;
    onTogglePin?: () => void;
    onToggleCollapse?: () => void;
    isCollapsed?: boolean;
    onLaunchAgent?: (agentId: string) => void;
    onMoveUp?: () => void;
    onMoveDown?: () => void;
    canMoveUp?: boolean;
    canMoveDown?: boolean;
    onDockAll: () => void;
    onMaximizeAll: () => void;
    onResetRenderers: () => void;
    onSelectAllAgents: () => void;
    onSelectWaitingAgents: () => void;
    onSelectWorkingAgents: () => void;
    onAttachIssue?: () => void;
    onViewPlan?: () => void;
    onOpenReviewHub?: () => void;
    onCompareDiff?: () => void;
    onOpenPanelPalette?: () => void;
    onDeleteWorktree?: () => void;
    onRevertAgentChanges?: () => void;
    hasSnapshot?: boolean;
    hasResourceConfig?: boolean;
    worktreeMode?: string;
    resourceEnvironmentKeys?: string[];
    onSwitchEnvironment?: (envKey: string) => void;
    resourceStatus?: string;
    onResourceProvision?: () => void;
    onResourceResume?: () => void;
    onResourcePause?: () => void;
    onResourceConnect?: () => void;
    onResourceStatus?: () => void;
    onResourceTeardown?: () => void;
  };
  worktree: WorktreeState;
  isPinned: boolean;
  handleLaunchAgent: (agentId: string) => void;
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
  handleLaunchAgent,
}: WorktreeActionsToolbarProps) {
  return (
    <div
      data-testid="worktree-actions-wrapper"
      data-worktree-row-toolbar=""
      role="toolbar"
      aria-label="Worktree actions"
      className={cn(
        "flex items-center gap-0.5 shrink-0 transition-opacity duration-150",
        isCollapsed
          ? "opacity-100"
          : isActive
            ? "opacity-100"
            : "opacity-50 group-hover/card:opacity-100 group-focus-within/card:opacity-100 group-has-[[data-state=open]]/card:opacity-100"
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
              className="sidebar-action-button p-1.5 text-status-error/70 hover:text-status-error rounded transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent"
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
          className="sidebar-action-button p-1.5 text-daintree-text/60 hover:text-text-primary rounded transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent"
          aria-expanded={!isCollapsed}
          aria-controls={isCollapsed ? undefined : contentId}
          aria-label={isCollapsed ? "Expand card" : "Collapse card"}
        >
          <ChevronRight
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
                className="sidebar-action-button p-1.5 text-daintree-text/60 hover:text-text-primary rounded transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent"
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
            launchAgents={menu.launchAgents}
            recipes={menu.recipes}
            runningRecipeId={menu.runningRecipeId}
            isPinned={isPinned}
            counts={menu.counts}
            onLaunchAgent={menu.onLaunchAgent ? handleLaunchAgent : undefined}
            onMoveUp={menu.onMoveUp}
            onMoveDown={menu.onMoveDown}
            canMoveUp={menu.canMoveUp}
            canMoveDown={menu.canMoveDown}
            onCopyContextFull={menu.onCopyContextFull}
            onCopyContextModified={menu.onCopyContextModified}
            onCopyPath={menu.onCopyPath}
            onOpenEditor={menu.onOpenEditor}
            onRevealInFinder={menu.onRevealInFinder}
            onOpenIssuePortal={menu.onOpenIssuePortal}
            onOpenIssueExternal={menu.onOpenIssueExternal}
            onOpenPRPortal={menu.onOpenPRPortal}
            onOpenPRExternal={menu.onOpenPRExternal}
            onAttachIssue={menu.onAttachIssue}
            onViewPlan={menu.onViewPlan}
            onOpenReviewHub={menu.onOpenReviewHub}
            onCompareDiff={menu.onCompareDiff}
            onRunRecipe={menu.onRunRecipe}
            onSaveLayout={menu.onSaveLayout}
            onTogglePin={menu.onTogglePin}
            onToggleCollapse={menu.onToggleCollapse}
            isCollapsed={menu.isCollapsed}
            onDockAll={menu.onDockAll}
            onMaximizeAll={menu.onMaximizeAll}
            onResetRenderers={menu.onResetRenderers}
            onSelectAllAgents={menu.onSelectAllAgents}
            onSelectWaitingAgents={menu.onSelectWaitingAgents}
            onSelectWorkingAgents={menu.onSelectWorkingAgents}
            onOpenPanelPalette={menu.onOpenPanelPalette}
            onDeleteWorktree={menu.onDeleteWorktree}
            onRevertAgentChanges={menu.onRevertAgentChanges}
            hasSnapshot={menu.hasSnapshot}
            hasResourceConfig={menu.hasResourceConfig}
            worktreeMode={menu.worktreeMode}
            resourceEnvironmentKeys={menu.resourceEnvironmentKeys}
            onSwitchEnvironment={menu.onSwitchEnvironment}
            resourceStatus={menu.resourceStatus}
            onResourceProvision={menu.onResourceProvision}
            onResourceResume={menu.onResourceResume}
            onResourcePause={menu.onResourcePause}
            onResourceConnect={menu.onResourceConnect}
            onResourceStatus={menu.onResourceStatus}
            onResourceTeardown={menu.onResourceTeardown}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
