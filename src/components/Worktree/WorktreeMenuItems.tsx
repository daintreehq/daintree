import type * as React from "react";
import type { WorktreeState } from "../../types";
import {
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
} from "@/components/ui/context-menu";
import {
  Activity,
  CircleDot,
  Code,
  Copy,
  FileText,
  Folder,
  GitCommitHorizontal,
  GitCompare,
  GitPullRequest,
  Globe,
  LayoutGrid,
  Layers,
  Link,
  Monitor,
  Maximize2,
  PanelTopClose,
  PanelTopOpen,
  Pin,
  PinOff,
  Play,
  Plug,
  RefreshCw,
  RotateCcw,
  Save,
  Server,
  Pause,
  SquareTerminal,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { MoveToDockIcon, CopyTreeIcon, TerminalRecipeIcon } from "@/components/icons";

type MenuComponent = React.ElementType;
type LaunchAgentIcon = React.ComponentType<{ className?: string }>;

export interface WorktreeMenuComponents {
  Item: MenuComponent;
  Label: MenuComponent;
  Separator: MenuComponent;
  Shortcut: MenuComponent;
  Sub: MenuComponent;
  SubTrigger: MenuComponent;
  SubContent: MenuComponent;
}

export const CONTEXT_COMPONENTS: WorktreeMenuComponents = {
  Item: ContextMenuItem,
  Label: ContextMenuLabel,
  Separator: ContextMenuSeparator,
  Shortcut: ContextMenuShortcut,
  Sub: ContextMenuSub,
  SubTrigger: ContextMenuSubTrigger,
  SubContent: ContextMenuSubContent,
};

export interface WorktreeLaunchAgentItem {
  id: string;
  name: string;
  isEnabled: boolean;
  icon?: LaunchAgentIcon;
  shortcut?: string | null;
}

export interface WorktreeMenuItemsProps {
  worktree: WorktreeState;
  components: WorktreeMenuComponents;
  launchAgents: WorktreeLaunchAgentItem[];
  recipes: Array<{ id: string; name: string }>;
  runningRecipeId: string | null;
  isRestartValidating: boolean;
  isPinned?: boolean;
  counts: {
    grid: number;
    dock: number;
    active: number;
    completed: number;
    all: number;
  };
  onLaunchAgent?: (agentId: string) => void;
  onCopyContextFull: () => void;
  onCopyContextModified: () => void;
  onCopyPath: () => void;
  onOpenEditor: () => void;
  onRevealInFinder: () => void;
  onOpenIssuePortal?: () => void;
  onOpenIssueExternal?: () => void;
  onOpenPRPortal?: () => void;
  onOpenPRExternal?: () => void;
  onAttachIssue?: () => void;
  onViewPlan?: () => void;
  onOpenReviewHub?: () => void;
  onCompareDiff?: () => void;
  onRunRecipe: (recipeId: string) => void;
  onSaveLayout?: () => void;
  onTogglePin?: () => void;
  onToggleCollapse?: () => void;
  isCollapsed?: boolean;
  onDockAll: () => void;
  onMaximizeAll: () => void;
  onRestartAll: () => void;
  onResetRenderers: () => void;
  onCloseCompleted: () => void;
  onCloseAll: () => void;
  onEndAll: () => void;
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
}

export function WorktreeMenuItems({
  worktree,
  components: C,
  launchAgents,
  recipes,
  runningRecipeId,
  isRestartValidating,
  isPinned,
  counts,
  onLaunchAgent,
  onCopyContextFull,
  onCopyContextModified,
  onCopyPath,
  onOpenEditor,
  onRevealInFinder,
  onOpenIssuePortal,
  onOpenIssueExternal,
  onOpenPRPortal,
  onOpenPRExternal,
  onAttachIssue,
  onViewPlan,
  onOpenReviewHub,
  onCompareDiff,
  onRunRecipe,
  onSaveLayout,
  onTogglePin,
  onToggleCollapse,
  isCollapsed,
  onDockAll,
  onMaximizeAll,
  onRestartAll,
  onResetRenderers,
  onCloseCompleted,
  onCloseAll,
  onEndAll,
  onOpenPanelPalette,
  onDeleteWorktree,
  onRevertAgentChanges,
  hasSnapshot,
  hasResourceConfig,
  worktreeMode,
  resourceEnvironmentKeys,
  onSwitchEnvironment,
  onResourceProvision,
  onResourceResume,
  onResourcePause,
  onResourceConnect,
  onResourceStatus,
  onResourceTeardown,
}: WorktreeMenuItemsProps) {
  const hasIssueSub = Boolean(worktree.issueNumber && (onOpenIssuePortal || onOpenIssueExternal));
  const hasPRSub = Boolean(worktree.prNumber && (onOpenPRPortal || onOpenPRExternal));
  const hasIssueOrPrSection = hasIssueSub || hasPRSub;
  const hasRecipes = recipes.length > 0;
  const hasRecipeSection = hasRecipes || (onSaveLayout && counts.active > 0);
  const hasSessions = counts.all > 0;

  return (
    <>
      {/* Launch submenu */}
      <C.Sub>
        <C.SubTrigger>
          <SquareTerminal className="w-3.5 h-3.5 mr-2" />
          Launch
        </C.SubTrigger>
        <C.SubContent>
          {launchAgents.map((agent) => {
            const Icon = agent.icon;
            return (
              <C.Item
                key={agent.id}
                onSelect={() => onLaunchAgent?.(agent.id)}
                disabled={!onLaunchAgent || !agent.isEnabled}
              >
                {Icon ? (
                  <Icon className="w-3.5 h-3.5 mr-2" />
                ) : (
                  <SquareTerminal className="w-3.5 h-3.5 mr-2" />
                )}
                {agent.name}
              </C.Item>
            );
          })}
          {launchAgents.length > 0 && <C.Separator />}
          <C.Item onSelect={() => onLaunchAgent?.("terminal")} disabled={!onLaunchAgent}>
            <SquareTerminal className="w-3.5 h-3.5 mr-2" />
            Open Terminal
          </C.Item>
          <C.Item onSelect={() => onLaunchAgent?.("browser")} disabled={!onLaunchAgent}>
            <Globe className="w-3.5 h-3.5 mr-2 text-status-info" />
            Open Browser
          </C.Item>
          <C.Item onSelect={() => onLaunchAgent?.("dev-preview")} disabled={!onLaunchAgent}>
            <Monitor className="w-3.5 h-3.5 mr-2 text-status-success" />
            Open Dev Preview
          </C.Item>
        </C.SubContent>
      </C.Sub>

      {/* Open Panel Palette (flat item) */}
      {onOpenPanelPalette && (
        <C.Item onSelect={onOpenPanelPalette}>
          <LayoutGrid className="w-3.5 h-3.5 mr-2" />
          Open Panel Palette
        </C.Item>
      )}

      {/* Sessions submenu */}
      <C.Sub>
        <C.SubTrigger>
          <Layers className="w-3.5 h-3.5 mr-2" />
          Sessions
        </C.SubTrigger>
        <C.SubContent>
          <C.Item onSelect={onDockAll} disabled={counts.grid === 0}>
            <MoveToDockIcon className="w-3.5 h-3.5 mr-2" />
            Dock All
            <C.Shortcut>({counts.grid})</C.Shortcut>
          </C.Item>
          <C.Item onSelect={onMaximizeAll} disabled={counts.dock === 0}>
            <Maximize2 className="w-3.5 h-3.5 mr-2" />
            Maximize All
            <C.Shortcut>({counts.dock})</C.Shortcut>
          </C.Item>

          <C.Separator />

          <C.Item onSelect={onRestartAll} disabled={counts.active === 0 || isRestartValidating}>
            <RotateCcw
              className={`w-3.5 h-3.5 mr-2 ${isRestartValidating ? "animate-spin" : ""}`}
            />
            {isRestartValidating ? "Checking..." : "Restart All"}
            <C.Shortcut>({counts.active})</C.Shortcut>
          </C.Item>
          <C.Item onSelect={onResetRenderers} disabled={counts.active === 0}>
            <RefreshCw className="w-3.5 h-3.5 mr-2" />
            Reset All Renderers
            <C.Shortcut>({counts.active})</C.Shortcut>
          </C.Item>

          <C.Separator />

          <C.Item onSelect={onCloseCompleted} disabled={counts.completed === 0}>
            Close Completed
            <C.Shortcut>({counts.completed})</C.Shortcut>
          </C.Item>
          <C.Separator />

          <C.Item onSelect={onCloseAll} disabled={counts.active === 0}>
            <Trash2 className="w-3.5 h-3.5 mr-2" />
            Close All (Trash)
            <C.Shortcut>({counts.active})</C.Shortcut>
          </C.Item>
          <C.Item onSelect={onEndAll} disabled={!hasSessions} destructive>
            <X className="w-3.5 h-3.5 mr-2" />
            End All (Kill)
            <C.Shortcut>({counts.all})</C.Shortcut>
          </C.Item>
        </C.SubContent>
      </C.Sub>

      <C.Separator />

      {/* Resource */}
      {hasResourceConfig && (
        <C.Sub>
          <C.SubTrigger>
            <Server className="w-3.5 h-3.5 mr-2" />
            Resource
          </C.SubTrigger>
          <C.SubContent>
            {resourceEnvironmentKeys && resourceEnvironmentKeys.length > 0 && (
              <>
                <C.Sub>
                  <C.SubTrigger>
                    <Server className="w-3.5 h-3.5 mr-2" />
                    Environment
                  </C.SubTrigger>
                  <C.SubContent>
                    {(() => {
                      const isLocalSelected = !worktreeMode || worktreeMode === "local";
                      return (
                        <C.Item
                          onSelect={() => onSwitchEnvironment?.("local")}
                          disabled={!onSwitchEnvironment}
                        >
                          <CircleDot
                            className={`w-3.5 h-3.5 mr-2 ${isLocalSelected ? "text-status-success" : "opacity-0"}`}
                          />
                          Local
                        </C.Item>
                      );
                    })()}
                    {resourceEnvironmentKeys.map((key) => (
                      <C.Item
                        key={key}
                        onSelect={() => onSwitchEnvironment?.(key)}
                        disabled={!onSwitchEnvironment}
                      >
                        <CircleDot
                          className={`w-3.5 h-3.5 mr-2 ${worktreeMode === key ? "text-status-success" : "opacity-0"}`}
                        />
                        {key}
                      </C.Item>
                    ))}
                  </C.SubContent>
                </C.Sub>
                <C.Separator />
              </>
            )}
            {(() => {
              const isLocal = !worktreeMode || worktreeMode === "local";
              return (
                <>
                  <C.Item onSelect={onResourceProvision} disabled={isLocal || !onResourceProvision}>
                    <Play className="w-3.5 h-3.5 mr-2" />
                    Provision
                  </C.Item>
                  <C.Item
                    onSelect={onResourceTeardown}
                    destructive
                    disabled={isLocal || !onResourceTeardown}
                  >
                    <Trash2 className="w-3.5 h-3.5 mr-2" />
                    Teardown
                  </C.Item>
                  <C.Separator />
                  <C.Item onSelect={onResourceResume} disabled={isLocal || !onResourceResume}>
                    <Play className="w-3.5 h-3.5 mr-2 text-status-success" />
                    Resume
                  </C.Item>
                  <C.Item onSelect={onResourcePause} disabled={isLocal || !onResourcePause}>
                    <Pause className="w-3.5 h-3.5 mr-2" />
                    Pause
                  </C.Item>
                  <C.Separator />
                  <C.Item onSelect={onResourceConnect} disabled={isLocal || !onResourceConnect}>
                    <Plug className="w-3.5 h-3.5 mr-2 text-status-info" />
                    Connect
                  </C.Item>
                  <C.Item onSelect={onResourceStatus} disabled={isLocal || !onResourceStatus}>
                    <Activity className="w-3.5 h-3.5 mr-2" />
                    Check Status
                  </C.Item>
                </>
              );
            })()}
          </C.SubContent>
        </C.Sub>
      )}

      <C.Separator />

      {/* Worktree actions (flat) */}
      {onAttachIssue && (
        <C.Item onSelect={onAttachIssue}>
          <Link className="w-3.5 h-3.5 mr-2" />
          {worktree.issueNumber ? "Change Issue..." : "Attach to Issue..."}
        </C.Item>
      )}

      {onViewPlan && (
        <C.Item onSelect={onViewPlan}>
          <FileText className="w-3.5 h-3.5 mr-2" />
          View Plan
        </C.Item>
      )}

      {onOpenReviewHub && (
        <C.Item onSelect={onOpenReviewHub}>
          <GitCommitHorizontal className="w-3.5 h-3.5 mr-2" />
          Review & Commit
        </C.Item>
      )}

      {onCompareDiff && (
        <C.Item onSelect={onCompareDiff}>
          <GitCompare className="w-3.5 h-3.5 mr-2" />
          Compare Worktrees…
        </C.Item>
      )}

      {onRevertAgentChanges && hasSnapshot && (
        <C.Item onSelect={onRevertAgentChanges}>
          <Undo2 className="w-3.5 h-3.5 mr-2" />
          Revert Agent Changes
        </C.Item>
      )}

      {/* Copy Context submenu */}
      <C.Sub>
        <C.SubTrigger>
          <CopyTreeIcon className="w-3.5 h-3.5 mr-2" />
          Copy Context
        </C.SubTrigger>
        <C.SubContent>
          <C.Item onSelect={onCopyContextFull}>Full Context</C.Item>
          <C.Item onSelect={onCopyContextModified}>Modified Files Only</C.Item>
        </C.SubContent>
      </C.Sub>

      <C.Item onSelect={onOpenEditor}>
        <Code className="w-3.5 h-3.5 mr-2" />
        Open in Editor
      </C.Item>
      <C.Item onSelect={onRevealInFinder}>
        <Folder className="w-3.5 h-3.5 mr-2" />
        Reveal in Finder
      </C.Item>
      <C.Item onSelect={onCopyPath}>
        <Copy className="w-3.5 h-3.5 mr-2" />
        Copy Path
      </C.Item>

      {onTogglePin && !worktree.isMainWorktree && (
        <C.Item onSelect={onTogglePin}>
          {isPinned ? (
            <>
              <PinOff className="w-3.5 h-3.5 mr-2" />
              Unpin
            </>
          ) : (
            <>
              <Pin className="w-3.5 h-3.5 mr-2" />
              Pin to Top
            </>
          )}
        </C.Item>
      )}

      {onToggleCollapse && (
        <C.Item onSelect={onToggleCollapse}>
          {isCollapsed ? (
            <>
              <PanelTopOpen className="w-3.5 h-3.5 mr-2" />
              Expand Card
            </>
          ) : (
            <>
              <PanelTopClose className="w-3.5 h-3.5 mr-2" />
              Collapse Card
            </>
          )}
        </C.Item>
      )}

      {/* Issue / PR submenus */}
      {hasIssueOrPrSection && <C.Separator />}
      {hasIssueSub && (
        <C.Sub>
          <C.SubTrigger>
            <CircleDot className="w-3.5 h-3.5 mr-2" />
            Open Issue #{worktree.issueNumber}
          </C.SubTrigger>
          <C.SubContent>
            {onOpenIssuePortal && <C.Item onSelect={onOpenIssuePortal}>In Portal</C.Item>}
            {onOpenIssueExternal && (
              <C.Item onSelect={onOpenIssueExternal}>In External Browser</C.Item>
            )}
          </C.SubContent>
        </C.Sub>
      )}
      {hasPRSub && (
        <C.Sub>
          <C.SubTrigger>
            <GitPullRequest className="w-3.5 h-3.5 mr-2" />
            Open PR #{worktree.prNumber}
          </C.SubTrigger>
          <C.SubContent>
            {onOpenPRPortal && <C.Item onSelect={onOpenPRPortal}>In Portal</C.Item>}
            {onOpenPRExternal && <C.Item onSelect={onOpenPRExternal}>In External Browser</C.Item>}
          </C.SubContent>
        </C.Sub>
      )}

      {/* Recipes */}
      {hasRecipeSection && <C.Separator />}
      {hasRecipes && (
        <C.Sub>
          <C.SubTrigger>
            <TerminalRecipeIcon className="w-3.5 h-3.5 mr-2" />
            Run Recipe
          </C.SubTrigger>
          <C.SubContent>
            {recipes.map((recipe) => (
              <C.Item
                key={recipe.id}
                onSelect={() => onRunRecipe(recipe.id)}
                disabled={runningRecipeId !== null}
              >
                {recipe.name}
              </C.Item>
            ))}
          </C.SubContent>
        </C.Sub>
      )}
      {onSaveLayout && counts.active > 0 && (
        <C.Item onSelect={onSaveLayout}>
          <Save className="w-3.5 h-3.5 mr-2" />
          Save Layout as Recipe
        </C.Item>
      )}

      {/* Delete */}
      {onDeleteWorktree && (
        <>
          <C.Separator />
          <C.Item onSelect={onDeleteWorktree} destructive>
            <Trash2 className="w-3.5 h-3.5 mr-2" />
            Delete Worktree...
          </C.Item>
        </>
      )}
    </>
  );
}
