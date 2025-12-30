import type * as React from "react";
import type { WorktreeState } from "../../types";
import {
  Code,
  CircleDot,
  Copy,
  Folder,
  GitPullRequest,
  Globe,
  Maximize2,
  Minimize2,
  Play,
  RotateCcw,
  Save,
  Terminal,
  Trash2,
  X,
} from "lucide-react";

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
  counts: {
    grid: number;
    dock: number;
    active: number;
    completed: number;
    failed: number;
    all: number;
  };
  onLaunchAgent?: (agentId: string) => void;
  onCopyContext: () => void;
  onOpenEditor: () => void;
  onRevealInFinder: () => void;
  onOpenIssue?: () => void;
  onOpenPR?: () => void;
  onRunRecipe: (recipeId: string) => void;
  onSaveLayout?: () => void;
  onMinimizeAll: () => void;
  onMaximizeAll: () => void;
  onRestartAll: () => void;
  onCloseCompleted: () => void;
  onCloseFailed: () => void;
  onCloseAll: () => void;
  onEndAll: () => void;
  onDeleteWorktree?: () => void;
}

export function WorktreeMenuItems({
  worktree,
  components: C,
  launchAgents,
  recipes,
  runningRecipeId,
  isRestartValidating,
  counts,
  onLaunchAgent,
  onCopyContext,
  onOpenEditor,
  onRevealInFinder,
  onOpenIssue,
  onOpenPR,
  onRunRecipe,
  onSaveLayout,
  onMinimizeAll,
  onMaximizeAll,
  onRestartAll,
  onCloseCompleted,
  onCloseFailed,
  onCloseAll,
  onEndAll,
  onDeleteWorktree,
}: WorktreeMenuItemsProps) {
  const hasIssueOrPr = Boolean(worktree.issueNumber || worktree.prNumber);
  const hasRecipes = recipes.length > 0;
  const hasRecipeSection = hasRecipes || (onSaveLayout && counts.active > 0);
  const hasSessions = counts.all > 0;

  return (
    <>
      <C.Label>Launch</C.Label>
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
              <Terminal className="w-3.5 h-3.5 mr-2" />
            )}
            {agent.name}
          </C.Item>
        );
      })}
      <C.Item onSelect={() => onLaunchAgent?.("terminal")} disabled={!onLaunchAgent}>
        <Terminal className="w-3.5 h-3.5 mr-2" />
        Open Terminal
      </C.Item>
      <C.Item onSelect={() => onLaunchAgent?.("browser")} disabled={!onLaunchAgent}>
        <Globe className="w-3.5 h-3.5 mr-2 text-blue-400" />
        Open Browser
      </C.Item>

      <C.Separator />

      <C.Label>Sessions</C.Label>
      <C.Item onSelect={onMinimizeAll} disabled={counts.grid === 0}>
        <Minimize2 className="w-3.5 h-3.5 mr-2" />
        Minimize All
        <C.Shortcut>({counts.grid})</C.Shortcut>
      </C.Item>
      <C.Item onSelect={onMaximizeAll} disabled={counts.dock === 0}>
        <Maximize2 className="w-3.5 h-3.5 mr-2" />
        Maximize All
        <C.Shortcut>({counts.dock})</C.Shortcut>
      </C.Item>
      <C.Item onSelect={onRestartAll} disabled={counts.active === 0 || isRestartValidating}>
        <RotateCcw className={`w-3.5 h-3.5 mr-2 ${isRestartValidating ? "animate-spin" : ""}`} />
        {isRestartValidating ? "Checking..." : "Restart All"}
        <C.Shortcut>({counts.active})</C.Shortcut>
      </C.Item>

      <C.Separator />

      <C.Item onSelect={onCloseCompleted} disabled={counts.completed === 0}>
        Close Completed
        <C.Shortcut>({counts.completed})</C.Shortcut>
      </C.Item>
      <C.Item onSelect={onCloseFailed} disabled={counts.failed === 0}>
        Close Failed
        <C.Shortcut>({counts.failed})</C.Shortcut>
      </C.Item>

      <C.Separator />

      <C.Item onSelect={onCloseAll} disabled={counts.active === 0}>
        <Trash2 className="w-3.5 h-3.5 mr-2" />
        Close All (Trash)
        <C.Shortcut>({counts.active})</C.Shortcut>
      </C.Item>
      <C.Item
        onSelect={onEndAll}
        disabled={!hasSessions}
        className="text-[var(--color-status-error)] focus:text-[var(--color-status-error)]"
      >
        <X className="w-3.5 h-3.5 mr-2" />
        End All (Kill)
        <C.Shortcut>({counts.all})</C.Shortcut>
      </C.Item>

      <C.Separator />

      <C.Label>Worktree</C.Label>
      <C.Item onSelect={onCopyContext}>
        <Copy className="w-3.5 h-3.5 mr-2" />
        Copy Context
      </C.Item>
      <C.Item onSelect={onOpenEditor}>
        <Code className="w-3.5 h-3.5 mr-2" />
        Open in Editor
      </C.Item>
      <C.Item onSelect={onRevealInFinder}>
        <Folder className="w-3.5 h-3.5 mr-2" />
        Reveal in Finder
      </C.Item>

      {hasIssueOrPr && <C.Separator />}
      {worktree.issueNumber && onOpenIssue && (
        <C.Item onSelect={onOpenIssue}>
          <CircleDot className="w-3.5 h-3.5 mr-2" />
          Open Issue #{worktree.issueNumber}
        </C.Item>
      )}
      {worktree.prNumber && onOpenPR && (
        <C.Item onSelect={onOpenPR}>
          <GitPullRequest className="w-3.5 h-3.5 mr-2" />
          Open PR #{worktree.prNumber}
        </C.Item>
      )}

      {hasRecipeSection && <C.Separator />}

      {hasRecipeSection && (
        <>
          <C.Label>Recipes</C.Label>
          {hasRecipes && (
            <C.Sub>
              <C.SubTrigger>
                <Play className="w-3.5 h-3.5 mr-2" />
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
        </>
      )}

      {onDeleteWorktree && (
        <>
          <C.Separator />
          <C.Item
            onSelect={onDeleteWorktree}
            className="text-[var(--color-status-error)] focus:text-[var(--color-status-error)]"
          >
            <Trash2 className="w-3.5 h-3.5 mr-2" />
            Delete Worktree...
          </C.Item>
        </>
      )}
    </>
  );
}
