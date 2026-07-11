import { useMemo, useRef, useCallback, useLayoutEffect } from "react";

import { useShallow } from "zustand/react/shallow";
import { SortableContext, horizontalListSortingStrategy } from "@dnd-kit/sortable";
import { useDndContext, useDroppable } from "@dnd-kit/core";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { usePanelStore, useProjectStore, useWorktreeSelectionStore } from "@/store";
import {
  isDockPanel,
  isFilePanel,
  isPtyPanel,
  type BrowserPanelData,
  type DockPanelData,
  type FilePanelData,
  type PanelInstance,
} from "@shared/types/panel";
import { extractHostPort } from "@/components/Browser/browserUtils";
import { getNarrowPanel } from "@/store/slices/panelRegistry/selectors";
import type { TrashedTerminal } from "@/store/slices";
import { DockedTerminalItem } from "./DockedTerminalItem";
import { DockedNonPtyPanelItem } from "./DockedNonPtyPanelItem";
import { DockedTabGroup } from "./DockedTabGroup";
import { TrashContainer } from "./TrashContainer";
import { WaitingContainer } from "./WaitingContainer";
import { ErrorsContainer } from "./ErrorsContainer";
import { BackgroundContainer } from "./BackgroundContainer";
import { DockLaunchButton } from "./DockLaunchButton";
import {
  DockLaunchMenuItems,
  type DockLaunchAgent,
  type DockLaunchMenuComponents,
} from "./DockLaunchMenuItems";
import {
  SortableDockItem,
  SortableDockPlaceholder,
  DOCK_PLACEHOLDER_ID,
  useIsWorktreeSortDragging,
} from "@/components/DragDrop";
import { useWorktrees } from "@/hooks/useWorktrees";
import { useHorizontalScrollControls } from "@/hooks";
import { useProjectSettings } from "@/hooks/useProjectSettings";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { useToolbarPreferencesStore } from "@/store/toolbarPreferencesStore";
import { sortAgentsByToolbarPin } from "@/lib/agentMenuOrder";
import type { ActionSource } from "@shared/types/actions";
import { actionService } from "@/services/ActionService";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

import { getAgentConfig, getAgentIds } from "@/config/agents";
import { isAssistantOnlyAgentId } from "@shared/config/agentIds";
import { isAgentInstalled } from "@shared/utils/agentAvailability";
import { useHelpPanelStore } from "@/store/helpPanelStore";
import { buildDockRenderItems, type DockRenderItem } from "./dockRenderItems";
import { usePreferencesStore, type DockDensity } from "@/store/preferencesStore";

const DOCK_DENSITY_OPTIONS = [
  { value: "compact", label: "Compact" },
  { value: "normal", label: "Normal" },
  { value: "comfortable", label: "Comfortable" },
] satisfies ReadonlyArray<{ value: DockDensity; label: string }>;

const CONTEXT_MENU_COMPONENTS: DockLaunchMenuComponents = {
  Item: ContextMenuItem,
  Label: ContextMenuLabel,
  Separator: ContextMenuSeparator,
};

export type { DockDensity } from "@/store/preferencesStore";

// Stable empty refs so the narrowed dock subscriptions below can bail under
// `useShallow` when the dock is empty instead of yielding a fresh `[]`.
const EMPTY_DOCK_SIGNATURE: readonly string[] = [];
const EMPTY_DOCK_TERMINALS: readonly DockPanelData[] = [];

interface ContentDockProps {
  density?: DockDensity;
}

// File name beats the generic kind title in the chip, mirroring FilePane's own
// title layering (a user-locked rename still wins).
function fileChipTitle(panel: FilePanelData): string {
  const fileName = panel.filePath?.split(/[/\\]/).filter(Boolean).pop();
  return panel.titleMode === "user" ? panel.title : (fileName ?? panel.title);
}

// Host beats the generic "Browser" title in the chip, mirroring BrowserPane's
// displayTitle (a page-supplied title still wins; a user-locked rename always
// wins). Falls back to the kind title when there's no host to show (e.g.
// about:blank, whose URL.host is empty) so the chip is never blank.
function browserChipTitle(panel: BrowserPanelData): string {
  if (panel.titleMode === "user") return panel.title;
  if (panel.title && panel.title !== "Browser") return panel.title;
  const currentUrl = panel.browserHistory?.present || panel.browserUrl || "";
  const host = currentUrl ? extractHostPort(currentUrl) : "";
  return host || panel.title;
}

export function ContentDock({ density = "normal" }: ContentDockProps) {
  const activeWorktreeId = useWorktreeSelectionStore((state) => state.activeWorktreeId);

  const trashedTerminals = usePanelStore((state) => state.trashedTerminals);
  const storeTabGroups = usePanelStore((state) => state.tabGroups);
  const getTabGroups = usePanelStore((state) => state.getTabGroups);
  const getTabGroupPanels = usePanelStore((state) => state.getTabGroupPanels);
  const currentProject = useProjectStore((s) => s.currentProject);
  const helpTerminalId = useHelpPanelStore((s) => s.terminalId);
  const agentSettings = useAgentSettingsStore((s) => s.settings);
  const agentAvailability = useCliAvailabilityStore((s) => s.availability);
  const leftButtons = useToolbarPreferencesStore(useShallow((s) => s.layout.leftButtons));
  const setDockDensity = usePreferencesStore((s) => s.setDockDensity);
  const { settings: projectSettings } = useProjectSettings();
  const hasDevPreview = Boolean(projectSettings?.devServerCommand?.trim());

  // Narrow dock subscriptions (#10908). Subscribing to the whole `panelsById`
  // re-rendered the dock on every panel's rAF status-buffer flush — including
  // grid agents that never appear here. Both selectors below react only to dock
  // panels. Membership is `isDockPanel` (PTY panels plus the dockable file
  // kind — #10985); each member kind has its own chip below. This is NOT the
  // #10512 grid render-eligibility predicate, which deliberately does not
  // apply to the dock.
  //
  // `dockPanelSignature` is a structural `${id}:${worktreeId}` list that stays
  // referentially stable across status-buffer flushes, so the (activity-agnostic)
  // `tabGroups` derivation recomputes only on real dock membership/scope changes.
  // It iterates `panelsById` (not `panelIds`) so a batched dock panel — committed
  // to `panelsById` before `panelIds` is revealed at flush — still invalidates
  // `tabGroups`, matching the old whole-map subscription's recompute and letting
  // `getTabGroups` surface the index-only panel (#9649).
  const dockPanelSignature = usePanelStore(
    useShallow((state) => {
      const result: string[] = [];
      for (const id of Object.keys(state.panelsById)) {
        const terminal = getNarrowPanel(state.panelsById, id);
        if (
          terminal &&
          isDockPanel(terminal) &&
          terminal.location === "dock" &&
          !state.trashedTerminals.has(terminal.id)
        ) {
          result.push(`${terminal.id}:${terminal.worktreeId ?? ""}`);
        }
      }
      return result.length === 0 ? EMPTY_DOCK_SIGNATURE : result;
    })
  );

  // Live dock panel objects. The dock renders live activity/agent state from
  // these, so unlike the grid this stays object-valued — but `useShallow` only
  // fires when a *dock* panel's reference changes, not on grid-agent churn.
  const dockTerminalsRaw = usePanelStore(
    useShallow((state) => {
      const result: DockPanelData[] = [];
      for (const id of state.panelIds) {
        const terminal = getNarrowPanel(state.panelsById, id);
        if (
          terminal &&
          isDockPanel(terminal) &&
          terminal.location === "dock" &&
          !state.trashedTerminals.has(terminal.id)
        ) {
          result.push(terminal);
        }
      }
      return result.length === 0 ? EMPTY_DOCK_TERMINALS : result;
    })
  );

  // Get tab groups for the dock, excluding the help panel terminal
  const tabGroups = useMemo(() => {
    void dockPanelSignature;
    void storeTabGroups;
    void trashedTerminals;
    const groups = getTabGroups("dock", activeWorktreeId ?? undefined);
    if (!helpTerminalId) return groups;
    return groups.filter((g) => !(g.panelIds.length === 1 && g.panelIds[0] === helpTerminalId));
  }, [
    getTabGroups,
    activeWorktreeId,
    dockPanelSignature,
    storeTabGroups,
    trashedTerminals,
    helpTerminalId,
  ]);

  const dockTerminals = useMemo<DockPanelData[]>(() => {
    // `dockTerminalsRaw` already narrows to dock/dockable/non-trashed panels;
    // apply the help-panel and active-worktree filters here (external stores
    // the store selector can't read).
    const result: DockPanelData[] = [];
    for (const terminal of dockTerminalsRaw) {
      if (
        terminal.id !== helpTerminalId &&
        (terminal.worktreeId == null || terminal.worktreeId === activeWorktreeId)
      ) {
        result.push(terminal);
      }
    }
    return result;
  }, [dockTerminalsRaw, helpTerminalId, activeWorktreeId]);

  // Trashed panels resolved from the store, keyed by id. Values are the actual
  // store panel references (not freshly constructed), so `useShallow` bails
  // unless the trashed set — or a trashed panel's reference — actually changes,
  // rather than on every unrelated status-buffer flush (#10908).
  const trashedPanelsById = usePanelStore(
    useShallow((state) => {
      const result: Record<string, PanelInstance> = {};
      for (const trashed of state.trashedTerminals.values()) {
        const panel = state.panelsById[trashed.id];
        if (panel) result[trashed.id] = panel;
      }
      return result;
    })
  );

  const { worktrees } = useWorktrees();

  const activeWorktree = activeWorktreeId ? worktrees.find((w) => w.id === activeWorktreeId) : null;
  const cwd = activeWorktree?.path ?? currentProject?.path ?? "";

  const { sorted: launchAgents, pinnedCount } = useMemo(() => {
    const baseIds = getAgentIds();
    const settingsIds = agentSettings?.agents ? Object.keys(agentSettings.agents) : [];
    const extraIds = settingsIds.filter((id) => !baseIds.includes(id)).sort();
    const agents: DockLaunchAgent[] = [...baseIds, ...extraIds]
      // Assistant-only agents are never offered in the dock launch menu.
      .filter((id) => !isAssistantOnlyAgentId(id))
      .filter((id) => isAgentInstalled(agentAvailability?.[id]))
      .map((id) => {
        const config = getAgentConfig(id);
        return {
          id,
          name: config?.name ?? id,
          icon: config?.icon,
          brandColor: config?.color,
          availability: agentAvailability?.[id],
        };
      });
    return sortAgentsByToolbarPin(agents, leftButtons, agentSettings);
  }, [agentAvailability, agentSettings, leftButtons]);

  const recipeContext = activeWorktree
    ? {
        issueNumber: activeWorktree.issueNumber,
        prNumber: activeWorktree.linked?.pr?.ref.number,
        branchName: activeWorktree.branch,
        worktreePath: activeWorktree.path,
      }
    : undefined;

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const activeDockIndexRef = useRef(0);
  const prevFocusedDockItemRef = useRef<HTMLElement | null>(null);
  const { canScrollLeft, canScrollRight, scrollLeft, scrollRight } =
    useHorizontalScrollControls(scrollContainerRef);

  // Issue #8170 — roving tabindex over [data-dock-item] chips. The rail is an
  // ARIA toolbar with a single tab stop; Arrow/Home/End move focus across
  // chips. Mirrors the canonical pattern in Toolbar.tsx (lines 324-393);
  // deliberately not lifted into a shared hook — the issue calls that out
  // until a fourth use case appears.
  const { active: dndActive } = useDndContext();
  const isDndActive = dndActive !== null;

  const getDockItems = useCallback(
    () =>
      scrollContainerRef.current
        ? Array.from(
            scrollContainerRef.current.querySelectorAll<HTMLElement>("[data-dock-item]")
          ).filter((el) => el.offsetParent !== null)
        : [],
    []
  );

  const syncDockTabStops = useCallback((items: HTMLElement[], activeIdx: number) => {
    for (const el of items) el.tabIndex = -1;
    if (items[activeIdx]) items[activeIdx].tabIndex = 0;
  }, []);

  useLayoutEffect(() => {
    const items = getDockItems();
    if (items.length === 0) return;
    const clamped = Math.min(activeDockIndexRef.current, items.length - 1);
    activeDockIndexRef.current = clamped;
    syncDockTabStops(items, clamped);

    // Issue #9681 — when the focused chip unmounts (terminal closed, group
    // collapsed), the roving tabindex above re-homes the tab stop but focus
    // has already fallen to <body>. Redirect it onto the promoted chip so
    // keyboard navigation survives. Mirrors Toolbar.tsx's recovery pattern.
    const prevFocused = prevFocusedDockItemRef.current;
    if (prevFocused && !items.includes(prevFocused)) {
      // Clear unconditionally — a stale ref left set would trigger a phantom
      // redirect on an unrelated later render even when focus moved elsewhere.
      prevFocusedDockItemRef.current = null;
      // Only reclaim focus when it genuinely fell to <body>. Focus inside a
      // Radix portal (tooltip, context menu) sets activeElement to the portal
      // node, not body, and must not be hijacked.
      if (document.activeElement === document.body) {
        items[clamped]?.focus();
      }
    }
  });

  const handleDockFocusCapture = useCallback(
    (e: React.FocusEvent<HTMLElement>) => {
      const target = e.target as HTMLElement;
      const items = getDockItems();
      const idx = items.indexOf(target);
      if (idx !== -1) {
        activeDockIndexRef.current = idx;
        prevFocusedDockItemRef.current = target;
        syncDockTabStops(items, idx);
      }
    },
    [getDockItems, syncDockTabStops]
  );

  const handleDockKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLElement>) => {
      // dnd-kit's KeyboardSensor owns Space/Enter (lift) and arrows (move)
      // while a drag is active. Early-return so reordering still works.
      if (dndActive !== null) return;
      if (e.metaKey || e.altKey || e.ctrlKey) return;

      const items = getDockItems();
      if (items.length === 0) return;

      const currentIdx = activeDockIndexRef.current;
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
        activeDockIndexRef.current = newIdx;
        syncDockTabStops(items, newIdx);
        const target = items[newIdx]!;
        // .focus() must precede scrollIntoView — the browser's own
        // scroll-on-focus would otherwise override the explicit instant scroll.
        target.focus();
        target.scrollIntoView({ behavior: "instant", block: "nearest", inline: "nearest" });
      }
    },
    [dndActive, getDockItems, syncDockTabStops]
  );

  // Make the dock terminals area droppable
  const { setNodeRef: setDockDropRef, isOver } = useDroppable({
    id: "dock-container",
    data: { container: "dock" },
  });

  // Worktree-card sort drags cannot drop here — signal rejection with cursor-no-drop.
  const isWorktreeSortDragging = useIsWorktreeSortDragging();

  // Sync droppable ref with scroll container ref using stable callback
  // This prevents ResizeObserver thrashing that causes infinite update loops
  const combinedRef = useCallback(
    (node: HTMLDivElement | null) => {
      scrollContainerRef.current = node;
      setDockDropRef(node);
    },
    [setDockDropRef]
  );

  const handleAddTerminal = useCallback(
    async (agentId: string, source: ActionSource = "menu") => {
      // `activateDockOnCreate` folds the dock activation into the same `set()`
      // that commits the new panel to the store. Without it, the watchdog
      // effect in `DockPanelOffscreenContainer` can fire `closeDockTerminal()`
      // in the render gap between the panel commit and a follow-up
      // `openDockTerminal` call. See #6590.
      await actionService.dispatch<{ terminalId: string | null }>(
        "agent.launch",
        {
          agentId,
          location: "dock",
          cwd,
          worktreeId: activeWorktreeId || undefined,
          activateDockOnCreate: true,
        },
        { source }
      );
    },
    [activeWorktreeId, cwd]
  );

  const trashedItems = Array.from(trashedTerminals.values())
    .map((trashed) => ({
      terminal: trashedPanelsById[trashed.id] as PanelInstance | undefined,
      trashedInfo: trashed,
    }))
    .filter(
      (item): item is { terminal: PanelInstance; trashedInfo: TrashedTerminal } =>
        item.terminal !== undefined
    );

  const dockItems = useMemo<DockRenderItem[]>(() => {
    return buildDockRenderItems(
      tabGroups,
      (groupId) => getTabGroupPanels(groupId, "dock").filter(isPtyPanel),
      helpTerminalId,
      dockTerminals
    );
  }, [tabGroups, getTabGroupPanels, helpTerminalId, dockTerminals]);

  // Tab group IDs for SortableContext
  const panelIds = useMemo(() => {
    if (dockItems.length === 0) {
      return [DOCK_PLACEHOLDER_ID];
    }
    // Use first panel's ID for each group (consistent with terminal-based DnD)
    return dockItems.map((item) => item.panels[0]?.id ?? item.group.id);
  }, [dockItems]);

  const isCompact = density === "compact";

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          id="dock-container"
          className={cn(
            "bg-[var(--dock-bg)]/95 backdrop-blur-sm",
            "border-t border-[var(--dock-border)]",
            "shadow-[var(--dock-shadow)]",
            "flex items-center px-[var(--dock-padding-x)] py-[var(--dock-padding-y)] gap-[var(--dock-gap)]",
            "z-40 shrink-0"
          )}
          data-dock-density={density}
        >
          <div className="shrink-0 flex items-center">
            <DockLaunchButton
              agents={launchAgents}
              pinnedCount={pinnedCount}
              hasDevPreview={hasDevPreview}
              onLaunchAgent={(agentId) => void handleAddTerminal(agentId, "menu")}
              activeWorktreeId={activeWorktreeId}
              cwd={cwd}
              recipeContext={recipeContext}
            />
          </div>

          <div className="relative flex-1 min-w-0">
            {/* Left Scroll Chevron - Overlay */}
            {canScrollLeft && (
              <div className="absolute left-0 top-1/2 -translate-y-1/2 z-10 pointer-events-none bg-gradient-to-r from-[var(--dock-bg)] via-[var(--dock-bg)]/90 to-transparent pr-4">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={scrollLeft}
                      tabIndex={-1}
                      aria-hidden="true"
                      className={cn(
                        "pointer-events-auto p-1.5 text-daintree-text/60 hover:text-daintree-text",
                        "rounded-[var(--radius-md)] transition-colors",
                        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent"
                      )}
                      aria-label="Scroll left"
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">Scroll left</TooltipContent>
                </Tooltip>
              </div>
            )}

            {/* Scrollable Container */}
            <div
              ref={combinedRef}
              role="toolbar"
              aria-label="Docked panels"
              aria-orientation="horizontal"
              aria-busy={isDndActive || undefined}
              onKeyDown={handleDockKeyDown}
              onFocusCapture={handleDockFocusCapture}
              className={cn(
                "flex items-center gap-[var(--dock-gap)] overflow-x-auto overscroll-x-none flex-1 min-h-[var(--dock-item-height)] no-scrollbar scroll-smooth scroll-px-4 px-1 transition-[color,background-color,box-shadow]",
                isWorktreeSortDragging && "cursor-no-drop",
                isOver &&
                  !isWorktreeSortDragging &&
                  "cursor-copy bg-overlay-soft ring-2 ring-border-default ring-inset rounded-[var(--radius-md)]"
              )}
            >
              <SortableContext
                id="dock-container"
                items={panelIds}
                strategy={horizontalListSortingStrategy}
              >
                <div className="flex items-center gap-[var(--dock-gap)] min-w-[100px] min-h-[calc(var(--dock-item-height)-4px)]">
                  {dockItems.length === 0 ? (
                    <SortableDockPlaceholder />
                  ) : (
                    dockItems.map(({ group, panels }, index) => {
                      // Single-panel group: render the kind's chip directly
                      if (panels.length === 1) {
                        const terminal = panels[0]!;
                        return (
                          <SortableDockItem key={group.id} terminal={terminal} sourceIndex={index}>
                            {isPtyPanel(terminal) ? (
                              <DockedTerminalItem terminal={terminal} />
                            ) : isFilePanel(terminal) ? (
                              <DockedNonPtyPanelItem
                                panel={terminal}
                                displayTitle={fileChipTitle(terminal)}
                              />
                            ) : (
                              <DockedNonPtyPanelItem
                                panel={terminal}
                                displayTitle={browserChipTitle(terminal)}
                              />
                            )}
                          </SortableDockItem>
                        );
                      }

                      // Multi-panel group: pass group context for group-aware DnD.
                      // Groups resolve through the isPtyPanel filter above, so
                      // the runtime narrow below never drops a panel.
                      const firstPanel = panels[0]!;
                      return (
                        <SortableDockItem
                          key={group.id}
                          terminal={firstPanel}
                          sourceIndex={index}
                          groupId={group.id}
                          groupPanelIds={group.panelIds}
                        >
                          <DockedTabGroup group={group} panels={panels.filter(isPtyPanel)} />
                        </SortableDockItem>
                      );
                    })
                  )}
                </div>
              </SortableContext>
            </div>

            {/* Right Scroll Chevron - Overlay */}
            {canScrollRight && (
              <div className="absolute right-0 top-1/2 -translate-y-1/2 z-10 pointer-events-none bg-gradient-to-l from-[var(--dock-bg)] via-[var(--dock-bg)]/90 to-transparent pl-4">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={scrollRight}
                      tabIndex={-1}
                      aria-hidden="true"
                      className={cn(
                        "pointer-events-auto p-1.5 text-daintree-text/60 hover:text-daintree-text",
                        "rounded-[var(--radius-md)] transition-colors",
                        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent"
                      )}
                      aria-label="Scroll right"
                    >
                      <ChevronRight className="w-4 h-4" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">Scroll right</TooltipContent>
                </Tooltip>
              </div>
            )}
          </div>

          {/* Separator between terminals and action containers */}
          {dockItems.length > 0 && (
            <div className="w-px h-5 bg-[var(--dock-border)] mx-1 shrink-0" />
          )}

          {/* Action containers: Background + Waiting + Errors + Trash */}
          <div className="shrink-0 pl-1 flex items-center gap-2">
            <BackgroundContainer compact={isCompact} />
            <WaitingContainer compact={isCompact} />
            <ErrorsContainer compact={isCompact} />
            <TrashContainer trashedTerminals={trashedItems} compact={isCompact} />
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <DockLaunchMenuItems
          components={CONTEXT_MENU_COMPONENTS}
          agents={launchAgents}
          pinnedCount={pinnedCount}
          hasDevPreview={hasDevPreview}
          activeWorktreeId={activeWorktreeId}
          cwd={cwd}
          recipeContext={recipeContext}
          onLaunchAgent={(agentId) => void handleAddTerminal(agentId, "context-menu")}
          settingsSource="context-menu"
        />
        <ContextMenuSeparator />
        <ContextMenuSub>
          <ContextMenuSubTrigger>Dock density</ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuRadioGroup value={density}>
              {DOCK_DENSITY_OPTIONS.map(({ value, label }) => (
                <ContextMenuRadioItem
                  key={value}
                  value={value}
                  onSelect={() => setDockDensity(value)}
                >
                  {label}
                </ContextMenuRadioItem>
              ))}
            </ContextMenuRadioGroup>
          </ContextMenuSubContent>
        </ContextMenuSub>
      </ContextMenuContent>
    </ContextMenu>
  );
}
