import { useEffect, useRef, useState } from "react";
import type React from "react";
import { Button } from "@/components/ui/button";
import { CircleDot, Ellipsis, GitCommit, GitPullRequest, TriangleAlert } from "lucide-react";
import { Spinner } from "@/components/ui/Spinner";
import { GitBranch } from "@/components/icons";
import { TOOLBAR_BUTTON_METADATA, type ToolbarButtonGroup } from "./toolbarButtonMetadata";
import { TOOLBAR_CUSTOMIZE_ICON, TOOLBAR_CUSTOMIZE_LABEL } from "./toolbarMenuStrings";
import { toolbarIconButtonClass } from "./toolbarItemClasses";
import { PluginOverflowItem, type PluginTrayGroup } from "./PluginTrayButton";
import {
  PluginToolbarPopover,
  closePluginToolbarPopoverIfHidden,
  focusToolbarControl,
  pluginCommandFocusTarget,
} from "./PluginToolbarPopover";
import { PopoverAnchor } from "@/components/ui/popover";
import { usePluginToolbarPopoverStore } from "@/store/pluginToolbarPopoverStore";
import type { LauncherPanelItem } from "./launcherPanelItems";
import { usePluginRuntimeStore } from "@/store/pluginRuntimeStore";
import { copyWithToast } from "@/lib/copyWithToast";
import type { ToolbarButtonConfig } from "@shared/config/toolbarButtonRegistry";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuActionItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuMeta,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useDohertyGate } from "@/hooks";
import type { AnyToolbarButtonId } from "@shared/types/toolbar";
import {
  agentStateDotColor,
  STATE_LABELS,
  type AttentionAgentState,
} from "@/components/Worktree/terminalStateConfig";
import type { ForgeRepositoryStats } from "@shared/types/ipc/forge";
import type { ForgeStatsHandle } from "./ForgeStatsToolbarButton";
import type { OverflowBadgeSeverity } from "./useOverflowBadgeSeverity";
import { useCopyTreeRunStore } from "@/store/copyTreeRunStore";
import { useUIStore } from "@/store/uiStore";
import { useDiagnosticsStore } from "@/store/diagnosticsStore";
import { useCanopyStore } from "@/store/canopyStore";
import { isBuiltInAgentId, type BuiltInAgentId } from "@shared/config/agentIds";
import { pluralize } from "@/lib/pluralize";
import { cn } from "@/lib/utils";
import { formatCountExact } from "@/lib/formatCount";

export type OverflowMenuMeta = { label: string; icon: React.ComponentType<{ className?: string }> };

// Adapter view over the unified `TOOLBAR_BUTTON_METADATA` registry.
const overflowMenuMetaInit: Record<string, OverflowMenuMeta> = {};
for (const [id, meta] of Object.entries(TOOLBAR_BUTTON_METADATA)) {
  if (!meta) continue;
  overflowMenuMetaInit[id] = { label: meta.label, icon: meta.icon };
}
// The action behind each overflow item's shortcut: the same binding its
// visible button shows.
export const OVERFLOW_KEYBINDING_BY_ID: Partial<Record<string, string>> = {
  "copy-tree": "worktree.copyTree",
  "notification-center": "notifications.toggle",
  canopy: "canopy.toggle",
  "command-palette": "action.palette.open",
  "resume-sessions": "terminal.resumeSessions",
  "dev-server": "devServer.start",
  settings: "app.settings",
  problems: "panel.toggleDiagnostics",
  terminal: "agent.terminal",
  browser: "agent.browser",
  "file-browser": "worktree.openFileBrowserPanel",
};

export const OVERFLOW_MENU_META: Partial<Record<AnyToolbarButtonId, OverflowMenuMeta>> =
  overflowMenuMetaInit;

export interface OverflowMenuProps {
  overflowIds: AnyToolbarButtonId[];
  side: "left" | "right";
  severity: OverflowBadgeSeverity;
  errorCount: number;
  notificationUnreadCount: number;
  /** Asks Canopy reads as urgent, said when its button is folded in here. */
  canopyUrgentCount: number;
  /** Extra classes for the trigger button: the left one's clearance in its row. */
  triggerClassName?: string;
  /** Problems' watcher observation ("File watching degraded"), or null. */
  watcherStatus?: string | null;
  // Per-session agent states behind the badge, already worded — derived by
  // the same rule as `severity`, so the name never says less than the dot.
  agentObservations: readonly string[];
  agentAttentionStates: Map<string, AttentionAgentState | null>;
  canCopyTree: boolean;
  forgeStatsRef: React.RefObject<ForgeStatsHandle | null>;
  // Display name of the resolved forge provider, or null when none resolves
  // (no matching plugin / owning plugin disabled) — the stats group is
  // skipped entirely in that case.
  forgeProviderName: string | null;
  /** The capsule's "data unavailable" warning, carried into its group here. */
  forgeDataUnavailable?: boolean;
  overflowActions: Partial<Record<AnyToolbarButtonId, () => void>>;
  // Display metadata for every dynamically-registered button — plugin
  // contributions and pinned launcher items (#12217) alike. The overflow menu
  // only ever reads a label and a glyph off it, so one map covers both.
  dynamicOverflowMeta: Record<string, OverflowMenuMeta>;
  // Plugin contributions grouped by owning plugin. When `plugin-tray` itself
  // overflows, its dropdown is unreachable, so the overflow menu inlines these
  // groups instead — an un-promoted contribution has no other toolbar route.
  pluginTrayGroups: PluginTrayGroup[];
  // Every plugin contribution by id, so a promoted one that overflowed renders
  // with its live badge rather than as a bare label.
  pluginConfigs: ReadonlyMap<string, ToolbarButtonConfig>;
  // Launchable agent ids, in the launcher's own order. When `launcher` itself
  // overflows its dropdown is unreachable, so the overflow menu inlines these
  // alongside the panels — since #11680 an unpinned agent has no other toolbar
  // route.
  launcherAgentIds: BuiltInAgentId[];
  // The launcher's panel rows this project offers, inlined beside the agents
  // for the same reason; a project can hide the dev preview's (#14069).
  launcherPanelItems: readonly LauncherPanelItem[];
  // Per-item availability for the inlined launcher panel rows, mirroring the
  // gates the launcher applies to its own rows.
  panelTrayDisabled: Partial<Record<string, boolean>>;
  // Action ids keyed by toolbar button id, so each overflow item shows the
  // same live binding its visible button does (issue #9821).
  keybindingById: Partial<Record<string, string>>;
  // The project pill's branch chip, when this project's profile demotes it
  // here (#13783): what the chip would have said, and what selecting copies.
  branchRow?: { label: string; copyLabel: string; copyValue: string } | null;
  // The strip's own grouping, so the menu draws a separator wherever the strip
  // would have drawn a divider between the buttons it now holds.
  resolveGroup: (id: AnyToolbarButtonId) => ToolbarButtonGroup;
  // Why a pinned launcher row can't launch right now, keyed by its button id —
  // the visible button is disabled with this reason, so its row is too.
  unavailableReasonById: Partial<Record<string, string>>;
}

// Overflow `…` menu. A component (not just a render helper) so the trigger can
// stay mounted across the empty↔non-empty transition and animate its entry /
// exit via CSS (issue #9821) while `open` stays controlled — avoiding React's
// controlled/uncontrolled warning. Each menu item restores the contextual
// state its source toolbar button carries: error/unread counts, agent-state
// dots, and keyboard shortcut hints.
export function OverflowMenu({
  overflowIds,
  side,
  severity,
  errorCount,
  notificationUnreadCount,
  canopyUrgentCount,
  watcherStatus = null,
  triggerClassName,
  agentObservations,
  agentAttentionStates,
  canCopyTree,
  forgeStatsRef,
  forgeProviderName,
  forgeDataUnavailable = false,
  overflowActions,
  dynamicOverflowMeta,
  pluginTrayGroups,
  pluginConfigs,
  launcherAgentIds,
  launcherPanelItems,
  panelTrayDisabled,
  keybindingById,
  branchRow = null,
  resolveGroup,
  unavailableReasonById,
}: OverflowMenuProps) {
  const [open, setOpen] = useState(false);
  // Read here rather than threaded through props: the overflow copy-tree item
  // mirrors the visible button's disabled states, and in-flight copies can
  // start from routes that never touch this menu (MCP, Cmd+Shift+C).
  const isCopyingTree = useCopyTreeRunStore((s) => s.activeRunCount > 0);
  const showCopyingSpinner = useDohertyGate(isCopyingTree);
  // Snapshot of the repo stats taken when the menu opens. The stats live in
  // ForgeStatsToolbarButton's hook and are exposed through its imperative
  // handle, so they can't be read during render (refs aren't reactive — the
  // menu wouldn't re-render on updates anyway). Reading in the open handler
  // captures them at the only moment they're about to become visible.
  const [repoStats, setRepoStats] = useState<ForgeRepositoryStats | null>(null);
  const popoverOrigin = side === "left" ? "overflow-left" : "overflow-right";
  const openPopover = usePluginToolbarPopoverStore((s) => s.open);
  // A plugin popover picked from a row opens once the menu has closed, off the
  // `…` button — the row goes with the menu. The store holds it meanwhile; see
  // its `deferred` for why the close hook spends it rather than the row.
  const deferPopover = usePluginToolbarPopoverStore((s) => s.defer);
  const takeDeferredPopover = usePluginToolbarPopoverStore((s) => s.takeDeferred);
  const selectPluginItem = (config: ToolbarButtonConfig) => {
    if (config.popover) {
      deferPopover(config.id, popoverOrigin);
      return;
    }
    overflowActions[config.id]?.();
  };
  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      // Dropped on reopen: a menu reopened inside its exit animation never ran
      // the close hook that spends it.
      takeDeferredPopover(popoverOrigin);
      setRepoStats(forgeStatsRef.current?.stats ?? null);
      // Same reason PluginTrayButton refreshes on open: a dev-attached plugin
      // registers its buttons without broadcasting provenance, so its display
      // name can be missing and the inlined groups would fall back to raw
      // plugin ids.
      if (pluginTrayGroups.length > 0) usePluginRuntimeStore.getState().refresh();
    }
    setOpen(nextOpen);
  };
  const isEmpty = overflowIds.length === 0 && branchRow === null;

  // Keep the controlled `open` state in sync when the menu empties: Radix
  // closes the popover when `open` is forced false, but `open` state would
  // stay `true`, so the next non-empty transition would reopen the menu with
  // no user action. Resetting here makes re-appearing overflow start closed.
  useEffect(() => {
    if (isEmpty) setOpen(false);
  }, [isEmpty]);
  // The `…` button hides with nothing to hold, and a plugin popover hanging off
  // it would be left pointing at nothing. What it held is back on the toolbar,
  // which is where focus goes.
  useEffect(() => {
    if (!isEmpty) return;
    closePluginToolbarPopoverIfHidden((opening) => opening.origin === popoverOrigin);
  }, [isEmpty, popoverOrigin]);
  // Set in onPointerDownOutside, read in onCloseAutoFocus. Suppresses focus
  // restoration for pointer dismissals so the ellipsis button doesn't keep its
  // accent focus-visible ring; keyboard close (Escape/Enter) still gets default
  // focus return for WAI-ARIA. Local to this component so react-compiler doesn't
  // flag mutating a ref passed in as a prop.
  const overflowMenuPointerCloseRef = useRef(false);

  // Keep the accessible name stable and terse: a comma-enumerated list of
  // the hidden buttons re-announces the full set on every focus pass and goes
  // stale as resize-driven overflow changes. The count is always a count of
  // hidden items — it was once re-nouned to "problems" whenever the badge lit,
  // which read five hidden commands as five problems. What the badge is
  // actually reporting rides behind the count instead, as the observations
  // themselves: the error count, the unread count, the agent states seen.
  const n = overflowIds.length + (branchRow === null ? 0 : 1);
  // What each folded signal button would be marking right now. A mark stands
  // down while the surface it reports on is open, here as on the strip, so the
  // trigger's name never says more than its dot.
  const diagnosticsOpen = useDiagnosticsStore((s) => s.isOpen);
  const notificationCenterOpen = useUIStore((s) => s.notificationCenterOpen);
  const canopyOpen = useCanopyStore((s) => s.isOpen);
  const signalMark = (
    id: AnyToolbarButtonId
  ): { pip: "error" | "warning" | "waiting" | "unread"; spoken: string } | null => {
    if (id === "problems" && !diagnosticsOpen) {
      if (errorCount > 0) {
        const errors = pluralize(errorCount, "error");
        return {
          pip: "error",
          spoken: watcherStatus ? `${errors}, ${watcherStatus.toLowerCase()}` : errors,
        };
      }
      if (watcherStatus) return { pip: "warning", spoken: watcherStatus.toLowerCase() };
    }
    if (id === "canopy" && canopyUrgentCount > 0 && !canopyOpen) {
      return { pip: "waiting", spoken: `${canopyUrgentCount} urgent` };
    }
    if (id === "notification-center" && notificationUnreadCount > 0 && !notificationCenterOpen) {
      return { pip: "unread", spoken: `${notificationUnreadCount} unread` };
    }
    return null;
  };
  // The trigger's own words: counts only. The watcher's wording already
  // arrives with the side's observations, so it is never said twice.
  const observations: string[] = [];
  if (overflowIds.includes("problems") && errorCount > 0 && !diagnosticsOpen) {
    observations.push(pluralize(errorCount, "error"));
  }
  for (const id of ["notification-center", "canopy"] as const) {
    if (!overflowIds.includes(id)) continue;
    const mark = signalMark(id);
    if (mark) observations.push(mark.spoken);
  }
  observations.push(...agentObservations);
  const tooltipText = `More — ${n} hidden${observations.length > 0 ? ` · ${observations.join(" · ")}` : ""}`;
  const ariaLabel = `More toolbar items — ${n} hidden${observations.length > 0 ? `, ${observations.join(", ")}` : ""}`;

  // Counts follow their marks: a surface that is open is showing them itself.
  const overflowCount = (id: AnyToolbarButtonId) => {
    if (id === "problems" && errorCount > 0 && !diagnosticsOpen) return errorCount;
    if (id === "notification-center" && notificationUnreadCount > 0 && !notificationCenterOpen)
      return notificationUnreadCount;
    if (id === "canopy" && canopyUrgentCount > 0 && !canopyOpen) return canopyUrgentCount;
    return null;
  };

  const renderOverflowEntry = (id: AnyToolbarButtonId): React.ReactNode[] => {
    if (id === "forge-stats") {
      // Without a resolved forge provider the visible slot is the
      // commits-only pill — mirror that here: a local-git group with
      // just the commits row (issues/PRs are forge data). It opens the
      // pill's local commit history (#10414), the only route to it once
      // a project's profile demotes the pill into this menu.
      if (!forgeProviderName) {
        return [
          <DropdownMenuGroup key="forge-group">
            <DropdownMenuLabel>Git</DropdownMenuLabel>
            <DropdownMenuItem
              key="forge-commits"
              onClick={() => forgeStatsRef.current?.openCommits()}
              aria-label={
                repoStats?.commitCount != null
                  ? `Commits, ${formatCountExact(repoStats.commitCount)}`
                  : undefined
              }
            >
              <GitCommit className="mr-2 h-3.5 w-3.5" />
              Commits
              {repoStats?.commitCount != null && (
                <DropdownMenuMeta>{formatCountExact(repoStats.commitCount)}</DropdownMenuMeta>
              )}
            </DropdownMenuItem>
          </DropdownMenuGroup>,
        ];
      }
      return [
        <DropdownMenuGroup key="forge-group">
          <DropdownMenuLabel className="flex items-center gap-1.5">
            {forgeProviderName}
            {/* The capsule's warning segment, folded in with it: without it
                the dashes below say nothing about why. */}
            {forgeDataUnavailable && (
              <span className="ml-auto inline-flex items-center gap-1 font-normal normal-case tracking-normal text-text-secondary">
                <TriangleAlert className="h-3 w-3" aria-hidden="true" />
                Data unavailable
              </span>
            )}
          </DropdownMenuLabel>
          <DropdownMenuItem
            key="forge-issues"
            onClick={() => forgeStatsRef.current?.openIssues()}
            aria-label={
              repoStats?.issueCount != null
                ? `Issues, ${formatCountExact(repoStats.issueCount)}`
                : "Open issues unavailable"
            }
          >
            {/* With no count the row says what the capsule's dash says, and
                its glyph steps down with it, as the capsule's does. */}
            <CircleDot
              className={cn(
                "mr-2 h-3.5 w-3.5",
                repoStats?.issueCount != null ? "text-pr-open" : "text-text-secondary"
              )}
            />
            Issues
            <DropdownMenuMeta>
              {repoStats?.issueCount != null ? formatCountExact(repoStats.issueCount) : "—"}
            </DropdownMenuMeta>
          </DropdownMenuItem>
          <DropdownMenuItem
            key="forge-prs"
            onClick={() => forgeStatsRef.current?.openPrs()}
            aria-label={
              repoStats?.prCount != null
                ? `Pull requests, ${formatCountExact(repoStats.prCount)}`
                : "Open pull requests unavailable"
            }
          >
            <GitPullRequest
              className={cn(
                "mr-2 h-3.5 w-3.5",
                repoStats?.prCount != null ? "text-pr-merged" : "text-text-secondary"
              )}
            />
            Pull requests
            <DropdownMenuMeta>
              {repoStats?.prCount != null ? formatCountExact(repoStats.prCount) : "—"}
            </DropdownMenuMeta>
          </DropdownMenuItem>
          <DropdownMenuItem
            key="forge-commits"
            onClick={() => forgeStatsRef.current?.openCommits()}
            aria-label={
              repoStats?.commitCount != null
                ? `Commits, ${formatCountExact(repoStats.commitCount)}`
                : "Commits unavailable"
            }
          >
            <GitCommit
              className={cn(
                "mr-2 h-3.5 w-3.5",
                repoStats?.commitCount == null && "text-text-secondary"
              )}
            />
            Commits
            <DropdownMenuMeta>
              {repoStats?.commitCount != null ? formatCountExact(repoStats.commitCount) : "—"}
            </DropdownMenuMeta>
          </DropdownMenuItem>
        </DropdownMenuGroup>,
      ];
    }
    if (id === "plugin-tray") {
      // The tray's own dropdown can't be opened from here, and an
      // un-promoted contribution has no other toolbar route — so inline
      // the grouped contributions rather than leaving a row that
      // dismisses the menu and opens nothing.
      if (pluginTrayGroups.length === 0) return [];
      return [
        ...pluginTrayGroups.map((group) => (
          <DropdownMenuGroup key={`plugin-tray-${group.pluginId}`}>
            <DropdownMenuLabel>{group.displayName}</DropdownMenuLabel>
            {group.buttons.map((config) => (
              <PluginOverflowItem
                key={config.id}
                config={config}
                onSelect={() => selectPluginItem(config)}
              />
            ))}
          </DropdownMenuGroup>
        )),
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
      const inlinedPanels = launcherPanelItems.filter((item) => !overflowIds.includes(item.id));
      if (inlinedAgents.length === 0 && inlinedPanels.length === 0) return [];
      return [
        ...inlinedAgents.map((agentId) => {
          const agentMeta = OVERFLOW_MENU_META[agentId]!;
          return (
            <AgentOverflowItem
              key={`launcher-${agentId}`}
              id={agentId}
              label={agentMeta.label}
              Icon={agentMeta.icon}
              attentionState={agentAttentionStates.get(agentId) ?? null}
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
              keybinding={keybindingById[item.id]}
            >
              <Icon className="mr-2 h-3.5 w-3.5" />
              <span className="flex-1">{item.label}</span>
            </DropdownMenuItem>
          );
        }),
      ];
    }
    const pluginConfig = pluginConfigs.get(id);
    if (pluginConfig) {
      return [
        <PluginOverflowItem
          key={id}
          config={pluginConfig}
          onSelect={() => selectPluginItem(pluginConfig)}
          keybinding={keybindingById[id]}
        />,
      ];
    }
    const meta = OVERFLOW_MENU_META[id] ?? dynamicOverflowMeta[id];
    if (!meta) return [];
    if (isBuiltInAgentId(id)) {
      return [
        <AgentOverflowItem
          key={id}
          id={id}
          label={meta.label}
          Icon={meta.icon}
          attentionState={agentAttentionStates.get(id) ?? null}
          onSelect={() => overflowActions[id]?.()}
        />,
      ];
    }
    const Icon = meta.icon;
    // Mirror the visible copy-tree button, which declines both when there
    // is nothing to copy yet (no workspace, or a project's worktrees still
    // loading) and while a copy is in flight — without this the overflow item would
    // look live yet silently close with no feedback, since its handler
    // guards on the same two conditions.
    const unavailableReason = unavailableReasonById[id];
    const disabled =
      (id === "copy-tree" && (!canCopyTree || isCopyingTree)) || unavailableReason !== undefined;
    // The in-flight reason is spelled out, as the visible button's
    // spinner and "Copying…" name do — a greyed row alone reads as
    // unavailable rather than busy. The label carries it rather than a
    // trailing meta, which would widen the open menu and snap it back
    // narrower the moment the copy lands.
    const copying = id === "copy-tree" && isCopyingTree;
    const count = overflowCount(id);
    const mark = signalMark(id);
    return [
      <DropdownMenuItem
        key={id}
        disabled={disabled}
        onClick={() => overflowActions[id]?.()}
        keybinding={keybindingById[id]}
      >
        {copying && showCopyingSpinner ? (
          <Spinner size="sm" className="mr-2" rootAttributes={{ "data-menu-icon": "" }} />
        ) : mark ? (
          // The mark the button itself would wear, on the row's glyph.
          <span
            data-menu-icon=""
            className="relative mr-2 inline-flex h-3.5 w-3.5 items-center justify-center"
          >
            <Icon className="h-3.5 w-3.5" />
            <span
              aria-hidden="true"
              data-pip={mark.pip === "waiting" ? "waiting" : undefined}
              data-badge-color={
                mark.pip === "error" ? "error" : mark.pip === "warning" ? "warning" : undefined
              }
              className={cn(
                "toolbar-menu-pip status-mark absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full ring-1 ring-[var(--overlay-surface-solid,var(--color-surface-sidebar))]",
                mark.pip === "error" && "bg-status-error",
                mark.pip === "warning" && "bg-status-warning",
                mark.pip === "waiting" && "bg-state-waiting",
                mark.pip === "unread" && "bg-text-secondary"
              )}
            />
          </span>
        ) : (
          <Icon className="mr-2 h-3.5 w-3.5" />
        )}
        {id === "copy-tree" ? (
          // Both labels share one grid cell so the row is always as wide
          // as the longer one: the open menu keeps its width when a copy
          // starts or lands under the pointer.
          <span className="grid flex-1">
            <span className="[grid-area:1/1]">{copying ? "Copying context…" : meta.label}</span>
            <span aria-hidden="true" className="invisible [grid-area:1/1]">
              Copying context…
            </span>
          </span>
        ) : (
          <span className="flex-1">
            {meta.label}
            {/* The mark is aria-hidden; the row's name says what it draws,
                with its unit, in the buttons' own "— 3 errors" form. */}
            {mark && <span className="sr-only">{` — ${mark.spoken}`}</span>}
          </span>
        )}
        {count !== null && (
          <DropdownMenuMeta aria-hidden={mark !== null ? true : false}>{count}</DropdownMenuMeta>
        )}
        {unavailableReason !== undefined && (
          <DropdownMenuMeta aria-hidden={false}>{unavailableReason}</DropdownMenuMeta>
        )}
      </DropdownMenuItem>,
    ];
  };

  const entryNodes = joinOverflowBlocks(
    overflowIds.map((id) => ({ id, nodes: renderOverflowEntry(id) })),
    resolveGroup
  );

  return (
    <PluginToolbarPopover origin={popoverOrigin} configs={pluginConfigs}>
      <DropdownMenu open={isEmpty ? false : open} onOpenChange={handleOpenChange}>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <PopoverAnchor asChild restoreFocus>
                <Button
                  variant="ghost"
                  size="icon"
                  data-toolbar-item=""
                  data-toolbar-overflow-trigger=""
                  // The no-drag rectangle lives on the button itself, not on a
                  // wrapper: an empty trigger is display:none, and a wrapper
                  // around it would stay a zero-width flex item that still owns a
                  // gap — which is what gave the fixed divider 12px of clearance
                  // on one side while there was nothing to overflow.
                  className={cn(toolbarIconButtonClass, "app-no-drag shrink-0", triggerClassName)}
                  data-toolbar-overflow-side={side}
                  data-visible={isEmpty ? "false" : "true"}
                  aria-hidden={isEmpty || undefined}
                  tabIndex={isEmpty ? -1 : undefined}
                  aria-label={ariaLabel}
                >
                  {/* The hidden buttons' most severe mark, in the shape that
                      button would wear, on the glyph like every other pip. */}
                  <span className="relative inline-flex">
                    <Ellipsis />
                    <span
                      aria-hidden="true"
                      data-testid="toolbar-overflow-badge"
                      data-severity={severity}
                      data-visible={severity !== null && !open}
                      className="toolbar-pip toolbar-overflow-badge toolbar-badge pointer-events-none"
                    />
                  </span>
                </Button>
              </PopoverAnchor>
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
            const pendingPopover = takeDeferredPopover(popoverOrigin);
            if (pendingPopover !== null) {
              // The popover takes focus into itself; returning it to the button
              // first would only flash a ring on the way.
              e.preventDefault();
              overflowMenuPointerCloseRef.current = false;
              if (!isEmpty) {
                openPopover(pendingPopover, popoverOrigin);
                return;
              }
              // The menu emptied while it closed: the `…` button the popover
              // would hang off, and would hand focus back to, is gone, and the
              // row's command is back on the toolbar.
              const target = pluginCommandFocusTarget(pendingPopover);
              if (target !== null) focusToolbarControl(target);
              return;
            }
            if (overflowMenuPointerCloseRef.current) {
              e.preventDefault();
              overflowMenuPointerCloseRef.current = false;
            }
          }}
        >
          {branchRow !== null && (
            <DropdownMenuGroup key="branch-chip">
              <DropdownMenuItem
                onClick={() => copyWithToast(branchRow.copyLabel, branchRow.copyValue)}
                data-toolbar-overflow-branch=""
              >
                <GitBranch className="mr-2 h-3.5 w-3.5" />
                <span className="flex-1">{branchRow.label}</span>
                <DropdownMenuMeta>Copy</DropdownMenuMeta>
              </DropdownMenuItem>
            </DropdownMenuGroup>
          )}
          {branchRow !== null && entryNodes.length > 0 && <DropdownMenuSeparator />}
          {entryNodes}
          {/* Where to change what is hidden here, from the one menu that only
              exists because the strip ran out of room. */}
          {(branchRow !== null || entryNodes.length > 0) && <DropdownMenuSeparator />}
          <DropdownMenuActionItem actionId="app.settings.openTab" args={{ tab: "toolbar" }}>
            <TOOLBAR_CUSTOMIZE_ICON
              data-menu-icon
              className="mr-2 h-3.5 w-3.5"
              aria-hidden="true"
            />
            {TOOLBAR_CUSTOMIZE_LABEL}
          </DropdownMenuActionItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </PluginToolbarPopover>
  );
}

// Entries that inline a whole group of their own rows (a forge's three counts, a
// plugin's contributions, the launcher's agents and panels) are fenced off on
// both sides; single rows are separated only where their toolbar group changes,
// which is exactly where the strip drew a divider between the same buttons.
const MULTI_ROW_OVERFLOW_IDS: ReadonlySet<AnyToolbarButtonId> = new Set([
  "forge-stats",
  "plugin-tray",
  "launcher",
]);

function joinOverflowBlocks(
  blocks: ReadonlyArray<{ id: AnyToolbarButtonId; nodes: React.ReactNode[] }>,
  resolveGroup: (id: AnyToolbarButtonId) => ToolbarButtonGroup
): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let previous: AnyToolbarButtonId | null = null;
  for (const { id, nodes } of blocks) {
    if (nodes.length === 0) continue;
    if (
      previous !== null &&
      (MULTI_ROW_OVERFLOW_IDS.has(previous) ||
        MULTI_ROW_OVERFLOW_IDS.has(id) ||
        resolveGroup(previous) !== resolveGroup(id))
    ) {
      out.push(<DropdownMenuSeparator key={`overflow-sep-${id}`} />);
    }
    out.push(...nodes);
    previous = id;
  }
  return out;
}

// Overflow menu item for a built-in agent. Restores the two signals the bare
// overflow item dropped: the colored agent-state dot and the keyboard shortcut.
function AgentOverflowItem({
  id,
  label,
  Icon,
  attentionState,
  onSelect,
}: {
  id: string;
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
  attentionState: AttentionAgentState | null;
  onSelect: () => void;
}) {
  const dotColor = attentionState ? agentStateDotColor(attentionState) : null;
  return (
    <DropdownMenuItem onClick={onSelect} keybinding={`agent.${id}`}>
      <span
        data-menu-icon=""
        className="relative mr-2 inline-flex h-3.5 w-3.5 items-center justify-center"
      >
        <Icon className="h-3.5 w-3.5" />
        {dotColor && (
          <span
            aria-hidden="true"
            data-pip={attentionState ?? undefined}
            className={cn(
              "toolbar-menu-pip status-mark absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full ring-1 ring-[var(--overlay-surface-solid,var(--color-surface-sidebar))]",
              dotColor
            )}
          />
        )}
      </span>
      <span className="flex-1">
        {label}
        {/* The pip is aria-hidden; the row's name carries what it draws, in
            the agent button's own "— waiting" form. */}
        {attentionState && dotColor && (
          <span className="sr-only">{` — ${STATE_LABELS[attentionState]}`}</span>
        )}
      </span>
    </DropdownMenuItem>
  );
}
