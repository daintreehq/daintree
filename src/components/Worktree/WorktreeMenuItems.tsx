import type * as React from "react";
import type { WorktreeState } from "../../types";
import {
  ArrowDownToLine,
  CircleDot,
  Code,
  Copy,
  Folder,
  GitPullRequest,
  Globe,
  Layers,
  Link,
  Maximize2,
  Minimize2,
  Pin,
  PinOff,
  Play,
  RefreshCw,
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
  isPinned?: boolean;
  hasFocusedTerminal: boolean;
  counts: {
    grid: number;
    dock: number;
    active: number;
    completed: number;
    failed: number;
    all: number;
  };
  onLaunchAgent?: (agentId: string) => void;
  onCopyContextFull: () => void;
  onCopyContextModified: () => void;
  onInjectContext: () => void;
  onOpenEditor: () => void;
  onRevealInFinder: () => void;
  onOpenIssueSidecar?: () => void;
  onOpenIssueExternal?: () => void;
  onOpenPRSidecar?: () => void;
  onOpenPRExternal?: () => void;
  onAttachIssue?: () => void;
  onRunRecipe: (recipeId: string) => void;
  onSaveLayout?: () => void;
  onTogglePin?: () => void;
  onMinimizeAll: () => void;
  onMaximizeAll: () => void;
  onRestartAll: () => void;
  onResetRenderers: () => void;
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
  isPinned,
  hasFocusedTerminal,
  counts,
  onLaunchAgent,
  onCopyContextFull,
  onCopyContextModified,
  onInjectContext,
  onOpenEditor,
  onRevealInFinder,
  onOpenIssueSidecar,
  onOpenIssueExternal,
  onOpenPRSidecar,
  onOpenPRExternal,
  onAttachIssue,
  onRunRecipe,
  onSaveLayout,
  onTogglePin,
  onMinimizeAll,
  onMaximizeAll,
  onRestartAll,
  onResetRenderers,
  onCloseCompleted,
  onCloseFailed,
  onCloseAll,
  onEndAll,
  onDeleteWorktree,
}: WorktreeMenuItemsProps) {
  const hasIssueSub = Boolean(worktree.issueNumber && (onOpenIssueSidecar || onOpenIssueExternal));
  const hasPRSub = Boolean(worktree.prNumber && (onOpenPRSidecar || onOpenPRExternal));
  const hasIssueOrPrSection = hasIssueSub || hasPRSub;
  const hasRecipes = recipes.length > 0;
  const hasRecipeSection = hasRecipes || (onSaveLayout && counts.active > 0);
  const hasSessions = counts.all > 0;

  return (
    <>
      {/* Launch submenu */}
      <C.Sub>
        <C.SubTrigger>
          <Terminal className="w-3.5 h-3.5 mr-2" />
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
                  <Terminal className="w-3.5 h-3.5 mr-2" />
                )}
                {agent.name}
              </C.Item>
            );
          })}
          {launchAgents.length > 0 && <C.Separator />}
          <C.Item onSelect={() => onLaunchAgent?.("terminal")} disabled={!onLaunchAgent}>
            <Terminal className="w-3.5 h-3.5 mr-2" />
            Open Terminal
          </C.Item>
          <C.Item onSelect={() => onLaunchAgent?.("browser")} disabled={!onLaunchAgent}>
            <Globe className="w-3.5 h-3.5 mr-2 text-blue-400" />
            Open Browser
          </C.Item>
        </C.SubContent>
      </C.Sub>

      {/* Sessions submenu */}
      <C.Sub>
        <C.SubTrigger>
          <Layers className="w-3.5 h-3.5 mr-2" />
          Sessions
        </C.SubTrigger>
        <C.SubContent>
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
        </C.SubContent>
      </C.Sub>

      <C.Separator />

      {/* Worktree actions (flat) */}
      {onAttachIssue && (
        <C.Item onSelect={onAttachIssue}>
          <Link className="w-3.5 h-3.5 mr-2" />
          {worktree.issueNumber ? "Change Issue..." : "Attach to Issue..."}
        </C.Item>
      )}

      {/* Copy Context submenu */}
      <C.Sub>
        <C.SubTrigger>
          <Copy className="w-3.5 h-3.5 mr-2" />
          Copy Context
        </C.SubTrigger>
        <C.SubContent>
          <C.Item onSelect={onCopyContextFull}>Full Context</C.Item>
          <C.Item onSelect={onCopyContextModified}>Modified Files Only</C.Item>
        </C.SubContent>
      </C.Sub>

      <C.Item onSelect={onInjectContext} disabled={!hasFocusedTerminal}>
        <ArrowDownToLine className="w-3.5 h-3.5 mr-2" />
        Inject Context into Focused Terminal
      </C.Item>

      <C.Item onSelect={onOpenEditor}>
        <Code className="w-3.5 h-3.5 mr-2" />
        Open in Editor
      </C.Item>
      <C.Item onSelect={onRevealInFinder}>
        <Folder className="w-3.5 h-3.5 mr-2" />
        Reveal in Finder
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

      {/* Issue / PR submenus */}
      {hasIssueOrPrSection && <C.Separator />}
      {hasIssueSub && (
        <C.Sub>
          <C.SubTrigger>
            <CircleDot className="w-3.5 h-3.5 mr-2" />
            Open Issue #{worktree.issueNumber}
          </C.SubTrigger>
          <C.SubContent>
            {onOpenIssueSidecar && <C.Item onSelect={onOpenIssueSidecar}>In Sidecar</C.Item>}
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
            {onOpenPRSidecar && <C.Item onSelect={onOpenPRSidecar}>In Sidecar</C.Item>}
            {onOpenPRExternal && <C.Item onSelect={onOpenPRExternal}>In External Browser</C.Item>}
          </C.SubContent>
        </C.Sub>
      )}

      {/* Recipes */}
      {hasRecipeSection && <C.Separator />}
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

      {/* Delete */}
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
