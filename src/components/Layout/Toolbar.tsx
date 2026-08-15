import {
  Suspense,
  lazy,
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
import { FolderTree, Folders } from "@/components/icons";
import { buildPluginToolbarMeta } from "./pluginToolbarMeta";
import {
  TOOLBAR_BUTTON_METADATA,
  getToolbarButtonGroup,
  isToolbarButtonVisible,
} from "./toolbarButtonMetadata";
import { getToolbarDividerAfterIds, orderToolbarButtonsByGroup } from "./toolbarButtonGrouping";
import { ToolbarContextMenuItems } from "./ToolbarContextMenuItems";
import { cn } from "@/lib/utils";
import { isMac, isLinux, isWindows } from "@/lib/platform";
import { WINDOWS_CAPTION_WIDTH_PX } from "@shared/config/windowChrome";
import { createTooltipContent } from "@/lib/tooltipShortcut";
import { AgentButton } from "./AgentButton";
import {
  PluginToolbarButton,
  PluginTrayButton,
  groupPluginToolbarButtons,
  type PluginTrayGroup,
} from "./PluginTrayButton";
import { LAUNCHER_PANEL_ITEMS } from "./launcherPanelItems";
import { deriveAgentDominantStates } from "@/lib/agentDominantStates";
import { DockLaunchButton } from "./DockLaunchButton";
import { useLauncherData } from "./useLauncherData";
import { usePluginRuntimeStore } from "@/store/pluginRuntimeStore";
import { resolvePluginIcon } from "@/components/icons/pluginIconRegistry";
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
import { activeWorkspaceIdentity, branchChipState } from "@/lib/workspaceIdentity";
import { usePreferencesStore, useToolbarPreferencesStore, useVoiceRecordingStore } from "@/store";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { useNotificationSettingsStore } from "@/store/notificationSettingsStore";
import type { AnyToolbarButtonId } from "@/../../shared/types/toolbar";
import { usePluginToolbarButtons } from "@/hooks/usePluginToolbarButtons";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import { usePanelStore } from "@/store/panelStore";
import { useShallow } from "zustand/react/shallow";
import { useNotificationHistoryStore } from "@/store/slices/notificationHistorySlice";
import { agentStateDotColor } from "@/components/Worktree/AgentStatusIndicator";
import { notify } from "@/lib/notify";
import type { CliAvailability, AgentSettings, AgentState } from "@shared/types";
import { isGitBackedProject } from "@shared/types";
import type { ForgeRepositoryStats } from "@shared/types/ipc/forge";
import { isAgentPinned, isAgentToolbarVisible } from "../../../shared/utils/agentPinned";
import { isAgentLaunchable } from "../../../shared/utils/agentAvailability";
import { projectClient } from "@/clients";
import { actionService } from "@/services/ActionService";
import { isPanelLimitError } from "@/services/actions/definitions/panelLimitError";
import { LazyProjectSwitcherPalette } from "@/lazyPanels";
import { ProjectIdentityEditor } from "@/components/Project/ProjectIdentityEditor";
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
import { FixedDropdown } from "@/components/ui/fixed-dropdown";
import {
  isInsideCopyTreePanel,
  restoreCopyTreeTriggerFocus,
} from "@/components/CopyTree/copyTreeFocus";
import { useCopyTreeCompletionNotice } from "@/hooks/useCopyTreeCompletionNotice";
import { useCopyTreeRunStore } from "@/store/copyTreeRunStore";
import type { CopyTreeHistoryRecord } from "@shared/types";

import {
  LAUNCHABLE_AGENT_IDS,
  isBuiltInAgentId,
  type BuiltInAgentId,
} from "@shared/config/agentIds";

function preloadCopyTreeRecentsPanel() {
  return import("@/components/CopyTree/CopyTreeRecentsPanel");
}
const LazyCopyTreeRecentsPanel = lazy(() =>
  preloadCopyTreeRecentsPanel().then((m) => ({ default: m.CopyTreeRecentsPanel }))
);

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
  // Plugin contributions grouped by owning plugin. When `plugin-tray` itself
  // overflows, its dropdown is unreachable, so the overflow menu inlines these
  // groups instead — an un-promoted contribution has no other toolbar route.
  pluginTrayGroups: PluginTrayGroup[];
  // Launchable agent ids, in the launcher's own order. When `launcher` itself
  // overflows its dropdown is unreachable, so the overflow menu inlines these
  // alongside the panels — since #11680 an unpinned agent has no other toolbar
  // route.
  launcherAgentIds: BuiltInAgentId[];
  // Per-item availability for the inlined launcher panel rows, mirroring the
  // gates the launcher applies to its own rows.
  panelTrayDisabled: Partial<Record<string, boolean>>;
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
  pluginTrayGroups,
  launcherAgentIds,
  panelTrayDisabled,
  shortcutById,
}: OverflowMenuProps) {
  const [open, setOpen] = useState(false);
  // Read here rather than threaded through props: the overflow copy-tree item
  // mirrors the visible button's disabled states, and in-flight copies can
  // start from routes that never touch this menu (MCP, Cmd+Shift+C).
  const isCopyingTree = useCopyTreeRunStore((s) => s.activeRunCount > 0);
  // Snapshot of the repo stats taken when the menu opens. The stats live in
  // ForgeStatsToolbarButton's hook and are exposed through its imperative
  // handle, so they can't be read during render (refs aren't reactive — the
  // menu wouldn't re-render on updates anyway). Reading in the open handler
  // captures them at the only moment they're about to become visible.
  const [repoStats, setRepoStats] = useState<ForgeRepositoryStats | null>(null);
  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      setRepoStats(forgeStatsRef.current?.stats ?? null);
      // Same reason PluginTrayButton refreshes on open: a dev-attached plugin
      // registers its buttons without broadcasting provenance, so its display
      // name can be missing and the inlined groups would fall back to raw
      // plugin ids.
      if (pluginTrayGroups.length > 0) usePluginRuntimeStore.getState().refresh();
    }
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
          if (id === "plugin-tray") {
            // The tray's own dropdown can't be opened from here, and an
            // un-promoted contribution has no other toolbar route — so inline
            // the grouped contributions rather than leaving a row that
            // dismisses the menu and opens nothing.
            if (pluginTrayGroups.length === 0) return [];
            const isLast = idx === overflowIds.length - 1;
            return [
              ...pluginTrayGroups.map((group) => (
                <DropdownMenuGroup key={`plugin-tray-${group.pluginId}`}>
                  <DropdownMenuLabel>{group.displayName}</DropdownMenuLabel>
                  {group.buttons.map((config) => {
                    const Icon = resolvePluginIcon(config.iconId);
                    return (
                      <DropdownMenuItem
                        key={config.id}
                        onClick={() => overflowActions[config.id]?.()}
                      >
                        <Icon className="mr-2 h-3.5 w-3.5" />
                        <span className="flex-1">{config.label}</span>
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuGroup>
              )),
              ...(isLast ? [] : [<DropdownMenuSeparator key="plugin-tray-sep" />]),
            ];
          }
          if (id === "launcher") {
            // Same reason as `plugin-tray` above: the launcher's dropdown can't
            // be opened from inside this menu, and since #11680 neither the
            // agents nor `browser`/`dev-server` have a top-level button of their
            // own on a fresh profile — so a bare row here would dismiss the menu
            // and open nothing. That is what `agent-tray` did before the merge:
            // it had no case at all and no `overflowActions` entry, leaving a
            // silently dead row. Pins and shortcut editing are omitted:
            // promoting a button while the toolbar is too narrow to show it has
            // nothing to reveal.
            //
            // Items that already carry their own overflow row are skipped: a
            // grandfathered profile keeps its agent and `browser`/`dev-server`
            // buttons, and when those overflow alongside the launcher the
            // generic rows below already offer them. Inlining anyway would put
            // two identically labelled rows in one menu.
            const inlinedAgents = launcherAgentIds.filter(
              (agentId) => !overflowIds.includes(agentId) && OVERFLOW_MENU_META[agentId]
            );
            const inlinedPanels = LAUNCHER_PANEL_ITEMS.filter(
              (item) => !overflowIds.includes(item.id)
            );
            if (inlinedAgents.length === 0 && inlinedPanels.length === 0) return [];
            const isLast = idx === overflowIds.length - 1;
            return [
              ...inlinedAgents.map((agentId) => {
                const agentMeta = OVERFLOW_MENU_META[agentId]!;
                const dominantState = agentDominantStates.get(agentId) ?? null;
                const dotColor = dominantState ? agentStateDotColor(dominantState) : null;
                return (
                  <AgentOverflowItem
                    key={`launcher-${agentId}`}
                    id={agentId}
                    label={agentMeta.label}
                    Icon={agentMeta.icon}
                    dotColor={dotColor}
                    onSelect={() => overflowActions[agentId]?.()}
                  />
                );
              }),
              ...inlinedPanels.map((item) => {
                const Icon = item.icon;
                return (
                  <DropdownMenuItem
                    key={`launcher-${item.id}`}
                    disabled={panelTrayDisabled[item.id]}
                    onClick={() => overflowActions[item.id]?.()}
                  >
                    <Icon className="mr-2 h-3.5 w-3.5" />
                    <span className="flex-1">{item.label}</span>
                    {shortcutById[item.id] && (
                      <DropdownMenuShortcut>{shortcutById[item.id]}</DropdownMenuShortcut>
                    )}
                  </DropdownMenuItem>
                );
              }),
              ...(isLast ? [] : [<DropdownMenuSeparator key="launcher-sep" />]),
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
          // Mirror the visible copy-tree button, which is aria-disabled both
          // when no worktree is active ("Open a worktree first" tooltip) and
          // while a copy is in flight — without this the overflow item would
          // look live yet silently close with no feedback, since its handler
          // guards on the same two conditions.
          const disabled = id === "copy-tree" && (!hasActiveWorktree || isCopyingTree);
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
  /**
   * Whether this view owns a workspace of any kind. The sidebar toggle degrades
   * to disabled without one — there is no slot for it to reveal (#11499).
   */
  hasWorkspace: boolean;
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
  hasWorkspace,
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
  // the agent-state dot on overflow menu items. Shares the launcher's
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
  const positionAgentButton = useToolbarPreferencesStore((state) => state.positionAgentButton);
  // Live subscription so pin/unpin toggles from the launcher immediately
  // update per-agent toolbar button visibility. The `agentSettings` prop is
  // sourced from `useAgentLauncher()`'s local useState which does not react to
  // store mutations, so we prefer the store value when available.
  const liveAgentSettings = useAgentSettingsStore((s) => s.settings);
  const effectiveAgentSettings = liveAgentSettings ?? agentSettings;

  const [isFullscreen, setIsFullscreen] = useState(false);
  // Store-derived rather than local click state so every clipboard copy spins
  // the button — an MCP or assistant dispatch runs the same bracketed actions
  // a click does, and this button is the one place that work is visible.
  const isCopyingTree = useCopyTreeRunStore((s) => s.activeRunCount > 0);
  const showCopyingSpinner = useDohertyGate(isCopyingTree);
  // The tooltip's ordinary hover state — the Radix root is controlled with the
  // union of this and the completion notice below, so a completion can force
  // it open while hover keeps working through onOpenChange.
  const [copyTreeTooltipHovered, setCopyTreeTooltipHovered] = useState(false);
  // Local to the toolbar — the panel has no palette entry or action of its own,
  // so nothing outside this component needs to open it (#11733).
  const [copyTreeOpen, setCopyTreeOpen] = useState(false);
  const copyTreeButtonRef = useRef<HTMLButtonElement>(null);
  // Completion feedback for clipboard copies: the action layer announces every
  // finished copy (announceCopyTreeCopy) and this hook's presenter pins it to
  // the button as a short-lived tooltip, with a toast fallback whenever the
  // button can't anchor one. Suppressed while the recents panel is open — both
  // portal to the same anchor, and an MCP completion landing mid-browse would
  // stack the tooltip on the panel.
  const {
    notice: copyTreeNotice,
    announcement: copyTreeAnnouncement,
    clearNotice: clearCopyTreeNotice,
  } = useCopyTreeCompletionNotice(copyTreeButtonRef, { suppress: copyTreeOpen });
  // Latch after first open so reopening never re-suspends.
  const copyTreePanelMounted = useKeepMounted(copyTreeOpen);

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

  const { handleCopyTree, handleCopyTreeWithOptions } = useWorktreeActions();
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
  const fileBrowserShortcut = useKeybindingDisplay("worktree.openFileBrowserPanel");
  const sidebarAriaShortcut = useAriaKeyshortcuts("nav.toggleSidebar");
  const copyTreeAriaShortcut = useAriaKeyshortcuts("worktree.copyTree");
  const fileBrowserAriaShortcut = useAriaKeyshortcuts("worktree.openFileBrowserPanel");

  const sidebarHintHover = useShortcutHintHover("nav.toggleSidebar");
  const devServerHintHover = useShortcutHintHover("devServer.start");
  // No hover hint for copy-tree: the action sets `suppressShortcutHint`, and
  // per that field's contract an opted-out button skips this hook too — the
  // hover path teaches the same hint the dispatch path was opted out of, and an
  // already-shown one isn't dismissed by the click, so it would sit beside the
  // completion toast in the same corner. The tooltip still shows the shortcut.
  const fileBrowserHintHover = useShortcutHintHover("worktree.openFileBrowserPanel");

  // The one launcher button whose action can legitimately refuse: it resolves
  // its own target (focused worktree, else the project or scratch root), and a
  // workspace with nothing to browse makes it throw. `dispatch` turns that into
  // `ok: false` rather than a rejection, so without this the press would do
  // nothing at all. Mirrors `LauncherQuickActions`, which offers the same action.
  // A named function expression so the retry action can name itself.
  const openFileBrowser = useCallback(function openFileBrowser() {
    void actionService
      .dispatch("worktree.openFileBrowserPanel", undefined, { source: "user" })
      .then((result) => {
        if (result.ok) return;
        // A full grid is the one refusal `addPanel` has already reported, with
        // an accurate message and the actual recovery. Saying "no folder
        // resolved" on top of it would name the wrong cause (#11666).
        if (isPanelLimitError(result.error.message)) return;
        notify({
          type: "error",
          title: "Couldn't open the file browser",
          message: "No folder resolved for this workspace. Select a worktree and try again.",
          // `uiFeedback` is a passive kind that resolves to `priority: "low"`
          // (inbox only), which would leave this refusal — and its Retry — with
          // no visible signal at all.
          priority: "high",
          context: { eventKind: "uiFeedback" },
          action: { label: "Retry", onClick: openFileBrowser },
        });
      });
  }, []);

  // The shared launcher's own inventory and workspace context (#11691). The
  // toolbar had none of this before — its launcher owned every store read
  // itself — so it comes from the same hook the dock uses.
  const launcherData = useLauncherData();

  // Agents launched from the toolbar keep going through `agent.launch` with no
  // location override, so they land where they always have. The dock's copy of
  // the launcher passes its own callback and keeps landing in the dock — the
  // shared component decides how a row looks, never where it opens.
  const launchAgentFromToolbar = useCallback((agentId: string, presetId?: string | null) => {
    void actionService.dispatch(
      "agent.launch",
      // `null` is the explicit-default sentinel and must survive into the
      // payload; `undefined` must leave the key off so the saved preset still
      // resolves. A `!= null` test here would collapse the two.
      { agentId, ...(presetId !== undefined ? { presetId } : {}) },
      { source: "user" }
    );
  }, []);

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
      projectSwitcher.locateProject(projectId);
    },
    [projectSwitcher]
  );

  const handleMoveOrRenameProject = useCallback(
    (projectId: string) => {
      projectSwitcher.moveOrRenameProject(projectId);
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

  // Feedback is owned by the action layer, not inline state here: the
  // `worktree.copyTree` action brackets the shared run store (which drives the
  // spinner above) and announces its completion through the button's transient
  // tooltip, so every route — this handler, the overflow item, Cmd+Shift+C,
  // the palette, MCP — reports identically (#11735). This handler only guards
  // and dispatches.
  const handleCopyTreeClick = useCallback(() => {
    if (isCopyingTree || !activeWorktree) return;
    return handleCopyTree(activeWorktree, "toolbar");
  }, [isCopyingTree, activeWorktree, handleCopyTree]);

  // Warm the panel chunk before the first click — React 19 `lazy` still shows
  // the fallback for one frame on a cold chunk, and this dropdown's whole point
  // is that the copy is one click deeper than it used to be.
  useEffect(() => {
    void preloadCopyTreeRecentsPanel();
  }, []);

  // Close and hand focus back to the trigger, but only when closing would
  // otherwise strand it — an outside click has already moved focus somewhere the
  // user chose, and yanking it back to the toolbar would fight that. The
  // deferred-frame reasoning lives with the helper.
  const closeCopyTreePanel = useCallback(() => {
    setCopyTreeOpen(false);
    restoreCopyTreeTriggerFocus(copyTreeButtonRef.current);
  }, []);

  // The visible button opens the panel; it no longer copies. Every immediate
  // route is deliberately left alone: `Cmd+Shift+C` dispatches
  // `worktree.copyTree` without passing through here at all, and the overflow
  // item calls `handleCopyTreeClick` directly — a nested panel inside the
  // overflow menu isn't worth it (#11733).
  //
  // The in-flight check matches what the button already announces: it renders
  // `aria-disabled` while copying, and the shared Button doesn't suppress
  // clicks on that alone, so without this the "disabled" trigger still opens a
  // panel whose rows would all decline to run.
  const handleCopyTreeToggle = useCallback(() => {
    if (isCopyingTree || !activeWorktree) return;
    // A lingering completion tooltip and the opening panel would anchor to the
    // same button; the click is also an acknowledgement of the notice.
    clearCopyTreeNotice();
    setCopyTreeOpen((open) => !open);
  }, [isCopyingTree, activeWorktree, clearCopyTreeNotice]);

  // The panel's primary row: the old one-click behavior, now one click deeper.
  const handleCopyTreeFullContext = useCallback(() => {
    closeCopyTreePanel();
    void handleCopyTreeClick();
  }, [closeCopyTreePanel, handleCopyTreeClick]);

  // A recents row. Replayed against the ACTIVE worktree, never the worktree
  // stored on the record — the history dedupe key covers options alone, so a
  // record's worktree is whichever one ran it last rather than a stable target,
  // and it may name a worktree that has since been removed.
  const handleCopyTreeRunRecent = useCallback(
    (record: CopyTreeHistoryRecord) => {
      closeCopyTreePanel();
      if (isCopyingTree || !activeWorktree) return;
      void handleCopyTreeWithOptions(activeWorktree, record.options, "toolbar");
    },
    [closeCopyTreePanel, isCopyingTree, activeWorktree, handleCopyTreeWithOptions]
  );

  // The anchor stops being interactive without a worktree or while a copy is
  // in flight (it renders aria-disabled for both), and the panel's rows decline
  // in both states — leaving it open would strand a dead menu over the toolbar.
  // The in-flight half matters because copies start without the trigger: MCP
  // and assistant dispatches, Cmd+Shift+C, and the palette can all begin one
  // while the panel is open. `closeCopyTreePanel` rather than a bare state
  // flip so focus stranded inside the closing panel returns to the trigger.
  useEffect(() => {
    if ((!activeWorktree || isCopyingTree) && copyTreeOpen) closeCopyTreePanel();
  }, [activeWorktree, isCopyingTree, copyTreeOpen, closeCopyTreePanel]);

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
  const pluginMetaById = usePluginRuntimeStore((s) => s.pluginMetaById);

  const buttonRegistry = useMemo<
    Record<string, { render: () => React.ReactNode; isAvailable: boolean }>
  >(
    () => ({
      // Degraded rather than removed when there is no workspace: the welcome
      // screen has no sidebar slot to reveal, so an enabled toggle would flip
      // its own icon and aria-pressed over nothing (#11499). `aria-disabled`
      // rather than `disabled` so the tooltip carrying the reason still opens
      // — a browser drops pointer events on a disabled button. Label is
      // unchanged; only the tooltip explains.
      "sidebar-toggle": {
        render: () => (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                {...(hasWorkspace ? sidebarHintHover : {})}
                variant="ghost"
                size="icon"
                data-toolbar-item=""
                data-sidebar-toggle=""
                onClick={hasWorkspace ? onToggleFocusMode : undefined}
                aria-disabled={!hasWorkspace || undefined}
                className={cn(
                  toolbarIconButtonClass,
                  "aria-disabled:opacity-50 aria-disabled:cursor-not-allowed"
                )}
                aria-label="Toggle Sidebar"
                aria-pressed={!isFocusMode}
                aria-keyshortcuts={sidebarAriaShortcut}
              >
                {isFocusMode ? <PanelLeftOpen /> : <PanelLeftClose />}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {hasWorkspace
                ? createTooltipContent(
                    isFocusMode ? "Show Sidebar" : "Hide Sidebar",
                    sidebarShortcut
                  )
                : "Open a project or scratch to use the sidebar"}
            </TooltipContent>
          </Tooltip>
        ),
        isAvailable: true,
      },
      launcher: {
        // Always available, unlike the plugin tray: its inventory is fixed, so
        // there is no empty state. Individual rows gate themselves instead.
        render: () => (
          <DockLaunchButton
            key="launcher"
            placement="toolbar"
            agents={launcherData.agents}
            pinnedCount={launcherData.pinnedCount}
            agentInventoryState={launcherData.agentInventoryState}
            hasWorkspace={launcherData.hasWorkspace}
            hasProject={launcherData.hasProject}
            activeWorktreeId={launcherData.activeWorktreeId}
            cwd={launcherData.cwd}
            recipeContext={launcherData.recipeContext}
            onLaunchAgent={launchAgentFromToolbar}
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
      "file-browser": {
        // Deliberately not in PROJECT_SCOPED_TOOLBAR_IDS: the action browses the
        // project or scratch root when no worktree is selected (#11482), so
        // gating it on `currentProject` would disable it in exactly the
        // worktree-less workspaces where it still works. `hasWorkspace` is the
        // gate that does apply — with no workspace of any kind the action
        // resolves no folder at all and can only answer with an error toast, so
        // it degrades the same way the sidebar toggle above does (#11499).
        render: () => (
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    {...(hasWorkspace ? fileBrowserHintHover : {})}
                    variant="ghost"
                    size="icon"
                    data-toolbar-item=""
                    onClick={hasWorkspace ? openFileBrowser : undefined}
                    aria-disabled={!hasWorkspace || undefined}
                    className={cn(
                      toolbarIconButtonClass,
                      "aria-disabled:opacity-50 aria-disabled:cursor-not-allowed"
                    )}
                    aria-label="Browse files"
                    aria-keyshortcuts={fileBrowserAriaShortcut}
                  >
                    <FolderTree />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {hasWorkspace
                    ? createTooltipContent("Browse files", fileBrowserShortcut)
                    : "Open a project or scratch to browse files"}
                </TooltipContent>
              </Tooltip>
            </ContextMenuTrigger>
            <ContextMenuContent className="max-h-[var(--radix-context-menu-content-available-height)] overflow-y-auto">
              <ToolbarContextMenuItems buttonId="file-browser" side="left" />
            </ContextMenuContent>
          </ContextMenu>
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
        // A workspace with no repository has no commits, issues or PRs to
        // report, so it takes the placeholder too — which also keeps the
        // button's stats polling from ever starting for it (#11405).
        render: () =>
          currentProject && isGitBackedProject(currentProject) ? (
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
          <div className="relative">
            <ContextMenu>
              <ContextMenuTrigger asChild>
                {/* Controlled union: hover opens through onOpenChange as
                    normal, while a completion notice forces the tooltip open
                    for its short display window — the whole feedback for a
                    finished copy, in place of a toast. Close requests clear
                    the notice too, so Escape, a click, and the shared
                    dialog-transition dismissal can end the window early
                    instead of being overridden by the forced half of the
                    union. The shared auto-dismiss is off while a notice is up:
                    its timer arms on the open transition, so a completion that
                    lands mid-hover would inherit whatever's left of the hover
                    window instead of getting the notice's own. Hover-only opens
                    keep the shared window. */}
                <Tooltip
                  autoDismiss={copyTreeNotice === null}
                  open={copyTreeTooltipHovered || copyTreeNotice !== null}
                  onOpenChange={(open) => {
                    setCopyTreeTooltipHovered(open);
                    if (!open) clearCopyTreeNotice();
                  }}
                >
                  <TooltipTrigger asChild>
                    <Button
                      ref={copyTreeButtonRef}
                      variant="ghost"
                      size="icon"
                      data-toolbar-item=""
                      onClick={handleCopyTreeToggle}
                      aria-disabled={isCopyingTree || !activeWorktree || undefined}
                      className={cn(
                        "toolbar-icon-button relative",
                        "text-daintree-text",
                        isCopyingTree && "cursor-wait opacity-70",
                        "aria-disabled:opacity-50 aria-disabled:cursor-not-allowed"
                      )}
                      aria-label={isCopyingTree ? "Copying…" : "Copy context"}
                      aria-keyshortcuts={copyTreeAriaShortcut}
                      aria-haspopup="dialog"
                      aria-expanded={copyTreeOpen}
                    >
                      {showCopyingSpinner ? <Spinner /> : <Folders />}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="font-medium">
                    {copyTreeNotice ? (
                      <span className="flex flex-col gap-0.5">
                        <span>{copyTreeNotice.title}</span>
                        <span className="font-normal text-daintree-text/60">
                          {copyTreeNotice.message}
                        </span>
                      </span>
                    ) : isCopyingTree ? (
                      "Copying…"
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
            <FixedDropdown
              open={copyTreeOpen}
              onOpenChange={(open) => {
                if (!open) closeCopyTreePanel();
              }}
              anchorRef={copyTreeButtonRef}
              className="p-0"
            >
              {copyTreePanelMounted && (
                <Suspense fallback={null}>
                  <LazyCopyTreeRecentsPanel
                    onCopyFullContext={handleCopyTreeFullContext}
                    onRunRecent={handleCopyTreeRunRecent}
                  />
                </Suspense>
              )}
            </FixedDropdown>
            {/* The toast this tooltip replaced was announced by assistive
                tech; a forced-open tooltip isn't, so the notice is mirrored
                into a live region. The hook toggles a zero-width space onto
                identical back-to-back completions so the second overwrite
                still announces. */}
            <span role="status" className="sr-only">
              {copyTreeAnnouncement}
            </span>
          </div>
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
      "plugin-tray": {
        render: () => (
          <PluginTrayButton key="plugin-tray" configs={pluginConfigs} data-toolbar-item="" />
        ),
        // An empty tray is not a slot worth reserving — with no plugin
        // contributions the button doesn't render at all (#11304).
        isAvailable: pluginConfigs.size > 0,
      },
      // Individual contributions still need a top-level renderer, but only
      // reach the toolbar once explicitly promoted — `isToolbarButtonVisible`
      // gates that below, not `isAvailable`.
      ...Object.fromEntries(
        pluginButtonIds.map((pluginId) => {
          const config = pluginConfigs.get(pluginId);
          return [
            pluginId,
            {
              render: () => (
                <PluginToolbarButton
                  key={pluginId}
                  pluginId={pluginId}
                  config={config!}
                  data-toolbar-item=""
                />
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
      hasWorkspace,
      agentAvailability,
      effectiveAgentSettings,
      onLaunchAgent,
      launcherData,
      launchAgentFromToolbar,
      sidebarShortcut,
      sidebarAriaShortcut,
      sidebarHintHover,
      copyTreeShortcut,
      copyTreeAriaShortcut,
      currentProject,
      handleCopyTreeToggle,
      handleCopyTreeFullContext,
      handleCopyTreeRunRecent,
      closeCopyTreePanel,
      copyTreeOpen,
      copyTreePanelMounted,
      copyTreeNotice,
      copyTreeAnnouncement,
      copyTreeTooltipHovered,
      clearCopyTreeNotice,
      isCopyingTree,
      showCopyingSpinner,
      activeWorktree,
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
      openFileBrowser,
      fileBrowserShortcut,
      fileBrowserAriaShortcut,
      fileBrowserHintHover,
    ]
  );

  const pinnedButtons = toolbarLayout.pinnedButtons;

  // An agent the user explicitly pinned but that sits in neither side array
  // still has to render (#11680). Two ways to get here, and neither can be
  // repaired in the store's `merge()` — the pin lives in `agentSettingsStore`,
  // which loads asynchronously over IPC and isn't readable at toolbar-store
  // hydration:
  //   - a genuinely fresh profile, where `buildInitialAgentPinUpdates` stamps
  //     `pinned: true` for the first few installed agents before the user has
  //     ever touched the toolbar;
  //   - a stale sibling project view overwriting the orderings, which reconcile
  //     last-writer-wins and so drop a position another view just wrote (the
  //     same window `restorePromotedPanelButtons` covers for panels).
  // `isAgentPinned`, not `isAgentToolbarVisible`: only an explicit `true` earns
  // a slot here. Reading the tri-state's installed-means-visible fall-through
  // would put every installed CLI back on the toolbar, which is the crowding
  // this issue removed.
  const unpositionedAgentPins = useMemo(() => {
    const onEitherSide = new Set([...toolbarLayout.leftButtons, ...toolbarLayout.rightButtons]);
    return LAUNCHABLE_AGENT_IDS.filter(
      (id) => !onEitherSide.has(id) && isAgentPinned(effectiveAgentSettings?.agents?.[id])
    );
  }, [toolbarLayout.leftButtons, toolbarLayout.rightButtons, effectiveAgentSettings]);

  // Materialize those positions once they're knowable, so the repair is a
  // one-frame bridge rather than a permanent ghost. A rendered-but-unpositioned
  // button is absent from Settings → Toolbar's sortable columns and inert to
  // `moveButton`, which reads the arrays — the first-run seeding above would
  // otherwise leave up to five agents that can never be reordered. The action
  // no-ops when the id already holds a position, writes nothing to
  // `pinnedButtons`, and converges under a concurrent sibling view. One batched
  // call, not a call per id: every insert lands at the same index, so repairing
  // the first-run seeding one agent at a time would persist them reversed
  // against the order they just rendered in.
  useEffect(() => {
    if (unpositionedAgentPins.length > 0) positionAgentButton(unpositionedAgentPins);
  }, [unpositionedAgentPins, positionAgentButton]);

  // Whichever side the launcher is on — that is where the things pinned out of
  // it belong. Splicing unconditionally into the left would strand them away
  // from a launcher the user moved right.
  const launcherOnRight =
    toolbarLayout.rightButtons.includes("launcher") &&
    !toolbarLayout.leftButtons.includes("launcher");

  // Declared group per button, resolved against the live plugin registry so a
  // contribution is classified by membership rather than by parsing its id.
  const resolveToolbarGroup = useCallback(
    (id: AnyToolbarButtonId) => getToolbarButtonGroup(id, pluginConfigs.has(id)),
    [pluginConfigs]
  );

  const effectiveLeftButtons = useMemo(() => {
    // Dedupe defensively so a persisted list holding a repeated id never
    // renders duplicate pills (#10937) — the store also heals this, this is
    // belt-and-suspenders at the render boundary.
    const positioned = Array.from(new Set(toolbarLayout.leftButtons));

    if (!launcherOnRight && unpositionedAgentPins.length > 0) {
      // Right after the launcher they were pinned out of, so they lead the
      // agent run in registry order rather than trailing the positioned ones.
      // Grouping below is what keeps the brand marks contiguous; this only
      // decides their order within that group.
      const launcherIndex = positioned.indexOf("launcher");
      positioned.splice(
        launcherIndex === -1 ? positioned.length : launcherIndex + 1,
        0,
        ...unpositionedAgentPins
      );
    }

    // Grouped, not persisted order (#11681): the divider marks a group
    // boundary, so the groups have to actually be contiguous. Ordering here
    // rather than at the render loop means overflow, keyboard roving, and the
    // DOM all see the same canonical sequence.
    return orderToolbarButtonsByGroup(
      positioned.filter((id) =>
        isToolbarButtonVisible(
          id,
          pinnedButtons,
          effectiveAgentSettings,
          agentAvailability,
          pluginConfigs.has(id)
        )
      ),
      resolveToolbarGroup
    );
  }, [
    toolbarLayout.leftButtons,
    launcherOnRight,
    unpositionedAgentPins,
    pinnedButtons,
    effectiveAgentSettings,
    agentAvailability,
    pluginConfigs,
    resolveToolbarGroup,
  ]);

  const effectiveRightButtons = useMemo(() => {
    // Dedupe the persisted base before appending plugin extras, so duplicate
    // ids (e.g. repeated `forge-stats`, #10937) can't render twice.
    const base = Array.from(new Set(toolbarLayout.rightButtons));
    if (launcherOnRight && unpositionedAgentPins.length > 0) {
      const launcherIndex = base.indexOf("launcher");
      base.splice(
        launcherIndex === -1 ? base.length : launcherIndex + 1,
        0,
        ...unpositionedAgentPins
      );
    }
    const positioned = new Set([...base, ...toolbarLayout.leftButtons]);
    // Only *promoted* contributions append — plugin buttons reach the user
    // through the tray by default now (#11304), so the pre-tray behavior of
    // appending every registered id would resurrect the crowding this
    // replaced. Buttons the user already dragged into a side list keep that
    // position and are filtered on promotion below like any other id.
    const extra = pluginButtonIds.filter((id) => !positioned.has(id) && pinnedButtons[id] === true);
    return [...base, ...extra].filter((id) =>
      isToolbarButtonVisible(
        id,
        pinnedButtons,
        effectiveAgentSettings,
        agentAvailability,
        pluginConfigs.has(id)
      )
    );
  }, [
    toolbarLayout.rightButtons,
    toolbarLayout.leftButtons,
    launcherOnRight,
    unpositionedAgentPins,
    pluginButtonIds,
    pinnedButtons,
    effectiveAgentSettings,
    agentAvailability,
    pluginConfigs,
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
    // The panel is portaled to document.body, so the wrapper's `invisible
    // absolute` eviction styles never reach it — an open panel would strand on
    // screen and then re-anchor to the hidden button's rect on the next resize.
    if (overflowSet.has("copy-tree")) {
      const focusWasInPanel = isInsideCopyTreePanel(document.activeElement);
      setCopyTreeOpen(false);
      // The anchor is on its way to being hidden, so it can't take focus back.
      // The overflow trigger is where the command now lives, which makes it the
      // honest destination — otherwise a keyboard user is dropped onto <body>.
      // It has to be the trigger on the side that swallowed the button: the
      // other one renders display:none and untabbable when its own side has no
      // overflow, so focusing it would be the silent no-op this prevents.
      if (focusWasInPanel) {
        const side = rightOverflow.includes("copy-tree") ? "right" : "left";
        toolbarRef.current
          ?.querySelector<HTMLElement>(
            `[data-toolbar-overflow-trigger][data-toolbar-overflow-side="${side}"][data-visible="true"]`
          )
          ?.focus();
      }
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
    // `buttonIds` arrives already grouped, so a divider belongs after every
    // visible button whose declared group differs from the next visible one
    // (#11681). Overflow-hidden buttons stay mounted for measurement but are
    // excluded, so an evicted button never strands a divider.
    const dividerAfter = getToolbarDividerAfterIds(
      available,
      (id) => visibleSet.has(id),
      resolveToolbarGroup
    );

    const elements: React.ReactNode[] = [];
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
      if (isVisible && dividerAfter.has(id)) {
        elements.push(
          <div key={`group-divider-${id}`} className={toolbarDividerClass} aria-hidden="true" />
        );
      }
    }
    return elements;
  };

  const pluginTrayGroups = useMemo(
    () =>
      groupPluginToolbarButtons(pluginConfigs, (id) => pluginMetaById.get(id)?.displayName ?? id),
    [pluginConfigs, pluginMetaById]
  );

  const pluginOverflowMeta = useMemo(
    () => buildPluginToolbarMeta(pluginButtonIds, pluginConfigs),
    [pluginButtonIds, pluginConfigs]
  );

  const overflowActions = useMemo<Partial<Record<AnyToolbarButtonId, () => void>>>(
    () => ({
      ...Object.fromEntries(LAUNCHABLE_AGENT_IDS.map((id) => [id, () => onLaunchAgent(id)])),
      terminal: () => onLaunchAgent("terminal"),
      browser: () => onLaunchAgent("browser"),
      "file-browser": openFileBrowser,
      "dev-server": () => {
        void actionService.dispatch("devServer.start", undefined, { source: "user" });
      },
      "notification-center": () => {
        void actionService.dispatch("notifications.toggle", undefined, { source: "user" });
      },
      "copy-tree": () => {
        void handleCopyTreeClick();
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
      openFileBrowser,
      handleCopyTreeClick,
      onSettings,
      onToggleProblems,
      pluginButtonIds,
      pluginConfigs,
    ]
  );

  // Mirrors the launcher's own row gates so an inlined overflow row degrades
  // the same way the launcher row does rather than silently opening nothing.
  const panelTrayDisabled: Partial<Record<string, boolean>> = {
    "file-browser": !hasWorkspace,
    "dev-server": !currentProject,
  };

  // Same filter the launcher's own Launch section applies, so the rows the
  // overflow menu inlines are exactly the rows the dropdown would have shown.
  const launcherAgentIds = useMemo(
    () => LAUNCHABLE_AGENT_IDS.filter((id) => isAgentLaunchable(agentAvailability?.[id])),
    [agentAvailability]
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
    "file-browser": fileBrowserShortcut,
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
      pluginTrayGroups={pluginTrayGroups}
      launcherAgentIds={launcherAgentIds}
      panelTrayDisabled={panelTrayDisabled}
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
  const chipState = branchChipState(
    workspaceIdentity.kind,
    branchName,
    isGitBackedProject(currentProject)
  );
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
          {chipState !== "hidden" && (
            <span
              className={cn(
                "toolbar-project-chip shrink-0 inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 font-mono tabular-nums",
                chipState === "reserved" && "opacity-0"
              )}
              aria-label={chipState === "visible" ? `Current branch ${branchName}` : undefined}
              aria-hidden={chipState === "visible" ? undefined : true}
            >
              <GitBranch className="toolbar-project-chip-icon h-3 w-3 shrink-0" />
              <span className="toolbar-project-chip-label">
                {chipState === "visible" ? truncatedBranchName : "main"}
              </span>
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
          className="app-no-drag relative flex items-center justify-center min-w-0 max-w-full pointer-events-none justify-self-center"
        >
          {/* Sibling of the pill, not a child — see ProjectIdentityEditor. */}
          {currentProject && <ProjectIdentityEditor project={currentProject} />}
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
                    onSelect={projectSwitcher.selectRow}
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
                    onMoveOrRenameProject={handleMoveOrRenameProject}
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
                    rankedSearch={projectSwitcher.isRankedSearch}
                    scratchResults={projectSwitcher.scratchResults}
                    onCreateScratch={(name) => void projectSwitcher.createScratch(name)}
                    onSelectScratch={(scratch) => void projectSwitcher.selectScratch(scratch)}
                    onRequestDeleteScratch={projectSwitcher.requestDeleteScratch}
                    deleteScratchConfirm={projectSwitcher.deleteScratchConfirm}
                    onDismissDeleteScratchConfirm={projectSwitcher.dismissDeleteScratchConfirm}
                    onConfirmDeleteScratch={() => void projectSwitcher.confirmDeleteScratch()}
                    isDeletingScratch={projectSwitcher.isDeletingScratch}
                    onRequestDeleteAllScratches={projectSwitcher.requestDeleteAllScratches}
                    deleteAllScratchesConfirm={projectSwitcher.deleteAllScratchesConfirm}
                    onDismissDeleteAllScratchesConfirm={
                      projectSwitcher.dismissDeleteAllScratchesConfirm
                    }
                    onConfirmDeleteAllScratches={() =>
                      void projectSwitcher.confirmDeleteAllScratches()
                    }
                    isDeletingAllScratches={projectSwitcher.isDeletingAllScratches}
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
              style={isFullscreen ? undefined : { width: `${WINDOWS_CAPTION_WIDTH_PX}px` }}
            />
          )}
        </div>
      </div>
    </header>
  );
}
