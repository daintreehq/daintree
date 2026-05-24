import { useRef, useState, useEffect, useLayoutEffect, useMemo, useCallback } from "react";
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
  Pin,
  PinOff,
  Clipboard,
  Square,
  Unplug,
  X,
} from "lucide-react";
import { Spinner } from "@/components/ui/Spinner";
import { Folders, McpServerIcon } from "@/components/icons";
import { TOOLBAR_BUTTON_METADATA, isToolbarButtonVisible } from "./toolbarButtonMetadata";
import { cn } from "@/lib/utils";
import { shortcutHintStore } from "@/store/shortcutHintStore";
import { isMac, isLinux, isWindows } from "@/lib/platform";
import { createTooltipContent } from "@/lib/tooltipShortcut";
import { AgentButton } from "./AgentButton";
import { AgentTrayButton } from "./AgentTrayButton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ShortcutRevealChip } from "@/components/ui/ShortcutRevealChip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
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
  useKeybindingDisplay,
  useShortcutHintHover,
} from "@/hooks";
import type { UseProjectSwitcherPaletteReturn } from "@/hooks";
import type { SearchableProject } from "@/hooks/useProjectSwitcherPalette";
import { useProjectStore } from "@/store/projectStore";
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
import type { CliAvailability, AgentSettings } from "@shared/types";
import { isAgentToolbarVisible } from "../../../shared/utils/agentPinned";
import { projectClient } from "@/clients";
import { actionService } from "@/services/ActionService";
import { ProjectSwitcherPalette } from "@/components/Project/ProjectSwitcherPalette";
import { VoiceRecordingToolbarButton } from "./VoiceRecordingToolbarButton";
import { useUIStore } from "@/store/uiStore";
import { GitHubStatsToolbarButton, type GitHubStatsHandle } from "./GitHubStatsToolbarButton";
import { NotificationCenterToolbarButton } from "./NotificationCenterToolbarButton";
import { ToolbarLauncherButton } from "./ToolbarLauncherButton";
import { ToolbarCommandPaletteButton } from "./ToolbarCommandPaletteButton";
import { ToolbarSettingsButton } from "./ToolbarSettingsButton";
import { ToolbarProblemsButton } from "./ToolbarProblemsButton";
import { ToolbarPortalButton } from "./ToolbarPortalButton";
import { ToolbarAssistantButton } from "./ToolbarAssistantButton";
import { useOverflowBadgeSeverity, type OverflowBadgeSeverity } from "./useOverflowBadgeSeverity";

import { BUILT_IN_AGENT_IDS } from "@shared/config/agentIds";

const AGENT_TOOLBAR_IDS = new Set<ToolbarButtonId>([
  "agent-tray",
  ...(BUILT_IN_AGENT_IDS as unknown as ToolbarButtonId[]),
]);

type OverflowMenuMeta = { label: string; icon: React.ComponentType<{ className?: string }> };

const toolbarIconButtonClass = "toolbar-icon-button text-daintree-text relative";
// These controls are project-only visually, but their no-drag rectangles must
// exist on first paint so secondary windows don't cache them as titlebar drag.
const PROJECT_SCOPED_TOOLBAR_IDS = new Set<AnyToolbarButtonId>(["dev-server", "github-stats"]);

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

function GitHubStatsPlaceholder() {
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
  const hover = useShortcutHintHover(config.actionId as string);
  const toggleButtonVisibility = useToolbarPreferencesStore((s) => s.toggleButtonVisibility);

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
            >
              <McpServerIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{config?.label ?? pluginId}</TooltipContent>
        </Tooltip>
      </ContextMenuTrigger>
      <ContextMenuContent className="max-h-[var(--radix-context-menu-content-available-height)] overflow-y-auto">
        <ContextMenuItem onSelect={() => toggleButtonVisibility(pluginId, "right")}>
          <Unplug className="mr-2 h-3.5 w-3.5" />
          Unpin from Toolbar
        </ContextMenuItem>
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
  const loadProjects = useProjectStore((state) => state.loadProjects);
  const getCurrentProject = useProjectStore((state) => state.getCurrentProject);
  const projectSwitcher = projectSwitcherPalette;

  const activeWorktreeId = useWorktreeSelectionStore((state) => state.activeWorktreeId);
  const activeWorktree = useWorktreeStore((state) =>
    activeWorktreeId ? state.worktrees.get(activeWorktreeId) : null
  );
  const branchName = activeWorktree?.branch;
  const watcherDegraded = useWorktreeStore((state) => state.watcherDegraded);

  useEffect(() => {
    loadProjects();
    getCurrentProject();

    const cleanup = projectClient.onSwitch(() => {
      getCurrentProject();
      loadProjects();
    });

    return cleanup;
  }, [loadProjects, getCurrentProject]);

  const showDeveloperTools = usePreferencesStore((state) => state.showDeveloperTools);
  const notificationsEnabled = useNotificationSettingsStore((s) => s.enabled);
  const toolbarLayout = useToolbarPreferencesStore((state) => state.layout);
  const toggleButtonVisibility = useToolbarPreferencesStore(
    (state) => state.toggleButtonVisibility
  );
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
      (state.status === "connecting" ||
        state.status === "recording" ||
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
  const githubStatsRef = useRef<GitHubStatsHandle>(null);
  // Set in onPointerDownOutside, read in onCloseAutoFocus on the overflow
  // dropdown. Suppresses focus restoration for pointer dismissals so the
  // ellipsis button doesn't keep its accent focus-visible ring; keyboard
  // close (Escape/Enter) still gets default focus return for WAI-ARIA.
  const overflowMenuPointerCloseRef = useRef(false);

  const { handleCopyTree } = useWorktreeActions();
  const sidebarShortcut = useKeybindingDisplay("nav.toggleSidebar");
  const copyTreeShortcut = useKeybindingDisplay("worktree.copyTree");
  const devServerShortcut = useKeybindingDisplay("devServer.start");
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

  const handleCopyTreeClick = useCallback(async () => {
    if (isCopyingTree || !activeWorktree) return;

    setIsCopyingTree(true);

    try {
      const resultMessage = await handleCopyTree(activeWorktree);

      if (resultMessage) {
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
      }
    } finally {
      setIsCopyingTree(false);
    }
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
                <ShortcutRevealChip actionId="nav.toggleSidebar" />
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
        BUILT_IN_AGENT_IDS.map((id) => [
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
                      aria-label="Open Dev Preview"
                    >
                      <MonitorPlay />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {createTooltipContent("Open Dev Preview", devServerShortcut)}
                  </TooltipContent>
                </Tooltip>
              </ContextMenuTrigger>
              <ContextMenuContent className="max-h-[var(--radix-context-menu-content-available-height)] overflow-y-auto">
                <ContextMenuItem onSelect={() => toggleButtonVisibility("dev-server", "left")}>
                  <Unplug className="mr-2 h-3.5 w-3.5" />
                  Unpin from Toolbar
                </ContextMenuItem>
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
      "github-stats": {
        render: () =>
          currentProject ? (
            <GitHubStatsToolbarButton
              key="github-stats"
              ref={githubStatsRef}
              currentProject={currentProject}
              data-toolbar-item=""
            />
          ) : (
            <GitHubStatsPlaceholder />
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
                      treeCopied
                        ? "text-status-success bg-status-success/10"
                        : "text-daintree-text",
                      isCopyingTree && "cursor-wait opacity-70",
                      "aria-disabled:opacity-50 aria-disabled:cursor-not-allowed"
                    )}
                    aria-label={
                      isCopyingTree ? "Copying…" : treeCopied ? "Context copied" : "Copy Context"
                    }
                    aria-keyshortcuts={copyTreeAriaShortcut}
                  >
                    {showCopyingSpinner ? <Spinner /> : treeCopied ? <Check /> : <Folders />}
                    {!treeCopied && !isCopyingTree && (
                      <ShortcutRevealChip actionId="worktree.copyTree" />
                    )}
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
                    createTooltipContent("Copy Context", copyTreeShortcut)
                  )}
                </TooltipContent>
              </Tooltip>
            </ContextMenuTrigger>
            <ContextMenuContent className="max-h-[var(--radix-context-menu-content-available-height)] overflow-y-auto">
              <ContextMenuItem onSelect={() => toggleButtonVisibility("copy-tree", "right")}>
                <Unplug className="mr-2 h-3.5 w-3.5" />
                Unpin from Toolbar
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        ),
        isAvailable: true,
      },
      "command-palette": {
        render: () => <ToolbarCommandPaletteButton key="command-palette" data-toolbar-item="" />,
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
            onToggleProblems={onToggleProblems}
            data-toolbar-item=""
          />
        ),
        // Auto-surface the Problems button when the watcher is degraded so
        // the persistent Tier-1 indicator is visible even for users who
        // haven't enabled developer tools (the default).
        isAvailable: showDeveloperTools || watcherDegraded,
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
      showDeveloperTools,
      notificationsEnabled,
      pluginButtonIds,
      pluginConfigs,
      devServerShortcut,
      devServerHintHover,
      toggleButtonVisibility,
    ]
  );

  const pinnedButtons = toolbarLayout.pinnedButtons;

  const effectiveLeftButtons = useMemo(
    () =>
      toolbarLayout.leftButtons.filter((id) =>
        isToolbarButtonVisible(id, pinnedButtons, effectiveAgentSettings, agentAvailability)
      ),
    [toolbarLayout.leftButtons, pinnedButtons, effectiveAgentSettings, agentAvailability]
  );

  const effectiveRightButtons = useMemo(() => {
    const existing = new Set(toolbarLayout.rightButtons);
    const extra = pluginButtonIds.filter((id) => !existing.has(id));
    return [...toolbarLayout.rightButtons, ...extra].filter((id) =>
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
    if (overflowSet.has("github-stats")) {
      githubStatsRef.current?.closeAll();
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
      ...Object.fromEntries(BUILT_IN_AGENT_IDS.map((id) => [id, () => onLaunchAgent(id)])),
      terminal: () => onLaunchAgent("terminal"),
      browser: () => onLaunchAgent("browser"),
      "dev-server": () => {
        void actionService.dispatch("devServer.start", undefined, { source: "user" });
      },
      "notification-center": () => {
        useUIStore.getState().toggleNotificationCenter();
      },
      "copy-tree": () => {
        void handleCopyTreeClick();
      },
      "command-palette": () => {
        void actionService.dispatch("action.palette.open", undefined, { source: "user" });
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
      handleCopyTreeClick,
      onSettings,
      onToggleProblems,
      pluginButtonIds,
      pluginConfigs,
    ]
  );

  const renderOverflowMenu = (
    overflowIds: AnyToolbarButtonId[],
    side: "left" | "right",
    severity: OverflowBadgeSeverity
  ) => {
    if (overflowIds.length === 0) return null;
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
    return (
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                data-toolbar-item=""
                data-toolbar-overflow-trigger=""
                data-toolbar-overflow-side={side}
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
            if (id === "github-stats") {
              const ghStats = githubStatsRef.current?.stats;
              const items = [
                <DropdownMenuItem
                  key="gh-issues"
                  onClick={() => githubStatsRef.current?.openIssues()}
                >
                  <CircleDot className="mr-2 h-4 w-4 text-pr-open" />
                  Issues {ghStats?.issueCount != null ? `(${ghStats.issueCount})` : ""}
                </DropdownMenuItem>,
                <DropdownMenuItem key="gh-prs" onClick={() => githubStatsRef.current?.openPrs()}>
                  <GitPullRequest className="mr-2 h-4 w-4 text-pr-merged" />
                  Pull Requests {ghStats?.prCount != null ? `(${ghStats.prCount})` : ""}
                </DropdownMenuItem>,
                <DropdownMenuItem
                  key="gh-commits"
                  onClick={() => githubStatsRef.current?.openCommits()}
                >
                  <GitCommit className="mr-2 h-4 w-4" />
                  Commits {ghStats?.commitCount != null ? `(${ghStats.commitCount})` : ""}
                </DropdownMenuItem>,
              ];
              if (idx < overflowIds.length - 1) {
                items.push(<DropdownMenuSeparator key="gh-sep" />);
              }
              return items;
            }
            const meta = OVERFLOW_MENU_META[id] ?? pluginOverflowMeta[id];
            if (!meta) return [];
            const Icon = meta.icon;
            return [
              <DropdownMenuItem key={id} onClick={() => overflowActions[id]?.()}>
                <Icon className="mr-2 h-4 w-4" />
                {meta.label}
              </DropdownMenuItem>,
            ];
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  };

  const isDropdownOpen = projectSwitcher.isOpen && projectSwitcher.mode === "dropdown";
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
                "shrink-0 transition-[width] duration-200 data-[fullscreen=true]:duration-[120ms]",
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
            open={currentProject ? pillTooltipOpen : false}
            onOpenChange={currentProject ? handlePillTooltipOpenChange : undefined}
          >
            <ContextMenu>
              <ProjectSwitcherPalette
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
                onAddProject={projectSwitcher.addProject}
                onCloneRepo={projectSwitcher.cloneRepo}
                onStopProject={handleStopProject}
                onCloseProject={handleCloseProject}
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
                scratchResults={projectSwitcher.scratchResults}
                onCreateScratch={() => void projectSwitcher.createScratch()}
                onSelectScratch={(scratch) => void projectSwitcher.selectScratch(scratch)}
                onRemoveScratch={(scratchId) => void projectSwitcher.removeScratchAction(scratchId)}
                onSaveAsProject={(scratchId) => void projectSwitcher.saveAsProject(scratchId)}
                saveAsProjectConfirm={projectSwitcher.saveAsProjectConfirm}
                onDismissSaveAsProjectConfirm={projectSwitcher.dismissSaveAsProjectConfirm}
                onConfirmDeleteOriginalScratch={() =>
                  void projectSwitcher.confirmDeleteOriginalScratch()
                }
                isDeletingOriginalScratch={projectSwitcher.isDeletingOriginalScratch}
              >
                <ContextMenuTrigger asChild>
                  <TooltipTrigger asChild>
                    <button
                      data-toolbar-item=""
                      className="toolbar-project-pill app-no-drag pointer-events-auto flex h-9 min-w-0 max-w-full items-center justify-center gap-2 overflow-hidden border px-3 outline-hidden"
                      data-testid="project-switcher-trigger"
                      aria-label={
                        currentProject
                          ? `Open project switcher for ${currentProject.name}`
                          : "Open project"
                      }
                      role={currentProject ? "combobox" : undefined}
                      aria-haspopup={currentProject ? "listbox" : undefined}
                      aria-expanded={currentProject ? isDropdownOpen : undefined}
                      onClick={() => projectSwitcher.open("dropdown")}
                      onPointerEnter={clearPillTooltipFocusSuppression}
                    >
                      <span
                        className={cn(
                          "text-base leading-none shrink-0",
                          !currentProject && "opacity-0"
                        )}
                        aria-label={currentProject ? "Project emoji" : undefined}
                        aria-hidden={currentProject ? undefined : true}
                      >
                        {currentProject?.emoji ?? "•"}
                      </span>
                      <span
                        className={cn(
                          "min-w-0 truncate text-xs tracking-wide text-daintree-text",
                          currentProject ? "font-semibold" : "font-medium"
                        )}
                      >
                        {currentProject?.name ?? "Open project"}
                      </span>
                      <span
                        className={cn(
                          "toolbar-project-chip shrink-0 inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 font-mono tabular-nums",
                          !branchName && "opacity-0"
                        )}
                        aria-label={branchName ? `Current branch ${branchName}` : undefined}
                        aria-hidden={branchName ? undefined : true}
                      >
                        <GitBranch className="toolbar-project-chip-icon h-3 w-3 shrink-0" />
                        <span className="toolbar-project-chip-label">
                          {truncatedBranchName ?? "main"}
                        </span>
                      </span>
                      <ChevronsUpDown className="toolbar-project-meta ml-0.5 h-3 w-3 shrink-0" />
                    </button>
                  </TooltipTrigger>
                </ContextMenuTrigger>
              </ProjectSwitcherPalette>
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
                "shrink-0 transition-[width] duration-200 data-[fullscreen=true]:duration-[120ms]",
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
