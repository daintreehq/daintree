import { Fragment } from "react";
import type * as React from "react";
import type { WorktreeState } from "../../types";
import {
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuMeta,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
} from "@/components/ui/context-menu";
import {
  Activity,
  ArrowDown,
  ArrowUp,
  CheckSquare,
  Clock,
  Code,
  Copy,
  FileDiff,
  FileText,
  GitBranch,
  GitCommitHorizontal,
  GitCompare,
  GitPullRequest,
  Globe,
  History,
  LayoutGrid,
  Link,
  MonitorPlay,
  OctagonX,
  PanelBottomClose,
  PanelTopClose,
  PanelTopOpen,
  Pause,
  Pin,
  PinOff,
  Play,
  Plug,
  RefreshCw,
  Save,
  Scissors,
  Server,
  Square,
  SquareTerminal,
  Trash2,
  Zap,
} from "lucide-react";
import {
  ArrowUpDown,
  CircleDot,
  FolderOpen,
  Folders,
  FolderTree,
  Layers,
  Link2Off,
  Package,
  Plus,
  ServerCog,
  Workflow,
} from "@/components/icons";
import { copyableBranchName, isExternalWorktree } from "@/lib/worktreeFilters";
import { fileManagerRevealLabel } from "@/lib/platform";
import { useMenuActionSource, type MenuActionSourceValue } from "@/components/ui/menu-source";
import { actionService } from "@/services/ActionService";
import { resourceLifecycleVisibility } from "./utils/resourceLifecycle";
import type { PluginContextMenuItemEntry } from "@/hooks/usePluginContextMenuItems";

type MenuComponent = React.ElementType;
type LaunchAgentIcon = React.ComponentType<{ className?: string }>;

const ICON = "w-3.5 h-3.5 mr-2";

export interface WorktreeMenuComponents {
  Item: MenuComponent;
  Label: MenuComponent;
  Separator: MenuComponent;
  /** Real keybinding hints only. Counts and reasons belong in `Meta`. */
  Shortcut: MenuComponent;
  /** Trailing muted slot for counts, state and disabled reasons. */
  Meta: MenuComponent;
  Sub: MenuComponent;
  SubTrigger: MenuComponent;
  SubContent: MenuComponent;
  RadioGroup: MenuComponent;
  RadioItem: MenuComponent;
}

export const CONTEXT_COMPONENTS: WorktreeMenuComponents = {
  Item: ContextMenuItem,
  Label: ContextMenuLabel,
  Separator: ContextMenuSeparator,
  Shortcut: ContextMenuShortcut,
  Meta: ContextMenuMeta,
  Sub: ContextMenuSub,
  SubTrigger: ContextMenuSubTrigger,
  SubContent: ContextMenuSubContent,
  RadioGroup: ContextMenuRadioGroup,
  RadioItem: ContextMenuRadioItem,
};

export interface WorktreeLaunchAgentItem {
  id: string;
  name: string;
  isEnabled: boolean;
  icon?: LaunchAgentIcon;
}

/**
 * What Daintree can truthfully offer for this worktree's dev server.
 *
 * `restorable` is the state the old menu lied about: a session record exists
 * but nothing is running, so "Restart" was really a start and "Stop" was a
 * no-op row. The distinction is the whole reason this is three states rather
 * than a boolean.
 */
export type WorktreeDevServerMenuState = "running" | "restorable" | "none";

export interface WorktreeMenuItemsProps {
  worktree: WorktreeState;
  components: WorktreeMenuComponents;
  launchAgents: WorktreeLaunchAgentItem[];
  recipes: Array<{ id: string; name: string }>;
  runningRecipeId: string | null;
  isPinned?: boolean;
  counts: {
    grid: number;
    dock: number;
    /** Live PTY-bearing panels for this worktree. */
    active: number;
    completed: number;
    all: number;
    waiting: number;
    working: number;
  };
  onLaunchAgent?: (agentId: string) => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  onCopyContextFull: () => void;
  onCopyContextModified: () => void;
  onCopyPath: () => void;
  onCopyBranchName: () => void;
  onOpenEditor: () => void;
  onRevealInFinder: () => void;
  onOpenIssueExternal?: () => void;
  onOpenPRExternal?: () => void;
  onAttachIssue?: () => void;
  onUnlinkIssue?: () => void;
  onViewPlan?: () => void;
  /** Omitted when the worktree has no changes, so the item is absent then. */
  onOpenChanges?: () => void;
  onOpenReviewHub?: () => void;
  onOpenFileBrowser?: () => void;
  onCompareDiff?: () => void;
  onRunRecipe: (recipeId: string) => void;
  onSaveLayout?: () => void;
  onTogglePin?: () => void;
  onToggleCollapse?: () => void;
  isCollapsed?: boolean;
  onDockAll: () => void;
  onMaximizeAll: () => void;
  onResetRenderers: () => void;
  onSelectAllAgents: () => void;
  onSelectWaitingAgents: () => void;
  onSelectWorkingAgents: () => void;
  onCloseAll: () => void;
  onTerminateAll: () => void;
  onClearHistory: () => void;
  /**
   * Receives the resolved surface source. The callback lives in the card body,
   * outside any menu Root, so it can't resolve `menu` vs `context-menu` itself
   * (#8322) — this component is inside the Root and passes it down.
   */
  onOpenPanelPalette?: (source: MenuActionSourceValue) => void;
  onDeleteWorktree?: () => void;
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
  devServerState?: WorktreeDevServerMenuState;
  onStartDevServer?: (worktreeId: string) => void;
  onStopDevServer?: (worktreeId: string) => void;
  onRestartDevServer?: (worktreeId: string) => void;
  pluginItems?: PluginContextMenuItemEntry[];
}

/**
 * The action/state half of the menu — everything except which menu primitives
 * render it. Both surfaces (card right-click and the ⋯ toolbar dropdown) take
 * this one shape so an item can never be wired into one and missed in the other.
 */
export type WorktreeMenuActions = Omit<
  WorktreeMenuItemsProps,
  "components" | "worktree" | "isPinned"
>;

/** Drops the `false`/`undefined` slots a conditional row leaves behind. */
function compact(...nodes: Array<React.ReactNode | false | undefined>): React.ReactNode[] {
  return nodes.filter((node): node is React.ReactNode => Boolean(node));
}

/**
 * Joins the non-empty root groups with exactly one separator between them.
 *
 * The old menu scattered `{cond && <Separator/>}` through the JSX and relied on
 * each optional group owning the rule after it — which still let a menu whose
 * last group was absent end on an orphan rule. Deciding emptiness first and
 * interleaving afterwards makes a leading, trailing or doubled separator
 * unrepresentable rather than merely untested.
 */
function joinGroups(groups: React.ReactNode[][], Separator: MenuComponent): React.ReactNode[] {
  const populated = groups.filter((group) => group.length > 0);
  return populated.flatMap((group, index) =>
    index === 0 ? group : [<Separator key={`sep-${index}`} />, ...group]
  );
}

export function WorktreeMenuItems({
  worktree,
  components: C,
  launchAgents,
  recipes,
  runningRecipeId,
  isPinned,
  counts,
  onLaunchAgent,
  onMoveUp,
  onMoveDown,
  canMoveUp,
  canMoveDown,
  onCopyContextFull,
  onCopyContextModified,
  onCopyPath,
  onCopyBranchName,
  onOpenEditor,
  onRevealInFinder,
  onOpenIssueExternal,
  onOpenPRExternal,
  onAttachIssue,
  onUnlinkIssue,
  onViewPlan,
  onOpenChanges,
  onOpenReviewHub,
  onOpenFileBrowser,
  onCompareDiff,
  onRunRecipe,
  onSaveLayout,
  onTogglePin,
  onToggleCollapse,
  isCollapsed,
  onDockAll,
  onMaximizeAll,
  onResetRenderers,
  onSelectAllAgents,
  onSelectWaitingAgents,
  onSelectWorkingAgents,
  onCloseAll,
  onTerminateAll,
  onClearHistory,
  onOpenPanelPalette,
  onDeleteWorktree,
  hasResourceConfig,
  worktreeMode,
  resourceEnvironmentKeys,
  onSwitchEnvironment,
  resourceStatus,
  onResourceProvision,
  onResourceResume,
  onResourcePause,
  onResourceConnect,
  onResourceStatus,
  onResourceTeardown,
  devServerState = "none",
  onStartDevServer,
  onStopDevServer,
  onRestartDevServer,
  pluginItems,
}: WorktreeMenuItemsProps) {
  const source = useMenuActionSource();

  /** A count is part of what the row does, so it belongs in the accessible
   *  name too — the muted trailing slot is `aria-hidden` decoration. */
  const counted = (label: string, count: number) => ({
    "aria-label": `${label}, ${count}`,
  });

  // ---------------------------------------------------------------- Launch
  const hasAgentRows = launchAgents.length > 0;
  const launchSub = (
    <C.Sub key="launch">
      <C.SubTrigger>
        <SquareTerminal className={ICON} />
        Launch
      </C.SubTrigger>
      <C.SubContent>
        {hasAgentRows && <C.Label>Agents</C.Label>}
        {launchAgents.map((agent) => {
          const Icon = agent.icon ?? SquareTerminal;
          // Never silently degrade to a plain terminal: an agent that isn't
          // installed says so on the row rather than disappearing or launching
          // something else, and the full launcher below carries the setup route.
          return (
            <C.Item
              key={agent.id}
              onSelect={() => onLaunchAgent?.(agent.id)}
              disabled={!onLaunchAgent || !agent.isEnabled}
              aria-label={agent.isEnabled ? agent.name : `${agent.name}, not installed`}
            >
              <Icon className={ICON} />
              {agent.name}
              {!agent.isEnabled && <C.Meta>Not installed</C.Meta>}
            </C.Item>
          );
        })}
        {hasAgentRows && <C.Separator />}
        <C.Item onSelect={() => onLaunchAgent?.("terminal")} disabled={!onLaunchAgent}>
          <SquareTerminal className={ICON} />
          Terminal
        </C.Item>
        <C.Item onSelect={() => onLaunchAgent?.("browser")} disabled={!onLaunchAgent}>
          <Globe className={ICON} />
          Browser
        </C.Item>
        <C.Item onSelect={() => onLaunchAgent?.("dev-preview")} disabled={!onLaunchAgent}>
          <MonitorPlay className={ICON} />
          Dev preview
        </C.Item>
        {onOpenPanelPalette && (
          <>
            <C.Separator />
            <C.Item onSelect={() => onOpenPanelPalette(source)}>
              <Plus className={ICON} />
              More agents and panels…
            </C.Item>
          </>
        )}
      </C.SubContent>
    </C.Sub>
  );

  // ------------------------------------------------------------------ Open
  const openSub = (
    <C.Sub key="open">
      <C.SubTrigger>
        <FolderOpen className={ICON} />
        Open
      </C.SubTrigger>
      <C.SubContent>
        {onOpenFileBrowser && (
          <C.Item onSelect={onOpenFileBrowser}>
            <FolderTree className={ICON} />
            Browse files
          </C.Item>
        )}
        <C.Item onSelect={onOpenEditor}>
          <Code className={ICON} />
          Open in editor
        </C.Item>
        <C.Item onSelect={onRevealInFinder}>
          <FolderOpen className={ICON} />
          {fileManagerRevealLabel()}
        </C.Item>
      </C.SubContent>
    </C.Sub>
  );

  // ---------------------------------------------------------------- Review
  const changedFileCount = worktree.worktreeChanges?.changes.length ?? 0;
  const reviewRows = [
    onOpenReviewHub && (
      <C.Item key="review-hub" onSelect={onOpenReviewHub}>
        <GitCommitHorizontal className={ICON} />
        Review worktree
      </C.Item>
    ),
    onOpenChanges && (
      <C.Item
        key="open-changes"
        onSelect={onOpenChanges}
        {...counted("View uncommitted changes", changedFileCount)}
      >
        <FileDiff className={ICON} />
        View uncommitted changes
        <C.Meta>{changedFileCount}</C.Meta>
      </C.Item>
    ),
    onCompareDiff && (
      <C.Item key="compare" onSelect={onCompareDiff}>
        <GitCompare className={ICON} />
        Compare with another worktree…
      </C.Item>
    ),
  ].filter(Boolean);

  const reviewSub = reviewRows.length > 0 && (
    <C.Sub key="review">
      <C.SubTrigger>
        <GitCommitHorizontal className={ICON} />
        Review
      </C.SubTrigger>
      <C.SubContent>{reviewRows}</C.SubContent>
    </C.Sub>
  );

  // ------------------------------------------------------------------- Git
  // Shared submenu: #12090 adds pull/push rows and #12092 adds base-branch and
  // recovery rows to this same `gitRows` array. Kept as an array rather than
  // inlined children so those land as additional entries instead of a conflict
  // over one JSX block.
  const gitRows = [
    <C.Item
      key="fetch"
      onSelect={() =>
        void actionService.dispatch("git.fetch", { worktreeId: worktree.id }, { source })
      }
    >
      <RefreshCw className={ICON} />
      Fetch
    </C.Item>,
    <C.Item
      key="fetch-prune"
      onSelect={() =>
        void actionService.dispatch(
          "git.fetch",
          { worktreeId: worktree.id, prune: true },
          { source }
        )
      }
    >
      <Scissors className={ICON} />
      Fetch and prune
    </C.Item>,
  ].filter(Boolean);

  const gitSub = gitRows.length > 0 && (
    <C.Sub key="git">
      <C.SubTrigger>
        <GitBranch className={ICON} />
        Git
      </C.SubTrigger>
      <C.SubContent>{gitRows}</C.SubContent>
    </C.Sub>
  );

  // -------------------------------------------------------------- Sessions
  const hasLivePanels = counts.active > 0;
  const hasFleetTargets = counts.all > 0;
  const sessionsSub = (
    <C.Sub key="sessions">
      <C.SubTrigger>
        <Layers className={ICON} />
        Sessions
      </C.SubTrigger>
      <C.SubContent>
        {hasLivePanels && (
          <>
            <C.Label>Layout</C.Label>
            <C.Item
              onSelect={onDockAll}
              disabled={counts.grid === 0}
              {...counted("Dock all panels", counts.grid)}
            >
              <PanelBottomClose className={ICON} />
              Dock all panels
              <C.Meta>{counts.grid}</C.Meta>
            </C.Item>
            <C.Item
              onSelect={onMaximizeAll}
              disabled={counts.dock === 0}
              {...counted("Move all to grid", counts.dock)}
            >
              <LayoutGrid className={ICON} />
              Move all to grid
              <C.Meta>{counts.dock}</C.Meta>
            </C.Item>
          </>
        )}

        {hasFleetTargets && (
          <>
            <C.Label>Fleet selection</C.Label>
            <C.Item onSelect={onSelectAllAgents} {...counted("Select all terminals", counts.all)}>
              <CheckSquare className={ICON} />
              Select all terminals
              <C.Meta>{counts.all}</C.Meta>
            </C.Item>
            <C.Item
              onSelect={onSelectWaitingAgents}
              disabled={counts.waiting === 0}
              {...counted("Select waiting agents", counts.waiting)}
            >
              <Clock className={ICON} />
              Select waiting agents
              <C.Meta>{counts.waiting}</C.Meta>
            </C.Item>
            <C.Item
              onSelect={onSelectWorkingAgents}
              disabled={counts.working === 0}
              {...counted("Select working agents", counts.working)}
            >
              <Zap className={ICON} />
              Select working agents
              <C.Meta>{counts.working}</C.Meta>
            </C.Item>
          </>
        )}

        {hasLivePanels && (
          <>
            <C.Label>Maintenance</C.Label>
            <C.Item onSelect={onResetRenderers} {...counted("Redraw all terminals", counts.active)}>
              <RefreshCw className={ICON} />
              Redraw all terminals
              <C.Meta>{counts.active}</C.Meta>
            </C.Item>
          </>
        )}

        {(hasLivePanels || hasFleetTargets) && <C.Separator />}

        {/* Deletion, not repair: clearing history destroys journal records
            permanently, so it sits with the destructive pair rather than beside
            renderer maintenance. No count — availability isn't cached, and
            opening a menu must not go and read the journal to find out. */}
        <C.Item onSelect={onClearHistory}>
          <History className={ICON} />
          Clear session history…
        </C.Item>
        <C.Item
          onSelect={onCloseAll}
          disabled={counts.active === 0}
          {...counted("Trash all sessions", counts.active)}
        >
          <Trash2 className={ICON} />
          Trash all sessions…
          <C.Meta>{counts.active}</C.Meta>
        </C.Item>
        <C.Item
          onSelect={onTerminateAll}
          disabled={counts.active === 0}
          {...counted("Terminate all sessions", counts.active)}
        >
          <OctagonX className={ICON} />
          Terminate all sessions…
          <C.Meta>{counts.active}</C.Meta>
        </C.Item>
      </C.SubContent>
    </C.Sub>
  );

  // --------------------------------------------------------------- Recipes
  const hasRecipes = recipes.length > 0;
  const canSaveLayout = Boolean(onSaveLayout) && counts.active > 0;
  const recipesSub = (hasRecipes || canSaveLayout) && (
    <C.Sub key="recipes">
      <C.SubTrigger>
        <Workflow className={ICON} />
        Recipes
      </C.SubTrigger>
      <C.SubContent>
        {hasRecipes && <C.Label>Run</C.Label>}
        {recipes.map((recipe) => (
          <C.Item
            key={recipe.id}
            onSelect={() => onRunRecipe(recipe.id)}
            disabled={runningRecipeId !== null}
            aria-label={
              runningRecipeId !== null ? `${recipe.name}, a recipe is running` : recipe.name
            }
          >
            {recipe.name}
            {runningRecipeId !== null && <C.Meta>Recipe running</C.Meta>}
          </C.Item>
        ))}
        {hasRecipes && canSaveLayout && <C.Separator />}
        {canSaveLayout && (
          <C.Item onSelect={onSaveLayout}>
            <Save className={ICON} />
            Save current layout as recipe…
          </C.Item>
        )}
      </C.SubContent>
    </C.Sub>
  );

  // --------------------------------------------------------------- Runtime
  const hasEnvironments = Boolean(hasResourceConfig) && (resourceEnvironmentKeys?.length ?? 0) > 0;
  const isLocalEnvironment = !worktreeMode || worktreeMode === "local";
  const lifecycle = resourceLifecycleVisibility(resourceStatus);

  const devServerRows = [
    devServerState === "restorable" && onStartDevServer && (
      <C.Item key="start" onSelect={() => onStartDevServer(worktree.id)}>
        <Play className={ICON} />
        Start dev server
      </C.Item>
    ),
    devServerState === "running" && onRestartDevServer && (
      <C.Item key="restart" onSelect={() => onRestartDevServer(worktree.id)}>
        <RefreshCw className={ICON} />
        Restart dev server
      </C.Item>
    ),
    devServerState === "running" && onStopDevServer && (
      <C.Item key="stop" onSelect={() => onStopDevServer(worktree.id)}>
        <Square className={ICON} />
        Stop dev server
      </C.Item>
    ),
  ].filter(Boolean);

  // Resource status is free-form text from the project's own status command, so
  // it can narrow the pair of mutually-exclusive lifecycle rows but must never
  // be the reason a configured command becomes unreachable: an unrecognized
  // status shows both. `Check status`, `Connect` and `Provision` are never
  // status-gated here — a configured command is always offered.
  const showResume = lifecycle.isRecognized ? lifecycle.showResume : true;
  const showPause = lifecycle.isRecognized ? lifecycle.showPause : true;

  // In local mode the six remote commands are not "temporarily unavailable",
  // they don't apply — so the section is just the switcher rather than a wall
  // of disabled rows the user can't act on.
  const environmentRows = hasResourceConfig
    ? [
        hasEnvironments && (
          <C.Sub key="switch-env">
            <C.SubTrigger>
              <Server className={ICON} />
              Switch environment
            </C.SubTrigger>
            <C.SubContent>
              <C.RadioGroup
                value={isLocalEnvironment ? "local" : worktreeMode}
                onValueChange={(value: string) => onSwitchEnvironment?.(value)}
              >
                <C.RadioItem value="local" disabled={!onSwitchEnvironment}>
                  Local
                </C.RadioItem>
                {/* Settings only rejects blank and duplicate environment names,
                    so a key literally called "local" is representable — and it
                    would render a second radio carrying the fixed row's value,
                    leaving two items marked checked. The fixed row already
                    selects it. */}
                {resourceEnvironmentKeys
                  ?.filter((key) => key !== "local")
                  .map((key) => (
                    <C.RadioItem key={key} value={key} disabled={!onSwitchEnvironment}>
                      {key}
                    </C.RadioItem>
                  ))}
              </C.RadioGroup>
            </C.SubContent>
          </C.Sub>
        ),
        !isLocalEnvironment && onResourceStatus && (
          <C.Item key="status" onSelect={onResourceStatus}>
            <Activity className={ICON} />
            Check status
          </C.Item>
        ),
        !isLocalEnvironment && onResourceConnect && (
          <C.Item key="connect" onSelect={onResourceConnect}>
            <Plug className={`${ICON} text-status-info`} />
            Connect
          </C.Item>
        ),
        !isLocalEnvironment && onResourceProvision && (
          <C.Item key="provision" onSelect={onResourceProvision}>
            <Play className={ICON} />
            Provision
          </C.Item>
        ),
        !isLocalEnvironment && onResourceResume && showResume && (
          <C.Item key="resume" onSelect={onResourceResume}>
            <Play className={`${ICON} text-status-success`} />
            Resume
          </C.Item>
        ),
        !isLocalEnvironment && onResourcePause && showPause && (
          <C.Item key="pause" onSelect={onResourcePause}>
            <Pause className={ICON} />
            Pause
          </C.Item>
        ),
      ].filter(Boolean)
    : [];

  const teardownRow = hasResourceConfig && !isLocalEnvironment && onResourceTeardown && (
    <C.Item key="teardown" onSelect={onResourceTeardown} destructive>
      <Trash2 className={ICON} />
      Tear down environment…
    </C.Item>
  );

  const hasEnvironmentSection = environmentRows.length > 0 || Boolean(teardownRow);
  const runtimeSub = (devServerRows.length > 0 || hasEnvironmentSection) && (
    <C.Sub key="runtime">
      <C.SubTrigger>
        <ServerCog className={ICON} />
        Runtime
      </C.SubTrigger>
      <C.SubContent>
        {devServerRows.length > 0 && (
          <>
            <C.Label>Dev server</C.Label>
            {devServerRows}
          </>
        )}
        {hasEnvironmentSection && (
          <>
            <C.Label>Environment</C.Label>
            {environmentRows}
            {teardownRow && environmentRows.length > 0 && <C.Separator />}
            {teardownRow}
          </>
        )}
      </C.SubContent>
    </C.Sub>
  );

  // ----------------------------------------------------------- Linked work
  const hasIssue = Boolean(worktree.issueNumber);
  const hasIssueItem = hasIssue && Boolean(onOpenIssueExternal);
  const hasPRItem = Boolean(worktree.linked?.pr && onOpenPRExternal);
  const linkedOpenRows = [
    onViewPlan && (
      <C.Item key="plan" onSelect={onViewPlan}>
        <FileText className={ICON} />
        View plan
      </C.Item>
    ),
    hasIssueItem && (
      <C.Item key="issue" onSelect={onOpenIssueExternal}>
        <CircleDot className={ICON} />
        Open issue #{worktree.issueNumber}
      </C.Item>
    ),
    hasPRItem && (
      <C.Item key="pr" onSelect={onOpenPRExternal}>
        <GitPullRequest className={ICON} />
        Open PR #{worktree.linked?.pr?.ref.number}
      </C.Item>
    ),
  ].filter(Boolean);

  const linkedAssociationRows = [
    onAttachIssue && (
      <C.Item key="attach" onSelect={onAttachIssue}>
        <Link className={ICON} />
        {hasIssue ? "Change linked issue…" : "Attach issue…"}
      </C.Item>
    ),
    hasIssue && onUnlinkIssue && (
      <C.Item key="unlink" onSelect={onUnlinkIssue}>
        <Link2Off className={ICON} />
        Unlink issue #{worktree.issueNumber}
      </C.Item>
    ),
  ].filter(Boolean);

  const linkedWorkSub = (linkedOpenRows.length > 0 || linkedAssociationRows.length > 0) && (
    <C.Sub key="linked-work">
      <C.SubTrigger>
        <Link className={ICON} />
        Linked work
      </C.SubTrigger>
      <C.SubContent>
        {linkedOpenRows}
        {linkedOpenRows.length > 0 && linkedAssociationRows.length > 0 && <C.Separator />}
        {linkedAssociationRows}
      </C.SubContent>
    </C.Sub>
  );

  // ------------------------------------------------------------------ Copy
  const canCopyBranchName = copyableBranchName(worktree) !== null;
  const copySub = (
    <C.Sub key="copy">
      <C.SubTrigger>
        <Copy className={ICON} />
        Copy
      </C.SubTrigger>
      <C.SubContent>
        <C.Item onSelect={onCopyContextFull}>
          <Folders className={ICON} />
          Full context
        </C.Item>
        <C.Item onSelect={onCopyContextModified}>
          <FileDiff className={ICON} />
          Modified files only
        </C.Item>
        <C.Separator />
        <C.Item onSelect={onCopyPath}>
          <Copy className={ICON} />
          Path
        </C.Item>
        {canCopyBranchName && (
          <C.Item onSelect={onCopyBranchName}>
            <GitBranch className={ICON} />
            Branch name
          </C.Item>
        )}
      </C.SubContent>
    </C.Sub>
  );

  // -------------------------------------------------------------- Organize
  const canPin = Boolean(onTogglePin) && !worktree.isMainWorktree && !isExternalWorktree(worktree);
  const hasMoveRows = Boolean(onMoveUp || onMoveDown);
  const organizeSub = (canPin || onToggleCollapse || hasMoveRows) && (
    <C.Sub key="organize">
      <C.SubTrigger>
        <ArrowUpDown className={ICON} />
        Organize
      </C.SubTrigger>
      <C.SubContent>
        {canPin && (
          <C.Item onSelect={onTogglePin}>
            {isPinned ? (
              <>
                <PinOff className={ICON} />
                Unpin
              </>
            ) : (
              <>
                <Pin className={ICON} />
                Pin to top
              </>
            )}
          </C.Item>
        )}
        {onToggleCollapse && (
          <C.Item onSelect={onToggleCollapse}>
            {isCollapsed ? (
              <>
                <PanelTopOpen className={ICON} />
                Expand card
              </>
            ) : (
              <>
                <PanelTopClose className={ICON} />
                Collapse card
              </>
            )}
          </C.Item>
        )}
        {hasMoveRows && (canPin || onToggleCollapse) && <C.Separator />}
        {hasMoveRows && (
          <>
            <C.Item onSelect={onMoveUp} disabled={!onMoveUp || !canMoveUp}>
              <ArrowUp className={ICON} />
              Move up
            </C.Item>
            <C.Item onSelect={onMoveDown} disabled={!onMoveDown || !canMoveDown}>
              <ArrowDown className={ICON} />
              Move down
            </C.Item>
          </>
        )}
      </C.SubContent>
    </C.Sub>
  );

  // ------------------------------------------------------------ Extensions
  // Plugin contributions used to trail the root menu AFTER `Delete worktree…`,
  // which broke the one structural promise a menu makes: destruction ends it.
  // Nesting them keeps the root stable however many plugins are installed, and
  // makes it impossible for a third party to render past deletion.
  const pluginsById = new Map<string, PluginContextMenuItemEntry[]>();
  for (const entry of pluginItems ?? []) {
    const bucket = pluginsById.get(entry.pluginId);
    if (bucket) bucket.push(entry);
    else pluginsById.set(entry.pluginId, [entry]);
  }
  const pluginGroups = [...pluginsById.entries()];
  const extensionsSub = pluginGroups.length > 0 && (
    <C.Sub key="extensions">
      <C.SubTrigger>
        <Package className={ICON} />
        Extensions
      </C.SubTrigger>
      <C.SubContent>
        {pluginGroups.map(([pluginId, entries], groupIndex) => (
          <Fragment key={pluginId}>
            {pluginGroups.length > 1 && groupIndex > 0 && <C.Separator />}
            {pluginGroups.length > 1 && <C.Label>{pluginId}</C.Label>}
            {entries.map((entry) => (
              <C.Item
                key={`${entry.pluginId}:${entry.item.actionId}`}
                onSelect={() =>
                  void actionService.dispatch(entry.item.actionId, undefined, { source })
                }
              >
                <span className="truncate">{entry.item.label}</span>
              </C.Item>
            ))}
          </Fragment>
        ))}
      </C.SubContent>
    </C.Sub>
  );

  // ---------------------------------------------------------------- Delete
  // The main worktree cannot be deleted, and the card already withholds the
  // callback for it. Restating the rule here is deliberate: pinning is gated
  // the same way, and a shared menu that renders a destructive row purely on
  // callback presence puts the whole safeguard in one caller's hands.
  const deleteItem = onDeleteWorktree && !worktree.isMainWorktree && (
    <C.Item key="delete" onSelect={onDeleteWorktree} destructive>
      <Trash2 className={ICON} />
      Delete worktree…
    </C.Item>
  );

  const rows = joinGroups(
    [
      compact(launchSub, openSub, reviewSub, gitSub),
      compact(sessionsSub, recipesSub, runtimeSub),
      compact(linkedWorkSub, copySub, organizeSub, extensionsSub),
      compact(deleteItem),
    ],
    C.Separator
  );

  return <>{rows}</>;
}
