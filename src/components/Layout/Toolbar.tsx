import {
  Suspense,
  useRef,
  useState,
  useEffect,
  useLayoutEffect,
  useMemo,
  useCallback,
} from "react";
import type React from "react";
import { Button } from "@/components/ui/button";
import {
  GitCommit,
  GitPullRequest,
  CircleDot,
  PanelLeftOpen,
  PanelLeftClose,
  Check,
  ChevronsUpDown,
  MonitorPlay,
  Ellipsis,
  GitBranch,
  FileText,
  Pin,
  PinOff,
  Clipboard,
  Square,
  X,
} from "lucide-react";
import { Spinner } from "@/components/ui/Spinner";
import { Folders, McpServerIcon } from "@/components/icons";
import { TOOLBAR_BUTTON_METADATA, isToolbarButtonVisible } from "./toolbarButtonMetadata";
import { ToolbarContextMenuItems } from "./ToolbarContextMenuItems";
import { cn } from "@/lib/utils";
import { shortcutHintStore } from "@/store/shortcutHintStore";
import { isMac, isLinux, isWindows } from "@/lib/platform";
import { createTooltipContent } from "@/lib/tooltipShortcut";
import { AgentButton } from "./AgentButton";
import { AgentTrayButton, deriveAgentDominantStates } from "./AgentTrayButton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { middleTruncate } from "@/utils/textParsing";
import { useCopyWithFeedback } from "@/hooks/useCopyWithFeedback";
import { useToolbarOverflow } from "@/hooks/useToolbarOverflow";
import { useWorktreeActions } from "@/hooks/useWorktreeActions";
import {
  useAriaKeyshortcuts,
  useDohertyGate,
  useKeepMounted,
  useKeybindingDisplay,
  useShortcutHintHover,
} from "@/hooks";
import type { UseProjectSwitcherPaletteReturn } from "@/hooks";
import type { SearchableProject } from "@/hooks/useProjectSwitcherPalette";
import { useProjectStore } from "@/store/projectStore";
import { useScratchStore } from "@/store/scratchStore";
import { activeWorkspaceIdentity } from "@/lib/workspaceIdentity";
import { usePreferencesStore, useToolbarPreferencesStore, useVoiceRecordingStore } from "@/store";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { useNotificationSettingsStore } from "@/store/notificationSettingsStore";
import type {
  ToolbarButtonId,
  AnyToolbarButtonId,
  PluginToolbarButtonId,
} from "@/../../shared/types/toolbar";
import { usePluginToolbarButtons } from "@/hooks/usePluginToolbarButtons";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import { usePanelStore } from "@/store/panelStore";
import { useShallow } from "zustand/react/shallow";
import { useNotificationHistoryStore } from "@/store/slices/notificationHistorySlice";
import { agentStateDotColor } from "@/components/Worktree/AgentStatusIndicator";
import { notify } from "@/lib/notify";
import type { CliAvailability, AgentSettings, AgentState } from "@shared/types";
import type { ForgeRepositoryStats } from "@shared/types/ipc/forge";
import { isAgentToolbarVisible } from "../../../shared/utils/agentPinned";
import { projectClient } from "@/clients";
import { actionService } from "@/services/ActionService";
import { LazyProjectSwitcherPalette } from "@/lazyPanels";
import { VoiceRecordingToolbarButton } from "./VoiceRecordingToolbarButton";
import { useUIStore } from "@/store/uiStore";
import { ForgeStatsToolbarButton, type ForgeStatsHandle } from "./ForgeStatsToolbarButton";
import { useResolvedForgeProvider } from "@/hooks/useResolvedForgeProvider";
import { NotificationCenterToolbarButton } from "./NotificationCenterToolbarButton";
import { ToolbarLauncherButton } from "./ToolbarLauncherButton";
import { ToolbarCommandPaletteButton } from "./ToolbarCommandPaletteButton";
import { ResumeSessionsToolbarButton } from "./ResumeSessionsToolbarButton";
import { ToolbarSettingsButton } from "./ToolbarSettingsButton";
import { ToolbarProblemsButton } from "./ToolbarProblemsButton";
import { ToolbarPortalButton } from "./ToolbarPortalButton";
import { ToolbarAssistantButton } from "./ToolbarAssistantButton";
import { useOverflowBadgeSeverity, type OverflowBadgeSeverity } from "./useOverflowBadgeSeverity";

import { LAUNCHABLE_AGENT_IDS, isBuiltInAgentId } from "@shared/config/agentIds";

const AGENT_TOOLBAR_IDS = new Set<ToolbarButtonId>([
  "agent-tray",
  ...(LAUNCHABLE_AGENT_IDS as unknown as ToolbarButtonId[]),
]);

type OverflowMenuMeta = { label: string; icon: React.ComponentType<{ className?: string }> };

const toolbarIconButtonClass = "toolbar-icon-button text-daintree-text relative";
// These controls are project-only visually, but their no-drag rectangles must
// exist on first paint so secondary windows don't cache them as titlebar drag.
const PROJECT_SCOPED_TOOLBAR_IDS = new Set<AnyToolbarButtonId>(["dev-server", "forge-stats"]);

// Hardware-privacy indicators stay out of the overflow dropdown while their
// signal is active — collapsing them under `…` would hide the only visual
// cue that the host is recording. Voice recording joins this set only when
// the user is actively recording (see `pinnedRightIds` derivation below);
// future mic/camera/screen-share indicators that follow the same principle
// should be added here.
const VOICE_RECORDING_PINNED: ReadonlySet<AnyToolbarButtonId> = new Set(["voice-recording"]);
const NO_PINNED_IDS: ReadonlySet<AnyToolbarButtonId> = new Set();

// How long the copy-tree button shows the green "context copied" feedback
// before reverting to its idle state. Long enough to register the success,
// short enough that re-clicks don't feel stuck.
const COPY_TREE_FEEDBACK_RESET_MS = 2000;

function ForgeStatsPlaceholder() {
  return (
    <div className="toolbar-stats app-no-drag relative mr-2 flex h-8 w-[13rem] shrink-0 items-center overflow-hidden rounded-[var(--toolbar-pill-radius,0.5rem)] border divide-x divide-[var(--toolbar-stats-divider,var(--theme-border-subtle))] opacity-0 pointer-events-none">
      <div className="h-8 flex-1" />
      <div className="h-8 flex-1" />
      <div className="h-8 flex-1" />
    </div>
  );
}

function DevServerPlaceholder() {
  return (
    <div
      className={cn(toolbarIconButtonClass, "h-9 w-9 opacity-0 pointer-events-none")}
      aria-hidden="true"
    />
  );
}

export function PluginToolbarButton({
  pluginId,
  config,
  "data-toolbar-item": dataToolbarItem,
}: {
  pluginId: PluginToolbarButtonId;
  config: NonNullable<ReturnType<ReturnType<typeof usePluginToolbarButtons>["configs"]["get"]>>;
  "data-toolbar-item"?: string;
}) {
  const hover = useShortcutHintHover(config.actionId);
  const ariaShortcut = useAriaKeyshortcuts(config.actionId);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              {...hover}
              variant="ghost"
              size="icon"
              data-toolbar-item={dataToolbarItem}
              onClick={() => {
                void actionService.dispatch(
                  config.actionId as Parameters<typeof actionService.dispatch>[0],
                  undefined,
                  { source: "user" }
                );
              }}
              className={toolbarIconButtonClass}
              aria-label={config?.label ?? pluginId}
              aria-keyshortcuts={ariaShortcut}
            >
              <McpServerIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{config?.label ?? pluginId}</TooltipContent>
        </Tooltip>
      </ContextMenuTrigger>
      <ContextMenuContent className="max-h-[var(--radix-context-menu-content-available-height)] overflow-y-auto">
        <ToolbarContextMenuItems buttonId={pluginId} side="right" />
      </ContextMenuContent>
    </ContextMenu>
  );
}

// Adapter view over the unified `TOOLBAR_BUTTON_METADATA` registry.
const overflowMenuMetaInit: Record<string, OverflowMenuMeta> = {};
for (const [id, meta] of Object.entries(TOOLBAR_BUTTON_METADATA)) {
  if (!meta) continue;
  overflowMenuMetaInit[id] = { label: meta.label, icon: meta.icon };
}
export const OVERFLOW_MENU_META: Partial<Record<AnyToolbarButtonId, OverflowMenuMeta>> =
  overflowMenuMetaInit;

interface OverflowMenuProps {
  overflowIds: AnyToolbarButtonId[];
  side: "left" | "right";
  severity: OverflowBadgeSeverity;
  errorCount: number;
  notificationUnreadCount: number;
  agentDominantStates: Map<string, AgentState | null>;
  hasActiveWorktree: boolean;
  forgeStatsRef: React.RefObject<ForgeStatsHandle | null>;
  // Display name of the resolved forge provider, or null when none resolves
  // (no matching plugin / owning plugin disabled) — the stats group is
  // skipped entirely in that case.
  forgeProviderName: string | null;
  overflowActions: Partial<Record<AnyToolbarButtonId, () => void>>;
  pluginOverflowMeta: Record<string, OverflowMenuMeta>;
  // Shortcut display strings keyed by toolbar button id, so each overflow item
  // shows the same hint its visible button does (issue #9821).
  shortcutById: Partial<Record<string, string | null>>;
}

// Overflow `…` menu. A component (not just a render helper) so the trigger can
// stay mounted across the empty↔non-empty transition and animate its entry /
// exit via CSS (issue #9821) while `open` stays controlled — avoiding React's
// controlled/uncontrolled warning. Each menu item restores the contextual
// state its source toolbar button carries: error/unread counts, agent-state
// dots, and keyboard shortcut hints.
function OverflowMenu({
  overflowIds,
  side,
  severity,
  errorCount,
  notificationUnreadCount,
  agentDominantStates,
  hasActiveWorktree,
  forgeStatsRef,
  forgeProviderName,
  overflowActions,
  pluginOverflowMeta,
  shortcutById,
}: OverflowMenuProps) {
  const [open, setOpen] = useState(false);
  // Snapshot of the repo stats taken when the menu opens. The stats live in
  // ForgeStatsToolbarButton's hook and are exposed through its imperative
  // handle, so they can't be read during render (refs aren't reactive — the
  // menu wouldn't re-render on updates anyway). Reading in the open handler
  // captures them at the only moment they're about to become visible.
  const [repoStats, setRepoStats] = useState<ForgeRepositoryStats | null>(null);
  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) setRepoStats(forgeStatsRef.current?.stats ?? null);
    setOpen(nextOpen);
  };
  const isEmpty = overflowIds.length === 0;

  // Keep the controlled `open` state in sync when the menu empties: Radix
  // closes the popover when `open` is forced false, but `open` state would
  // stay `true`, so the next non-empty transition would reopen the menu with
  // no user action. Resetting here makes re-appearing overflow start closed.
  useEffect(() => {
    if (isEmpty) setOpen(false);
  }, [isEmpty]);
  // Set in onPointerDownOutside, read in onCloseAutoFocus. Suppresses focus
  // restoration for pointer dismissals so the ellipsis button doesn't keep its
  // accent focus-visible ring; keyboard close (Escape/Enter) still gets default
  // focus return for WAI-ARIA. Local to this component so react-compiler doesn't
  // flag mutating a ref passed in as a prop.
  const overflowMenuPointerCloseRef = useRef(false);

  // Keep the accessible name stable and terse: a comma-enumerated list
  // re-announces the full set on every focus pass and goes stale as
  // resize-driven overflow changes. Surface only the purpose plus a
  // count, escalating the noun to "problem(s)" when severity is
  // actionable (critical/warning) so screen-reader users still learn
  // there's something to act on without the list churn.
  const n = overflowIds.length;
  const hasProblem = severity === "critical" || severity === "warning";
  const tooltipText = hasProblem
    ? `More — ${n} ${n === 1 ? "problem" : "problems"}`
    : `More — ${n} ${n === 1 ? "item" : "items"}`;
  const ariaLabel = hasProblem
    ? `More toolbar items — ${n} ${n === 1 ? "problem" : "problems"} hidden`
    : `More toolbar items — ${n} hidden`;

  const countSuffix = (id: AnyToolbarButtonId) => {
    if (id === "problems" && errorCount > 0) return ` (${errorCount})`;
    if (id === "notification-center" && notificationUnreadCount > 0)
      return ` (${notificationUnreadCount})`;
    return "";
  };

  return (
    <DropdownMenu open={isEmpty ? false : open} onOpenChange={handleOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              data-toolbar-item=""
              data-toolbar-overflow-trigger=""
              data-toolbar-overflow-side={side}
              data-visible={isEmpty ? "false" : "true"}
              aria-hidden={isEmpty || undefined}
              tabIndex={isEmpty ? -1 : undefined}
              className={toolbarIconButtonClass}
              aria-label={ariaLabel}
            >
              <Ellipsis />
              <span
                aria-hidden="true"
                data-testid="toolbar-overflow-badge"
                data-severity={severity}
                data-visible={severity !== null}
                className="toolbar-overflow-badge toolbar-badge absolute top-1.5 right-1.5 h-1.5 w-1.5 pointer-events-none"
              />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">{tooltipText}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        align={side === "left" ? "start" : "end"}
        sideOffset={4}
        onPointerDownOutside={() => {
          overflowMenuPointerCloseRef.current = true;
        }}
        onCloseAutoFocus={(e) => {
          if (overflowMenuPointerCloseRef.current) {
            e.preventDefault();
            overflowMenuPointerCloseRef.current = false;
          }
        }}
      >
        {overflowIds.flatMap((id, idx) => {
          if (id === "forge-stats") {
            const isLast = idx === overflowIds.length - 1;
            // Without a resolved forge provider the visible slot is the
            // commits-only pill — mirror that here: a local-git group with
            // just the commit count (issues/PRs are forge data). The commits
            // dropdown view is provider-supplied, so the no-forge item shows
            // the count without an open action.
            if (!forgeProviderName) {
              return [
                <DropdownMenuGroup key="forge-group">
                  <DropdownMenuLabel>Git</DropdownMenuLabel>
                  <DropdownMenuItem key="forge-commits" disabled>
                    <GitCommit className="mr-2 h-3.5 w-3.5" />
                    Commits {repoStats?.commitCount != null ? `(${repoStats.commitCount})` : ""}
                  </DropdownMenuItem>
                </DropdownMenuGroup>,
                ...(isLast ? [] : [<DropdownMenuSeparator key="forge-sep" />]),
              ];
            }
            return [
              <DropdownMenuGroup key="forge-group">
                <DropdownMenuLabel>{forgeProviderName}</DropdownMenuLabel>
                <DropdownMenuItem
                  key="forge-issues"
                  onClick={() => forgeStatsRef.current?.openIssues()}
                >
                  <CircleDot className="mr-2 h-3.5 w-3.5 text-pr-open" />
                  Issues {repoStats?.issueCount != null ? `(${repoStats.issueCount})` : ""}
                </DropdownMenuItem>
                <DropdownMenuItem key="forge-prs" onClick={() => forgeStatsRef.current?.openPrs()}>
                  <GitPullRequest className="mr-2 h-3.5 w-3.5 text-pr-merged" />
                  Pull Requests {repoStats?.prCount != null ? `(${repoStats.prCount})` : ""}
                </DropdownMenuItem>
                <DropdownMenuItem
                  key="forge-commits"
                  onClick={() => forgeStatsRef.current?.openCommits()}
                >
                  <GitCommit className="mr-2 h-3.5 w-3.5" />
                  Commits {repoStats?.commitCount != null ? `(${repoStats.commitCount})` : ""}
                </DropdownMenuItem>
              </DropdownMenuGroup>,
              ...(isLast ? [] : [<DropdownMenuSeparator key="forge-sep" />]),
            ];
          }
          const meta = OVERFLOW_MENU_META[id] ?? pluginOverflowMeta[id];
          if (!meta) return [];
          if (isBuiltInAgentId(id)) {
            const dominantState = agentDominantStates.get(id) ?? null;
            const dotColor = dominantState ? agentStateDotColor(dominantState) : null;
            return [
              <AgentOverflowItem
                key={id}
                id={id}
                label={meta.label}
                Icon={meta.icon}
                dotColor={dotColor}
                onSelect={() => overflowActions[id]?.()}
              />,
            ];
          }
          const Icon = meta.icon;
          const shortcut = shortcutById[id];
          // Mirror the visible copy-tree button, which is aria-disabled with an
          // "Open a worktree first" tooltip when no worktree is active — without
          // this the overflow item would silently close with no feedback.
          const disabled = id === "copy-tree" && !hasActiveWorktree;
          return [
            <DropdownMenuItem key={id} disabled={disabled} onClick={() => overflowActions[id]?.()}>
              <Icon className="mr-2 h-3.5 w-3.5" />
              <span className="flex-1">
                {meta.label}
                {countSuffix(id)}
              </span>
              {shortcut && <DropdownMenuShortcut>{shortcut}</DropdownMenuShortcut>}
            </DropdownMenuItem>,
          ];
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Overflow menu item for a built-in agent. A standalone component (hoisted, so
// OverflowMenu above can reference it) so the per-agent keybinding lookup
// (`useKeybindingDisplay`) runs at component scope rather than inside a `.map()`
// callback (rules of hooks). Restores the two signals the bare overflow item
// dropped: the colored agent-state dot and the keyboard shortcut hint.
function AgentOverflowItem({
  id,
  label,
  Icon,
  dotColor,
  onSelect,
}: {
  id: string;
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
  dotColor: string | null;
  onSelect: () => void;
}) {
  const shortcut = useKeybindingDisplay(`agent.${id}`);
  return (
    <DropdownMenuItem onClick={onSelect}>
      <span className="relative mr-2 inline-flex h-3.5 w-3.5 items-center justify-center">
        <Icon className="h-3.5 w-3.5" />
        {dotColor && (
          <span
            aria-hidden="true"
            className={cn(
              "absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full ring-1 ring-daintree-bg",
              dotColor
            )}
          />
        )}
      </span>
      <span className="flex-1">{label}</span>
      {shortcut && <DropdownMenuShortcut>{shortcut}</DropdownMenuShortcut>}
    </DropdownMenuItem>
  );
}

interface ToolbarProps {
  onLaunchAgent: (type: string) => void;
  onSettings: () => void;
  onPreloadSettings?: () => void;
  errorCount?: number;
  onToggleProblems?: () => void;
  isFocusMode?: boolean;
  onToggleFocusMode?: () => void;
  agentAvailability?: CliAvailability;
  agentSettings?: AgentSettings | null;
  projectSwitcherPalette: UseProjectSwitcherPaletteReturn;
}

export function Toolbar({
  onLaunchAgent,
  onSettings,
  onPreloadSettings,
  errorCount = 0,
  onToggleProblems,
  isFocusMode = false,
  onToggleFocusMode,
  agentAvailability,
  agentSettings,
  projectSwitcherPalette,
}: ToolbarProps) {
  const currentProject = useProjectStore((state) => state.currentProject);
  const currentScratch = useScratchStore((state) => state.currentScratch);
  const workspaceIdentity = activeWorkspaceIdentity(currentProject, currentScratch);
  const loadProjects = useProjectStore((state) => state.loadProjects);
  const getCurrentProject = useProjectStore((state) => state.getCurrentProject);
  const { entry: forgeProviderEntry } = useResolvedForgeProvider(currentProject?.id ?? null);
  const forgeProviderName = forgeProviderEntry?.contribution.name ?? null;
  const projectSwitcher = projectSwitcherPalette;

  const activeWorktreeId = useWorktreeSelectionStore((state) => state.activeWorktreeId);
  const activeWorktree = useWorktreeStore((state) =>
    activeWorktreeId ? state.worktrees.get(activeWorktreeId) : null
  );
  const branchName = activeWorktree?.branch;
  const watcherDegraded = useWorktreeStore((state) => state.watcherDegraded);
  const topologyWatcherDark = useWorktreeStore((state) => state.topologyWatcherDark);

  // Per-item state for the overflow menu, so evicted buttons keep the signal
  // they carry on the visible toolbar (issue #9821). Reads mirror the
  // selectors used by the source buttons (NotificationCenterToolbarButton,
  // AgentButton) rather than extending useOverflowBadgeSeverity to return a
  // composite map (would risk the selector-identity churn of lesson #3730).
  const notificationUnreadCount = useNotificationHistoryStore((s) => s.unreadCount);
  // Per-agent dominant state across panels in the active worktree, used to draw
  // the agent-state dot on overflow menu items. Shares AgentTrayButton's
  // derivation so the overflow dot matches the visible agent button; computed
  // inside useShallow so agent ticks that don't change a dominant state don't
  // re-render the whole toolbar (issue #7451 pattern).
  const agentDominantStates = usePanelStore(
    useShallow((s) => deriveAgentDominantStates(s.panelsById, s.panelIds, activeWorktreeId))
  );

  useEffect(() => {
    // When the boot payload already seeded the store (#10390), skip the
    // redundant initial getAll/getCurrent pair and only run the background
    // missing-directory validation that boot data can't replace. The
    // getCurrentProject() escape hatch covers project-scoped views that boot
    // before main binds them to a project (retry loop in projectStore).
    const {
      isBootstrapped,
      currentProject: seededProject,
      checkMissingProjects,
    } = useProjectStore.getState();
    if (isBootstrapped) {
      if (!seededProject) {
        void getCurrentProject();
      }
      void checkMissingProjects();
    } else {
      loadProjects();
      getCurrentProject();
    }

    const cleanup = projectClient.onSwitch(() => {
      getCurrentProject();
      loadProjects();
    });

    return cleanup;
  }, [loadProjects, getCurrentProject]);

  const showDeveloperTools = usePreferencesStore((state) => state.showDeveloperTools);
  const notificationsEnabled = useNotificationSettingsStore((s) => s.enabled);
  const toolbarLayout = useToolbarPreferencesStore((state) => state.layout);
  // Live subscription so pin/unpin toggles from the AgentTrayButton immediately
  // update per-agent toolbar button visibility. The `agentSettings` prop is
  // sourced from `useAgentLauncher()`'s local useState which does not react to
  // store mutations, so we prefer the store value when available.
  const liveAgentSettings = useAgentSettingsStore((s) => s.settings);
  const effectiveAgentSettings = liveAgentSettings ?? agentSettings;

  const [isFullscreen, setIsFullscreen] = useState(false);
  const [treeCopied, setTreeCopied] = useState(false);
  const [isCopyingTree, setIsCopyingTree] = useState(false);
  const showCopyingSpinner = useDohertyGate(isCopyingTree);
  const [copyFeedback, setCopyFeedback] = useState<string>("");
  const treeCopyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hasActiveVoiceRecording = useVoiceRecordingStore(
    (state) =>
      state.activeTarget !== null &&
      (state.status === "arming" ||
        state.status === "connecting" ||
        state.status === "recording" ||
        state.status === "paused" ||
        state.status === "finishing")
  );

  const toolbarRef = useRef<HTMLDivElement>(null);
  const leftGroupRef = useRef<HTMLDivElement>(null);
  const rightGroupRef = useRef<HTMLDivElement>(null);
  const activeToolbarIndexRef = useRef<number>(0);
  // Tracks the last toolbar item that received focus. Read in the
  // layout-effect tab-stop sync to detect when that item has been evicted
  // (moved into overflow or unmounted) — in that case the browser drops
  // focus to document.body, and we redirect it to the overflow trigger or
  // nearest visible item to preserve keyboard navigation (WCAG 2.4.3).
  const prevFocusedToolbarItemRef = useRef<HTMLElement | null>(null);
  const forgeStatsRef = useRef<ForgeStatsHandle>(null);

  const { handleCopyTree } = useWorktreeActions();
  const sidebarShortcut = useKeybindingDisplay("nav.toggleSidebar");
  const copyTreeShortcut = useKeybindingDisplay("worktree.copyTree");
  const devServerShortcut = useKeybindingDisplay("devServer.start");
  const notificationsShortcut = useKeybindingDisplay("notifications.toggle");
  const commandPaletteShortcut = useKeybindingDisplay("action.palette.open");
  const resumeSessionsShortcut = useKeybindingDisplay("terminal.resumeSessions");
  const settingsShortcut = useKeybindingDisplay("app.settings");
  const problemsShortcut = useKeybindingDisplay("panel.toggleDiagnostics");
  const terminalShortcut = useKeybindingDisplay("agent.terminal");
  const browserShortcut = useKeybindingDisplay("agent.browser");
  const sidebarAriaShortcut = useAriaKeyshortcuts("nav.toggleSidebar");
  const copyTreeAriaShortcut = useAriaKeyshortcuts("worktree.copyTree");

  const sidebarHintHover = useShortcutHintHover("nav.toggleSidebar");
  const devServerHintHover = useShortcutHintHover("devServer.start");
  const copyTreeHintHover = useShortcutHintHover("worktree.copyTree");

  const handleOpenProjectSettings = useCallback(() => {
    projectSwitcher.close();
    void actionService.dispatch("project.settings.open", undefined, { source: "user" });
  }, [projectSwitcher]);

  const handleStopProject = useCallback(
    (projectId: string) => {
      void projectSwitcher.stopProject(projectId);
    },
    [projectSwitcher]
  );

  const handleCloseProject = useCallback(
    (projectId: string) => {
      void projectSwitcher.removeProject(projectId);
    },
    [projectSwitcher]
  );

  const handleFreeMemoryProject = useCallback(
    (projectId: string) => {
      void projectSwitcher.freeMemoryProject(projectId);
    },
    [projectSwitcher]
  );

  const handleLocateProject = useCallback(
    (projectId: string) => {
      void projectSwitcher.locateProject(projectId);
    },
    [projectSwitcher]
  );

  const handleRemoveConfirmClose = useCallback(() => {
    projectSwitcher.setRemoveConfirmProject(null);
  }, [projectSwitcher]);

  const handleSelectNewWindow = useCallback(
    (project: SearchableProject) => {
      if (project.isMissing) return;
      projectSwitcher.close();
      void actionService.dispatch(
        "app.newWindow",
        { projectPath: project.path },
        { source: "user" }
      );
    },
    [projectSwitcher]
  );

  useEffect(() => {
    return window.electron.window.onFullscreenChange(setIsFullscreen);
  }, []);

  useEffect(() => {
    return () => {
      if (treeCopyTimeoutRef.current) {
        clearTimeout(treeCopyTimeoutRef.current);
      }
    };
  }, []);

  // Promise-method cleanup instead of try/finally: a statement-level finally
  // clause bails React Compiler memoization for the whole Toolbar component.
  const handleCopyTreeClick = useCallback(() => {
    if (isCopyingTree || !activeWorktree) return;

    setIsCopyingTree(true);

    return handleCopyTree(activeWorktree)
      .then((resultMessage) => {
        if (!resultMessage) return;
        setTreeCopied(true);
        setCopyFeedback(resultMessage);
        shortcutHintStore.getState().hide();

        if (treeCopyTimeoutRef.current) {
          clearTimeout(treeCopyTimeoutRef.current);
        }

        treeCopyTimeoutRef.current = setTimeout(() => {
          setTreeCopied(false);
          setCopyFeedback("");
          treeCopyTimeoutRef.current = null;
        }, COPY_TREE_FEEDBACK_RESET_MS);
      })
      .finally(() => {
        setIsCopyingTree(false);
      });
  }, [isCopyingTree, activeWorktree, handleCopyTree]);

  // Copy-tree invoked from the overflow menu. The visible toolbar button shows
  // inline green-tick feedback, but that button is hidden when copy-tree is in
  // overflow — so the overflow path surfaces a transient success toast instead
  // (issue #9821). `transient: true` keeps it out of the inbox: the result is
  // already on the clipboard, so no durable record is warranted.
  const handleCopyTreeOverflow = useCallback(() => {
    if (isCopyingTree || !activeWorktree) return;
    setIsCopyingTree(true);
    return handleCopyTree(activeWorktree)
      .then((resultMessage) => {
        if (!resultMessage) return;
        // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
        notify({
          type: "success",
          title: "Context copied",
          message: resultMessage,
          transient: true,
        });
      })
      .finally(() => {
        setIsCopyingTree(false);
      });
  }, [isCopyingTree, activeWorktree, handleCopyTree]);

  const getToolbarItems = useCallback(
    () =>
      toolbarRef.current
        ? Array.from(
            toolbarRef.current.querySelectorAll<HTMLElement>("[data-toolbar-item]:not([disabled])")
          ).filter(
            // Overflow-hidden buttons use `invisible absolute` Tailwind
            // classes plus aria-hidden="true" on their wrapper. visibility:
            // hidden alone does not null offsetParent, so the aria-hidden
            // ancestor check is the canonical "this item is overflow-hidden,
            // skip it" signal — without it, evicted items stay in the list,
            // get tabIndex assigned, and the overflow focus redirect can
            // never fire.
            (el) => el.offsetParent !== null && el.closest('[aria-hidden="true"]') === null
          )
        : [],
    []
  );

  const syncToolbarTabStops = useCallback((items: HTMLElement[], activeIdx: number) => {
    for (const el of items) el.tabIndex = -1;
    if (items[activeIdx]) items[activeIdx].tabIndex = 0;
  }, []);

  useLayoutEffect(() => {
    const items = getToolbarItems();
    if (items.length === 0) return;
    const clamped = Math.min(activeToolbarIndexRef.current, items.length - 1);
    activeToolbarIndexRef.current = clamped;
    syncToolbarTabStops(items, clamped);

    const prevFocused = prevFocusedToolbarItemRef.current;
    if (prevFocused && !items.includes(prevFocused)) {
      // Clear the ref unconditionally on eviction. If the user has since
      // moved focus into a Radix portal (activeElement !== body), the
      // redirect below is skipped — but the ref must still be cleared so
      // a later unrelated re-render doesn't trigger a phantom redirect.
      prevFocusedToolbarItemRef.current = null;
      if (document.activeElement === document.body) {
        // Redirect to the overflow trigger on the SAME side as the
        // evicted item; falling back to the other side's trigger would
        // pull focus across the toolbar to the wrong group.
        const side = leftGroupRef.current?.contains(prevFocused) ? "left" : "right";
        const sideTrigger = toolbarRef.current?.querySelector<HTMLElement>(
          `[data-toolbar-overflow-trigger][data-toolbar-overflow-side="${side}"]`
        );
        const redirect = sideTrigger && items.includes(sideTrigger) ? sideTrigger : items[clamped];
        redirect?.focus();
      }
    }
  });

  const handleToolbarFocusCapture = useCallback(
    (e: React.FocusEvent<HTMLElement>) => {
      const target = e.target as HTMLElement;
      const items = getToolbarItems();
      const idx = items.indexOf(target);
      if (idx !== -1) {
        activeToolbarIndexRef.current = idx;
        prevFocusedToolbarItemRef.current = target;
        syncToolbarTabStops(items, idx);
      }
    },
    [getToolbarItems, syncToolbarTabStops]
  );

  const handleToolbarKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLElement>) => {
      // React synthetic events bubble through the React tree, so keydowns
      // inside portaled children (Radix DropdownMenu/ContextMenu content
      // rendered in document.body) still reach this handler. The DOM
      // containment check excludes those — portal content is not a DOM
      // descendant of the toolbar — so Arrow keys inside an open menu can
      // navigate the menu instead of being stolen by toolbar roving focus.
      if (!toolbarRef.current?.contains(e.target as Node)) return;

      if (e.metaKey || e.altKey || e.ctrlKey) return;

      const items = getToolbarItems();
      if (items.length === 0) return;

      const currentIdx = activeToolbarIndexRef.current;
      let newIdx: number | null = null;

      switch (e.key) {
        case "ArrowRight":
          newIdx = (currentIdx + 1) % items.length;
          break;
        case "ArrowLeft":
          newIdx = (currentIdx - 1 + items.length) % items.length;
          break;
        case "Home":
          newIdx = 0;
          break;
        case "End":
          newIdx = items.length - 1;
          break;
      }

      if (newIdx !== null) {
        e.preventDefault();
        activeToolbarIndexRef.current = newIdx;
        syncToolbarTabStops(items, newIdx);
        items[newIdx]!.focus();
      }
    },
    [getToolbarItems, syncToolbarTabStops]
  );

  const toolbarDividerClass = "toolbar-divider w-px h-5 mx-1";

  const { buttonIds: pluginButtonIds, configs: pluginConfigs } = usePluginToolbarButtons();

  const buttonRegistry = useMemo<
    Record<string, { render: () => React.ReactNode; isAvailable: boolean }>
  >(
    () => ({
      "sidebar-toggle": {
        render: () => (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                {...sidebarHintHover}
                variant="ghost"
                size="icon"
                data-toolbar-item=""
                data-sidebar-toggle=""
                onClick={onToggleFocusMode}
                className={toolbarIconButtonClass}
                aria-label="Toggle Sidebar"
                aria-pressed={!isFocusMode}
                aria-keyshortcuts={sidebarAriaShortcut}
              >
                {isFocusMode ? <PanelLeftOpen /> : <PanelLeftClose />}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {createTooltipContent(isFocusMode ? "Show Sidebar" : "Hide Sidebar", sidebarShortcut)}
            </TooltipContent>
          </Tooltip>
        ),
        isAvailable: true,
      },
      "agent-tray": {
        render: () => (
          <AgentTrayButton
            key="agent-tray"
            agentAvailability={agentAvailability}
            data-toolbar-item=""
          />
        ),
        isAvailable: true,
      },
      ...Object.fromEntries(
        LAUNCHABLE_AGENT_IDS.map((id) => [
          id,
          {
            render: () => (
              <AgentButton
                key={id}
                type={id}
                availability={agentAvailability?.[id]}
                data-toolbar-item=""
              />
            ),
            isAvailable: isAgentToolbarVisible(
              effectiveAgentSettings?.agents?.[id],
              agentAvailability?.[id]
            ),
          },
        ])
      ),
      terminal: {
        render: () => (
          <ToolbarLauncherButton
            key="terminal"
            type="terminal"
            onLaunchAgent={onLaunchAgent}
            data-toolbar-item=""
          />
        ),
        isAvailable: true,
      },
      browser: {
        render: () => (
          <ToolbarLauncherButton
            key="browser"
            type="browser"
            onLaunchAgent={onLaunchAgent}
            data-toolbar-item=""
          />
        ),
        isAvailable: true,
      },
      "dev-server": {
        render: () =>
          currentProject ? (
            <ContextMenu>
              <ContextMenuTrigger asChild>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      {...devServerHintHover}
                      variant="ghost"
                      size="icon"
                      data-toolbar-item=""
                      onClick={() =>
                        actionService.dispatch("devServer.start", undefined, { source: "user" })
                      }
                      className={toolbarIconButtonClass}
                      aria-label="Open dev preview"
                    >
                      <MonitorPlay />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {createTooltipContent("Open dev preview", devServerShortcut)}
                  </TooltipContent>
                </Tooltip>
              </ContextMenuTrigger>
              <ContextMenuContent className="max-h-[var(--radix-context-menu-content-available-height)] overflow-y-auto">
                <ToolbarContextMenuItems buttonId="dev-server" side="left" />
              </ContextMenuContent>
            </ContextMenu>
          ) : (
            <DevServerPlaceholder />
          ),
        isAvailable: true,
      },
      "voice-recording": {
        // Slot is always available so the right-aligned items keep a stable
        // footprint when a session starts/stops. The button itself returns
        // an invisible placeholder when inactive (mirrors DevServerPlaceholder).
        render: () => <VoiceRecordingToolbarButton key="voice-recording" data-toolbar-item="" />,
        isAvailable: true,
      },
      "forge-stats": {
        // The button owns its own shape now: full three-segment pill with a
        // resolved forge provider, commits-only without one (commit count is
        // local git data). Placeholder (not removal) when no project: the
        // slot's no-drag rectangle must exist on first paint regardless
        // (PROJECT_SCOPED_TOOLBAR_IDS).
        render: () =>
          currentProject ? (
            <ForgeStatsToolbarButton
              key="forge-stats"
              ref={forgeStatsRef}
              currentProject={currentProject}
              data-toolbar-item=""
            />
          ) : (
            <ForgeStatsPlaceholder />
          ),
        isAvailable: true,
      },
      "notification-center": {
        render: () => (
          <NotificationCenterToolbarButton key="notification-center" data-toolbar-item="" />
        ),
        isAvailable: notificationsEnabled,
      },
      "copy-tree": {
        render: () => (
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <Tooltip open={treeCopied || undefined}>
                <TooltipTrigger asChild>
                  <Button
                    {...copyTreeHintHover}
                    variant="ghost"
                    size="icon"
                    data-toolbar-item=""
                    onClick={handleCopyTreeClick}
                    aria-disabled={isCopyingTree || !activeWorktree || undefined}
                    className={cn(
                      "toolbar-icon-button relative",
                      treeCopied ? "text-status-success" : "text-daintree-text",
                      isCopyingTree && "cursor-wait opacity-70",
                      "aria-disabled:opacity-50 aria-disabled:cursor-not-allowed"
                    )}
                    aria-label={
                      isCopyingTree ? "Copying…" : treeCopied ? "Context copied" : "Copy context"
                    }
                    aria-keyshortcuts={copyTreeAriaShortcut}
                  >
                    {showCopyingSpinner ? <Spinner /> : treeCopied ? <Check /> : <Folders />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="font-medium">
                  {isCopyingTree ? (
                    "Copying…"
                  ) : treeCopied ? (
                    <span role="status" aria-live="polite">
                      {copyFeedback}
                    </span>
                  ) : !activeWorktree ? (
                    "Open a worktree first"
                  ) : (
                    createTooltipContent("Copy context", copyTreeShortcut)
                  )}
                </TooltipContent>
              </Tooltip>
            </ContextMenuTrigger>
            <ContextMenuContent className="max-h-[var(--radix-context-menu-content-available-height)] overflow-y-auto">
              <ToolbarContextMenuItems buttonId="copy-tree" side="right" />
            </ContextMenuContent>
          </ContextMenu>
        ),
        isAvailable: true,
      },
      "command-palette": {
        render: () => <ToolbarCommandPaletteButton key="command-palette" data-toolbar-item="" />,
        isAvailable: true,
      },
      "resume-sessions": {
        render: () => <ResumeSessionsToolbarButton key="resume-sessions" data-toolbar-item="" />,
        isAvailable: true,
      },
      settings: {
        render: () => (
          <ToolbarSettingsButton
            key="settings"
            onSettings={onSettings}
            onPreloadSettings={onPreloadSettings}
            data-toolbar-item=""
          />
        ),
        isAvailable: true,
      },
      problems: {
        render: () => (
          <ToolbarProblemsButton
            key="problems"
            errorCount={errorCount}
            watcherDegraded={watcherDegraded}
            topologyWatcherDark={topologyWatcherDark}
            onToggleProblems={onToggleProblems}
            data-toolbar-item=""
          />
        ),
        // Auto-surface the Problems button when file watching is unreliable so
        // the persistent Tier-1 indicator is visible even for users who
        // haven't enabled developer tools (the default).
        isAvailable: showDeveloperTools || watcherDegraded || topologyWatcherDark,
      },
      "assistant-toggle": {
        render: () => <ToolbarAssistantButton key="assistant-toggle" data-toolbar-item="" />,
        isAvailable: true,
      },
      "portal-toggle": {
        render: () => <ToolbarPortalButton key="portal-toggle" data-toolbar-item="" />,
        isAvailable: true,
      },
      ...Object.fromEntries(
        pluginButtonIds.map((pluginId) => {
          const config = pluginConfigs.get(pluginId);
          return [
            pluginId,
            {
              render: () => (
                <PluginToolbarButton key={pluginId} pluginId={pluginId} config={config!} />
              ),
              isAvailable: true,
            },
          ];
        })
      ),
    }),
    [
      isFocusMode,
      onToggleFocusMode,
      agentAvailability,
      effectiveAgentSettings,
      onLaunchAgent,
      sidebarShortcut,
      sidebarAriaShortcut,
      sidebarHintHover,
      copyTreeShortcut,
      copyTreeAriaShortcut,
      copyTreeHintHover,
      currentProject,
      handleCopyTreeClick,
      isCopyingTree,
      showCopyingSpinner,
      activeWorktree,
      treeCopied,
      copyFeedback,
      onSettings,
      onPreloadSettings,
      onToggleProblems,
      errorCount,
      watcherDegraded,
      topologyWatcherDark,
      showDeveloperTools,
      notificationsEnabled,
      pluginButtonIds,
      pluginConfigs,
      devServerShortcut,
      devServerHintHover,
    ]
  );

  const pinnedButtons = toolbarLayout.pinnedButtons;

  const effectiveLeftButtons = useMemo(
    () =>
      // Dedupe defensively so a persisted list holding a repeated id never
      // renders duplicate pills (#10937) — the store also heals this, this is
      // belt-and-suspenders at the render boundary.
      Array.from(new Set(toolbarLayout.leftButtons)).filter((id) =>
        isToolbarButtonVisible(id, pinnedButtons, effectiveAgentSettings, agentAvailability)
      ),
    [toolbarLayout.leftButtons, pinnedButtons, effectiveAgentSettings, agentAvailability]
  );

  const effectiveRightButtons = useMemo(() => {
    // Dedupe the persisted base before appending plugin extras, so duplicate
    // ids (e.g. repeated `forge-stats`, #10937) can't render twice.
    const base = Array.from(new Set(toolbarLayout.rightButtons));
    const existing = new Set(base);
    const extra = pluginButtonIds.filter((id) => !existing.has(id));
    return [...base, ...extra].filter((id) =>
      isToolbarButtonVisible(id, pinnedButtons, effectiveAgentSettings, agentAvailability)
    );
  }, [
    toolbarLayout.rightButtons,
    pluginButtonIds,
    pinnedButtons,
    effectiveAgentSettings,
    agentAvailability,
  ]);

  const availableLeftIds = useMemo(
    () =>
      effectiveLeftButtons.filter(
        (id) => buttonRegistry[id]?.isAvailable || PROJECT_SCOPED_TOOLBAR_IDS.has(id)
      ),
    [effectiveLeftButtons, buttonRegistry]
  );

  const availableRightIds = useMemo(
    () =>
      effectiveRightButtons.filter(
        (id) => buttonRegistry[id]?.isAvailable || PROJECT_SCOPED_TOOLBAR_IDS.has(id)
      ),
    [effectiveRightButtons, buttonRegistry]
  );

  // Pin the voice-recording indicator out of overflow while a recording is
  // active so the user never loses sight of the live mic signal. Applies to
  // whichever side the user has placed the button — overflow honors the
  // pin regardless of left/right placement. The set reference is stabilized
  // so the overflow hook's recalculate callback doesn't re-fire on every
  // render.
  const pinnedIds = hasActiveVoiceRecording ? VOICE_RECORDING_PINNED : NO_PINNED_IDS;

  const { leftVisible, leftOverflow, rightVisible, rightOverflow } = useToolbarOverflow(
    leftGroupRef,
    rightGroupRef,
    availableLeftIds,
    availableRightIds,
    pinnedIds
  );

  // Voice recording reserves layout via an always-available slot but should
  // not pollute the overflow badge or dropdown when no session is active —
  // an inactive placeholder pushed into overflow would otherwise count as a
  // hidden item and trigger the warning severity in useOverflowBadgeSeverity.
  const visibleLeftOverflow = useMemo(
    () =>
      hasActiveVoiceRecording
        ? leftOverflow
        : leftOverflow.filter((id) => id !== "voice-recording"),
    [leftOverflow, hasActiveVoiceRecording]
  );
  const visibleRightOverflow = useMemo(
    () =>
      hasActiveVoiceRecording
        ? rightOverflow
        : rightOverflow.filter((id) => id !== "voice-recording"),
    [rightOverflow, hasActiveVoiceRecording]
  );

  const leftOverflowSeverity = useOverflowBadgeSeverity(visibleLeftOverflow, errorCount);
  const rightOverflowSeverity = useOverflowBadgeSeverity(visibleRightOverflow, errorCount);

  const leftVisibleSet = useMemo(() => new Set<AnyToolbarButtonId>(leftVisible), [leftVisible]);
  const rightVisibleSet = useMemo(() => new Set<AnyToolbarButtonId>(rightVisible), [rightVisible]);

  // Close open dropdowns when their buttons move into overflow
  useEffect(() => {
    const overflowSet = new Set<AnyToolbarButtonId>([...leftOverflow, ...rightOverflow]);
    if (overflowSet.has("forge-stats")) {
      forgeStatsRef.current?.closeAll();
    }
    if (overflowSet.has("notification-center")) {
      useUIStore.getState().closeNotificationCenter();
    }
  }, [leftOverflow, rightOverflow]);

  const renderButtons = (buttonIds: AnyToolbarButtonId[], visibleSet: Set<AnyToolbarButtonId>) => {
    return buttonIds
      .filter((id) => buttonRegistry[id]?.isAvailable)
      .map((id) => (
        <div
          key={id}
          data-toolbar-button-id={id}
          className={cn(
            "app-no-drag",
            !visibleSet.has(id) && "invisible absolute pointer-events-none"
          )}
          aria-hidden={visibleSet.has(id) ? undefined : true}
          data-toolbar-placeholder={
            !currentProject && PROJECT_SCOPED_TOOLBAR_IDS.has(id) ? "true" : undefined
          }
        >
          {buttonRegistry[id]!.render()}
        </div>
      ));
  };

  const renderLeftButtons = (
    buttonIds: AnyToolbarButtonId[],
    visibleSet: Set<AnyToolbarButtonId>
  ) => {
    const available = buttonIds.filter((id) => buttonRegistry[id]?.isAvailable);
    const visible = available.filter((id) => visibleSet.has(id));
    const elements: React.ReactNode[] = [];

    // Render all available items (visible + hidden for measurement)
    for (const id of available) {
      const isVisible = visibleSet.has(id);
      elements.push(
        <div
          key={id}
          data-toolbar-button-id={id}
          className={cn("app-no-drag", !isVisible && "invisible absolute pointer-events-none")}
          aria-hidden={isVisible ? undefined : true}
          data-toolbar-placeholder={
            !currentProject && PROJECT_SCOPED_TOOLBAR_IDS.has(id) ? "true" : undefined
          }
        >
          {buttonRegistry[id]!.render()}
        </div>
      );
    }

    // Insert group dividers between agent and non-agent visible items
    const withDividers: React.ReactNode[] = [];
    let visibleIdx = 0;
    for (const el of elements) {
      withDividers.push(el);
      const key = (el as React.ReactElement).key as string;
      if (visibleSet.has(key as AnyToolbarButtonId)) {
        if (
          visibleIdx < visible.length - 1 &&
          AGENT_TOOLBAR_IDS.has(visible[visibleIdx] as ToolbarButtonId) !==
            AGENT_TOOLBAR_IDS.has(visible[visibleIdx + 1] as ToolbarButtonId)
        ) {
          withDividers.push(
            <div
              key={`group-divider-${visibleIdx}`}
              className={toolbarDividerClass}
              aria-hidden="true"
            />
          );
        }
        visibleIdx++;
      }
    }
    return withDividers;
  };

  const pluginOverflowMeta = useMemo(() => {
    const meta: Record<
      string,
      { label: string; icon: React.ComponentType<{ className?: string }> }
    > = {};
    for (const id of pluginButtonIds) {
      const config = pluginConfigs.get(id);
      if (config) {
        meta[id] = { label: config.label, icon: McpServerIcon };
      }
    }
    return meta;
  }, [pluginButtonIds, pluginConfigs]);

  const overflowActions = useMemo<Partial<Record<AnyToolbarButtonId, () => void>>>(
    () => ({
      ...Object.fromEntries(LAUNCHABLE_AGENT_IDS.map((id) => [id, () => onLaunchAgent(id)])),
      terminal: () => onLaunchAgent("terminal"),
      browser: () => onLaunchAgent("browser"),
      "dev-server": () => {
        void actionService.dispatch("devServer.start", undefined, { source: "user" });
      },
      "notification-center": () => {
        void actionService.dispatch("notifications.toggle", undefined, { source: "user" });
      },
      "copy-tree": () => {
        void handleCopyTreeOverflow();
      },
      "command-palette": () => {
        void actionService.dispatch("action.palette.open", undefined, { source: "user" });
      },
      "resume-sessions": () => {
        void actionService.dispatch("terminal.resumeSessions", undefined, { source: "user" });
      },
      settings: onSettings,
      problems: onToggleProblems,
      ...Object.fromEntries(
        pluginButtonIds.map((id) => {
          const config = pluginConfigs.get(id);
          return [
            id,
            () => {
              if (config) {
                void actionService.dispatch(
                  config.actionId as Parameters<typeof actionService.dispatch>[0],
                  undefined,
                  { source: "user" }
                );
              }
            },
          ];
        })
      ),
    }),
    [
      onLaunchAgent,
      handleCopyTreeOverflow,
      onSettings,
      onToggleProblems,
      pluginButtonIds,
      pluginConfigs,
    ]
  );

  const overflowShortcutById: Partial<Record<string, string | null>> = {
    "copy-tree": copyTreeShortcut,
    "notification-center": notificationsShortcut,
    "command-palette": commandPaletteShortcut,
    "resume-sessions": resumeSessionsShortcut,
    "dev-server": devServerShortcut,
    settings: settingsShortcut,
    problems: problemsShortcut,
    terminal: terminalShortcut,
    browser: browserShortcut,
  };

  const renderOverflowMenu = (
    overflowIds: AnyToolbarButtonId[],
    side: "left" | "right",
    severity: OverflowBadgeSeverity
  ) => (
    <OverflowMenu
      overflowIds={overflowIds}
      side={side}
      severity={severity}
      errorCount={errorCount}
      notificationUnreadCount={notificationUnreadCount}
      agentDominantStates={agentDominantStates}
      hasActiveWorktree={!!activeWorktree}
      forgeStatsRef={forgeStatsRef}
      forgeProviderName={forgeProviderName}
      overflowActions={overflowActions}
      pluginOverflowMeta={pluginOverflowMeta}
      shortcutById={overflowShortcutById}
    />
  );

  const isDropdownOpen = projectSwitcher.isOpen && projectSwitcher.mode === "dropdown";
  const shouldMountProjectSwitcherDropdown = useKeepMounted(isDropdownOpen);
  const handleDropdownClose = useCallback(() => {
    if (projectSwitcher.mode !== "dropdown") return;
    projectSwitcher.close();
  }, [projectSwitcher]);

  // Project pill: Radix Tooltip reopens on focus restoration after the popover
  // or context menu closes. Controlled state + a suppression ref (set in the
  // popover/context-menu close handlers, cleared on the next pointer enter)
  // mirrors the AgentButton pattern so the tooltip doesn't pop on top of a
  // freshly-opened destination surface.
  const [pillTooltipOpen, setPillTooltipOpen] = useState(false);
  const isRestoringFocusPillRef = useRef(false);
  const handlePillTooltipOpenChange = useCallback((open: boolean) => {
    if (open && isRestoringFocusPillRef.current) return;
    setPillTooltipOpen(open);
  }, []);
  const suppressPillTooltipForFocusRestore = useCallback(() => {
    setPillTooltipOpen(false);
    isRestoringFocusPillRef.current = true;
  }, []);
  const clearPillTooltipFocusSuppression = useCallback(() => {
    isRestoringFocusPillRef.current = false;
  }, []);
  const handlePillDropdownClose = useCallback(() => {
    suppressPillTooltipForFocusRestore();
    handleDropdownClose();
  }, [handleDropdownClose, suppressPillTooltipForFocusRestore]);

  const activeSearchableProject = projectSwitcher.activeProject;
  const truncatedBranchName = branchName ? middleTruncate(branchName, 24) : undefined;
  const { copy: copyPillPath } = useCopyWithFeedback({ announcement: "Path copied" });
  const handleCopyProjectPath = useCallback(() => {
    if (!currentProject) return;
    void copyPillPath(currentProject.path);
  }, [currentProject, copyPillPath]);
  const handlePillTogglePin = useCallback(() => {
    if (!currentProject) return;
    void projectSwitcher.togglePinProject(currentProject.id);
  }, [currentProject, projectSwitcher]);

  const projectSwitcherTrigger = (
    <ContextMenuTrigger asChild>
      <TooltipTrigger asChild>
        <button
          data-toolbar-item=""
          className="toolbar-project-pill app-no-drag pointer-events-auto flex h-9 min-w-0 max-w-full items-center justify-center gap-2 overflow-hidden border px-3 outline-hidden focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2"
          data-testid="project-switcher-trigger"
          aria-label={workspaceIdentity.ariaLabel}
          role={workspaceIdentity.kind !== "none" ? "combobox" : undefined}
          aria-haspopup={workspaceIdentity.kind !== "none" ? "listbox" : undefined}
          aria-expanded={workspaceIdentity.kind !== "none" ? isDropdownOpen : undefined}
          onClick={() => projectSwitcher.open("dropdown")}
          onPointerEnter={clearPillTooltipFocusSuppression}
        >
          {workspaceIdentity.kind === "scratch" ? (
            <FileText
              className="h-4 w-4 leading-none shrink-0 text-text-secondary"
              aria-hidden="true"
            />
          ) : (
            <span
              className={cn("text-base leading-none shrink-0", !currentProject && "opacity-0")}
              aria-label={currentProject ? "Project emoji" : undefined}
              aria-hidden={currentProject ? undefined : true}
            >
              {currentProject?.emoji ?? "•"}
            </span>
          )}
          <span
            className={cn(
              "min-w-0 truncate text-xs tracking-wide text-daintree-text",
              workspaceIdentity.kind !== "none" ? "font-semibold" : "font-medium"
            )}
          >
            {workspaceIdentity.name}
          </span>
          {/* Scratch workspaces have no git repo, so the chip is unmounted outright
           * rather than faded — a hidden-but-mounted chip reserves blank pill width
           * (issue #11084). Projects and the pre-hydration "none" state keep the
           * transparent placeholder below: their branch can arrive late (secondary
           * windows hydrate over IPC) or never (detached HEAD), and collapsing the
           * pill mid-hydration is the titlebar shift 88e295a07 fixed. */}
          {workspaceIdentity.kind !== "scratch" && (
            <span
              className={cn(
                "toolbar-project-chip shrink-0 inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 font-mono tabular-nums",
                !branchName && "opacity-0"
              )}
              aria-label={branchName ? `Current branch ${branchName}` : undefined}
              aria-hidden={branchName ? undefined : true}
            >
              <GitBranch className="toolbar-project-chip-icon h-3 w-3 shrink-0" />
              <span className="toolbar-project-chip-label">{truncatedBranchName ?? "main"}</span>
            </span>
          )}
          <ChevronsUpDown className="toolbar-project-meta h-3 w-3 shrink-0" />
        </button>
      </TooltipTrigger>
    </ContextMenuTrigger>
  );

  return (
    <header>
      <div
        ref={toolbarRef}
        role="toolbar"
        aria-label="Main toolbar"
        onKeyDown={handleToolbarKeyDown}
        onFocusCapture={handleToolbarFocusCapture}
        className="@container/toolbar relative z-[60] grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] h-12 items-center px-4 pt-1 shrink-0 app-drag-region surface-toolbar border-b border-divider"
      >
        {!isLinux() && <div className="window-resize-strip" />}

        {/* LEFT GROUP */}
        <div
          role="group"
          aria-label="Navigation and agents"
          className="flex items-center gap-1.5 z-20"
        >
          {isMac() && (
            <div
              data-fullscreen={isFullscreen ? "true" : undefined}
              className={cn(
                "shrink-0 transition-[width] duration-200 data-[fullscreen=true]:duration-120",
                isFullscreen ? "w-0" : "w-16"
              )}
            />
          )}
          <div className="app-no-drag">{buttonRegistry["sidebar-toggle"]!.render()}</div>

          <div className={toolbarDividerClass} />

          <div
            ref={leftGroupRef}
            className="flex flex-1 min-w-0 items-center gap-0.5 overflow-hidden"
          >
            {renderLeftButtons(effectiveLeftButtons, leftVisibleSet)}
          </div>
          <div className="app-no-drag">
            {renderOverflowMenu(visibleLeftOverflow, "left", leftOverflowSeverity)}
          </div>
        </div>

        {/* CENTER GROUP - Grid-centered, shrinks gracefully on narrow windows */}
        <div
          role="group"
          aria-label="Project"
          className="app-no-drag flex items-center justify-center min-w-0 max-w-full pointer-events-none justify-self-center"
        >
          <Tooltip
            open={workspaceIdentity.kind !== "none" ? pillTooltipOpen : false}
            onOpenChange={
              workspaceIdentity.kind !== "none" ? handlePillTooltipOpenChange : undefined
            }
          >
            <ContextMenu>
              {shouldMountProjectSwitcherDropdown ? (
                <Suspense fallback={projectSwitcherTrigger}>
                  <LazyProjectSwitcherPalette
                    mode="dropdown"
                    isOpen={isDropdownOpen}
                    query={projectSwitcher.query}
                    results={projectSwitcher.results}
                    selectedIndex={projectSwitcher.selectedIndex}
                    onQueryChange={projectSwitcher.setQuery}
                    onSelectPrevious={projectSwitcher.selectPrevious}
                    onSelectNext={projectSwitcher.selectNext}
                    onSelect={projectSwitcher.selectProject}
                    onHoverProject={projectSwitcher.onHoverProject}
                    onHoverProjectEnd={projectSwitcher.onHoverProjectEnd}
                    onClose={handlePillDropdownClose}
                    onDropdownCloseAutoFocus={suppressPillTooltipForFocusRestore}
                    onAddProject={projectSwitcher.addProject}
                    onCloneRepo={projectSwitcher.cloneRepo}
                    onStopProject={handleStopProject}
                    onCloseProject={handleCloseProject}
                    onFreeMemoryProject={handleFreeMemoryProject}
                    onLocateProject={handleLocateProject}
                    onTogglePinProject={projectSwitcher.togglePinProject}
                    onCopyPath={projectSwitcher.copyPath}
                    onOpenProjectSettings={currentProject ? handleOpenProjectSettings : undefined}
                    onSelectNewWindow={handleSelectNewWindow}
                    dropdownAlign="center"
                    removeConfirmProject={projectSwitcher.removeConfirmProject}
                    onRemoveConfirmClose={handleRemoveConfirmClose}
                    onConfirmRemove={projectSwitcher.confirmRemoveProject}
                    isRemovingProject={projectSwitcher.isRemovingProject}
                    freeMemoryConfirmProject={projectSwitcher.freeMemoryConfirmProject}
                    onFreeMemoryConfirmClose={() =>
                      projectSwitcher.setFreeMemoryConfirmProject(null)
                    }
                    onConfirmFreeMemory={projectSwitcher.confirmFreeMemory}
                    isFreeingMemory={projectSwitcher.isFreeingMemory}
                    scratchResults={projectSwitcher.scratchResults}
                    onCreateScratch={(name) => void projectSwitcher.createScratch(name)}
                    onSelectScratch={(scratch) => void projectSwitcher.selectScratch(scratch)}
                    onRemoveScratch={(scratchId) =>
                      void projectSwitcher.removeScratchAction(scratchId)
                    }
                    onRenameScratch={(scratchId, name) =>
                      void projectSwitcher.renameScratch(scratchId, name)
                    }
                    onSaveAsProject={(scratchId) => void projectSwitcher.saveAsProject(scratchId)}
                    saveAsProjectConfirm={projectSwitcher.saveAsProjectConfirm}
                    onDismissSaveAsProjectConfirm={projectSwitcher.dismissSaveAsProjectConfirm}
                    onConfirmDeleteOriginalScratch={() =>
                      void projectSwitcher.confirmDeleteOriginalScratch()
                    }
                    isDeletingOriginalScratch={projectSwitcher.isDeletingOriginalScratch}
                  >
                    {projectSwitcherTrigger}
                  </LazyProjectSwitcherPalette>
                </Suspense>
              ) : (
                projectSwitcherTrigger
              )}
              {currentProject && (
                <ContextMenuContent
                  className="max-h-[var(--radix-context-menu-content-available-height)] overflow-y-auto"
                  onCloseAutoFocus={(e) => {
                    suppressPillTooltipForFocusRestore();
                    e.preventDefault();
                  }}
                >
                  <ContextMenuItem onSelect={handlePillTogglePin}>
                    {activeSearchableProject?.isPinned ? (
                      <>
                        <PinOff className="mr-2 h-3.5 w-3.5" />
                        Unpin project
                      </>
                    ) : (
                      <>
                        <Pin className="mr-2 h-3.5 w-3.5" />
                        Pin project
                      </>
                    )}
                  </ContextMenuItem>
                  <ContextMenuItem onSelect={handleCopyProjectPath}>
                    <Clipboard className="mr-2 h-3.5 w-3.5" />
                    Copy path
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem onSelect={handleOpenProjectSettings}>
                    Project settings
                  </ContextMenuItem>
                  {activeSearchableProject && activeSearchableProject.processCount > 0 && (
                    <ContextMenuItem onSelect={() => handleStopProject(currentProject.id)}>
                      <Square className="mr-2 h-3.5 w-3.5" />
                      Stop all agents
                    </ContextMenuItem>
                  )}
                  <ContextMenuItem
                    onSelect={() => handleCloseProject(currentProject.id)}
                    className="text-status-error focus:text-status-error"
                  >
                    <X className="mr-2 h-3.5 w-3.5" />
                    Close project
                  </ContextMenuItem>
                </ContextMenuContent>
              )}
            </ContextMenu>
            {currentProject && (
              <TooltipContent side="bottom" className="max-w-[28rem]">
                <div className="flex flex-col gap-0.5">
                  <div className="text-xs font-medium">
                    {currentProject.name}
                    {branchName ? ` · ${branchName}` : ""}
                  </div>
                  <div className="text-text-muted font-mono text-[11px] truncate">
                    {currentProject.path}
                  </div>
                </div>
              </TooltipContent>
            )}
            {!currentProject && currentScratch && (
              <TooltipContent side="bottom" className="max-w-[28rem]">
                <div className="flex flex-col gap-0.5">
                  <div className="text-xs font-medium">{currentScratch.name}</div>
                  <div className="text-text-muted text-[11px]">Scratch workspace</div>
                </div>
              </TooltipContent>
            )}
          </Tooltip>
        </div>

        {/* RIGHT GROUP */}
        <div
          role="group"
          aria-label="Tools and settings"
          className="flex items-center justify-end gap-1.5 z-20"
        >
          <div
            ref={rightGroupRef}
            className="flex flex-1 min-w-0 items-center gap-0.5 overflow-hidden justify-end"
          >
            {renderButtons(effectiveRightButtons, rightVisibleSet)}
          </div>
          <div className="app-no-drag">
            {renderOverflowMenu(visibleRightOverflow, "right", rightOverflowSeverity)}
          </div>

          <div className={toolbarDividerClass} />

          <div className="app-no-drag flex items-center gap-0.5">
            {buttonRegistry["assistant-toggle"]!.render()}
            {buttonRegistry["portal-toggle"]!.render()}
          </div>

          {isWindows() && (
            <div
              aria-hidden="true"
              data-fullscreen={isFullscreen ? "true" : undefined}
              className={cn(
                "shrink-0 transition-[width] duration-200 data-[fullscreen=true]:duration-120",
                isFullscreen && "w-0"
              )}
              style={
                isFullscreen
                  ? undefined
                  : { width: "calc(100vw - env(titlebar-area-width, calc(100vw - 138px)))" }
              }
            />
          )}
        </div>
      </div>
    </header>
  );
}
