import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  useDndMonitor,
  closestCenter,
  useSensor,
  useSensors,
  PointerSensor,
  TouchSensor,
  type DragEndEvent,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy, arrayMove } from "@dnd-kit/sortable";
import { restrictToHorizontalAxis, restrictToParentElement } from "@dnd-kit/modifiers";
import { LayoutGroup, AnimatePresence, m } from "framer-motion";
import { ChevronDown, CopyPlus } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn, getBaseTitle } from "@/lib/utils";
import { logError } from "@/utils/logger";
import { useTabOverflow } from "@/hooks";
import { useTerminalInputStore, usePanelStore, useFocusStore } from "@/store";
import type { PtyPanelData } from "@shared/types/panel";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { useCcrPresetsStore } from "@/store/ccrPresetsStore";
import { useProjectPresetsStore } from "@/store/projectPresetsStore";
import { getMergedPresets } from "@/config/agents";
import { TerminalContextMenu } from "@/components/Terminal/TerminalContextMenu";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import { getTerminalFocusTarget } from "@/components/Terminal/terminalFocus";
import { deriveTerminalChrome } from "@/utils/terminalChrome";
import { getTerminalAgentDisplayState } from "@/utils/terminalAgentDisplayState";
import {
  getEffectiveStateIcon,
  getEffectiveStateColor,
  getEffectiveStateLabel,
} from "@/components/Worktree/terminalStateConfig";
import { TerminalRefreshTier } from "@/types";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { useDockPanelPortal } from "./dockPanelPortalContext";
import {
  useDockBlockedState,
  getDockDisplayAgentState,
  getGroupBlockedAgentState,
  isGroupDeprioritized,
} from "./useDockBlockedState";
import { SortableTabButton } from "@/components/Panel/SortableTabButton";
import { makeSortableAnnouncements } from "@/components/DragDrop/sortableAnnouncements";
import type { TabGroup } from "@/types";
import { buildPanelDuplicateOptions } from "@/services/terminal/panelDuplicationService";
import {
  handleDockInteractOutside,
  handleDockEscapeKeyDown,
  handleDockFocusOutside,
} from "./dockPopoverGuard";
import { usePreferencesStore } from "@/store";
import { UI_ANIMATION_DURATION, EASE_OUT_EXPO_FM } from "@/lib/animationUtils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DockPopoverChildProvider } from "@/components/ui/DockPopoverChildContext";

interface DockedTabGroupProps {
  group: TabGroup;
  panels: PtyPanelData[];
}

export function DockedTabGroup({ group, panels }: DockedTabGroupProps) {
  const activeDockTerminalId = usePanelStore((s) => s.activeDockTerminalId);
  const openDockTerminal = usePanelStore((s) => s.openDockTerminal);
  const closeDockTerminal = usePanelStore((s) => s.closeDockTerminal);
  const moveTerminalToGrid = usePanelStore((s) => s.moveTerminalToGrid);
  const backendStatus = usePanelStore((s) => s.backendStatus);
  const setActiveTab = usePanelStore((s) => s.setActiveTab);
  const setFocused = usePanelStore((s) => s.setFocused);
  const trashPanel = usePanelStore((s) => s.trashPanel);
  const updateTitle = usePanelStore((s) => s.updateTitle);
  const hybridInputEnabled = useTerminalInputStore((s) => s.hybridInputEnabled);
  const preferredTerminalFocusTarget = usePanelStore((s) => s.preferredTerminalFocusTarget);
  const reorderPanelsInGroup = usePanelStore((s) => s.reorderPanelsInGroup);
  const addPanel = usePanelStore((s) => s.addPanel);
  const addPanelToGroup = usePanelStore((s) => s.addPanelToGroup);

  // Subscribe to registry's active tab for this group
  const storedActiveTabId = usePanelStore(
    (state) => state.tabGroups.get(group.id)?.activeTabId ?? null
  );

  // Reconcile active tab
  const activeTabId = useMemo(() => {
    if (storedActiveTabId && panels.some((p) => p.id === storedActiveTabId)) {
      return storedActiveTabId;
    }
    return panels[0]?.id ?? "";
  }, [storedActiveTabId, panels]);

  // Get active panel
  const activePanel = useMemo(() => {
    return panels.find((p) => p.id === activeTabId) ?? panels[0];
  }, [panels, activeTabId]);

  // Derive isOpen from store state - open if ANY panel in this group is active
  const isOpen = panels.some((p) => p.id === activeDockTerminalId);

  const [tabListEl, setTabListEl] = useState<HTMLDivElement | null>(null);

  // Mirrors DockedTerminalItem: only the worktree-sidebar-hidden state
  // changes left-side popover collision padding. Right padding is handled by
  // PopoverContent's collisionBoundary (width: 100vw − --right-obstruction-offset),
  // so the assistant/portal exclusion is not re-counted here.
  const sidebarHidden = useFocusStore((s) => s.gestureSidebarHidden);

  const collisionPadding = useMemo(() => {
    const basePadding = 32;
    return {
      top: basePadding,
      left: sidebarHidden ? 8 : basePadding,
      bottom: basePadding,
      right: basePadding,
    };
  }, [sidebarHidden]);

  const portalTarget = useDockPanelPortal();
  const portalContainerElementRef = useRef<HTMLDivElement | null>(null);
  const [portalContainer, setPortalContainer] = useState<HTMLDivElement | null>(null);

  const portalContainerRef = useCallback((node: HTMLDivElement | null) => {
    portalContainerElementRef.current = node;
    setPortalContainer(node);
  }, []);

  // True once the active panel's terminal host has migrated into the popover
  // portal. Keyed to the active panel id and matched by `data-dock-panel-id`
  // (not a bare child count) so a tab switch — which swaps the portal child
  // rather than adding one — re-detects the new panel before focusing it.
  const [migrated, setMigrated] = useState(false);

  useEffect(() => {
    const activeId = activePanel?.id;
    if (!isOpen || !portalContainer || !activeId) {
      setMigrated(false);
      return;
    }
    const isPresent = () =>
      Array.from(portalContainer.querySelectorAll("[data-dock-panel-id]")).some(
        (el) => el.getAttribute("data-dock-panel-id") === activeId
      );
    if (isPresent()) {
      setMigrated(true);
      return;
    }
    setMigrated(false);
    const observer = new MutationObserver(() => {
      if (isPresent()) {
        setMigrated(true);
        observer.disconnect();
      }
    });
    observer.observe(portalContainer, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [isOpen, portalContainer, activePanel?.id]);

  // Toggle buffering based on popover open state. The terminal stays mounted
  // in DockPanelOffscreenContainer across open/close cycles; the popover only
  // shuttles the host element into a visible container. One layout pass after
  // the portal-target ref settles is enough for `checkVisibility()` inside
  // `fit()` to flip — no retry loop needed.
  useEffect(() => {
    if (!activePanel) return;
    const activeId = activePanel.id;

    if (!isOpen) {
      try {
        terminalInstanceService.applyRendererPolicy(activeId, TerminalRefreshTier.BACKGROUND);
      } catch (error) {
        console.warn(`Failed to apply dock state for panel ${activeId}:`, error);
      }
      return;
    }

    if (!portalContainer) return;

    const rafId = requestAnimationFrame(() => {
      try {
        const dims = terminalInstanceService.fit(activeId);
        if (!dims) return;
        terminalInstanceService.applyRendererPolicy(activeId, TerminalRefreshTier.VISIBLE);
      } catch (error) {
        console.warn(`Failed to apply dock state for panel ${activeId}:`, error);
      }
    });

    return () => {
      cancelAnimationFrame(rafId);
    };
  }, [isOpen, portalContainer, activePanel]);

  // Auto-close popover when drag starts for any panel in this group
  useDndMonitor({
    onDragStart: ({ active }) => {
      if (panels.some((p) => p.id === active.id) && isOpen) {
        closeDockTerminal();
      }
    },
  });

  // Register/unregister portal target for active panel
  useEffect(() => {
    if (isOpen && portalContainer && activePanel) {
      portalTarget(activePanel.id, portalContainer);
    } else if (activePanel) {
      portalTarget(activePanel.id, null);
    }

    return () => {
      if (activePanel) {
        portalTarget(activePanel.id, null);
      }
    };
  }, [isOpen, portalContainer, activePanel, portalTarget]);

  // Focus the active panel's terminal once it has migrated into the popover
  // portal — never the offscreen host. Honors focus-preserve / hybrid-input.
  // Scalar deps (id / focusPolicy / isAgent value), not the activePanel object —
  // so agent-state polling that mints a new panel object doesn't re-fire focus
  // and yank it back into the terminal while the popover is open.
  const activePanelId = activePanel?.id;
  const activeFocusPolicy = activePanel?.focusPolicy;
  const activeIsAgent = activePanel ? deriveTerminalChrome(activePanel).isAgent : false;

  useEffect(() => {
    if (!isOpen || !migrated || !activePanelId) return;
    if (activeFocusPolicy === "preserve") return;

    const focusTarget = getTerminalFocusTarget({
      preferredTarget: preferredTerminalFocusTarget,
      hasHybridInputSurface: activeIsAgent,
      isInputDisabled: backendStatus === "disconnected" || backendStatus === "recovering",
      hybridInputEnabled,
    });
    if (focusTarget === "hybridInput") return;

    terminalInstanceService.focus(activePanelId);
  }, [
    isOpen,
    migrated,
    activePanelId,
    activeFocusPolicy,
    activeIsAgent,
    preferredTerminalFocusTarget,
    backendStatus,
    hybridInputEnabled,
  ]);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        openDockTerminal(activeTabId);
      } else {
        // Focus-driven dismissals are blocked upstream by onFocusOutside, so a
        // close here is a genuine pointer-outside or Escape and is honored.
        closeDockTerminal();
      }
    },
    [activeTabId, openDockTerminal, closeDockTerminal]
  );

  const handleTabClick = useCallback(
    (tabId: string) => {
      setActiveTab(group.id, tabId);
      setFocused(tabId);
      openDockTerminal(tabId);
    },
    [group.id, setActiveTab, setFocused, openDockTerminal]
  );

  const handleTabClose = useCallback(
    (tabId: string) => {
      if (tabId === activeTabId) {
        const currentIndex = panels.findIndex((p) => p.id === tabId);
        const nextPanel = panels[currentIndex + 1] ?? panels[currentIndex - 1];
        if (nextPanel) {
          setActiveTab(group.id, nextPanel.id);
          setFocused(nextPanel.id);
        }
      }
      trashPanel(tabId);
    },
    [activeTabId, panels, group.id, setActiveTab, setFocused, trashPanel]
  );

  // Sensors for tab drag-and-drop (require small distance to differentiate from clicks)
  const tabSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 150, tolerance: 5 },
    })
  );

  // Tab IDs for sortable context
  const tabIds = useMemo(() => panels.map((p) => p.id), [panels]);

  const hiddenTabIds = useTabOverflow(tabListEl, tabIds);
  const hiddenPanels = useMemo(
    () => panels.filter((p) => hiddenTabIds.has(p.id)),
    [panels, hiddenTabIds]
  );
  const activeTabIsHidden = activeTabId !== "" && hiddenTabIds.has(activeTabId);

  // Handle tab reorder drag end
  const handleTabDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const oldIndex = panels.findIndex((p) => p.id === active.id);
      const newIndex = panels.findIndex((p) => p.id === over.id);

      if (oldIndex !== -1 && newIndex !== -1 && oldIndex !== newIndex) {
        const newOrder = arrayMove(
          panels.map((p) => p.id),
          oldIndex,
          newIndex
        );
        reorderPanelsInGroup(group.id, newOrder);
      }
    },
    [panels, group.id, reorderPanelsInGroup]
  );

  // Surface-specific ARIA announcements for the dock tab strip. Without this
  // dnd-kit reads the generic English defaults ("Picked up draggable item"),
  // which obscures which tab the user grabbed when multiple groups are docked.
  const getPanelTabLabel = useCallback(
    (id: UniqueIdentifier) => {
      const panel = panels.find((p) => p.id === id);
      return panel ? getBaseTitle(panel.title) : null;
    },
    [panels]
  );
  const tabAnnouncements = useMemo(
    () => makeSortableAnnouncements(getPanelTabLabel, "panel tab"),
    [getPanelTabLabel]
  );

  // Restrict dnd-kit's autoscroller to the horizontal tab strip itself. The
  // DndContext lives inside a Radix Popover portaled to document.body, so its
  // scrollable-ancestor walk would otherwise reach `body`/`html` and scroll
  // the page when the user drags a tab near the popover edge.
  const tabAutoScroll = useMemo(
    () => ({ canScroll: (el: Element) => el === tabListEl }),
    [tabListEl]
  );

  const handleTabRename = useCallback(
    (tabId: string, newTitle: string) => {
      updateTitle(tabId, newTitle);
    },
    [updateTitle]
  );

  // APG manual activation: arrow keys move focus only; Space/Enter activates.
  // Activation triggers PTY refit + buffering-state work, so following
  // automatic-activation would re-run that on every arrow press while skimming.
  // Space/Enter activation is handled by `TabButton.handleKeyDown` on each tab
  // (it calls `onClick` which routes to `handleTabClick`), so we intentionally
  // do not handle those keys here — doing so would double-activate.
  const handleTabListKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (panels.length < 2) return;

      // Anchor arrow movement to the currently focused tab when one is
      // focused (so successive arrows roam without activating), else to the
      // active tab (first arrow after entering the tablist via Tab).
      //
      // The `+` (duplicate) button lives inside the tablist container but is
      // not itself a tab. If focus is on a non-tab element in the tablist
      // (i.e. the `+` button), bail out so arrows don't yank focus back into
      // the tab strip from the user's current position.
      const focused = document.activeElement as HTMLElement | null;
      const focusedTabId = focused?.getAttribute("data-tab-id");
      if (!focusedTabId && focused && tabListEl?.contains(focused)) {
        return;
      }
      const anchorId = focusedTabId ?? activeTabId;
      const currentIndex = panels.findIndex((p) => p.id === anchorId);
      let nextIndex: number | undefined;

      switch (e.key) {
        case "ArrowLeft":
          nextIndex = currentIndex > 0 ? currentIndex - 1 : panels.length - 1;
          break;
        case "ArrowRight":
          nextIndex = currentIndex < panels.length - 1 ? currentIndex + 1 : 0;
          break;
        case "Home":
          nextIndex = 0;
          break;
        case "End":
          nextIndex = panels.length - 1;
          break;
        default:
          return;
      }

      e.preventDefault();
      const nextPanel = panels[nextIndex];
      if (nextPanel && tabListEl) {
        // Iterate rather than build a `[data-tab-id="${id}"]` selector so we
        // don't need to escape panel IDs containing quotes or other CSS-special
        // characters (and so the lookup works in jsdom, which lacks CSS.escape).
        const tabs = tabListEl.querySelectorAll<HTMLElement>("[data-tab-id]");
        for (const el of tabs) {
          if (el.getAttribute("data-tab-id") === nextPanel.id) {
            el.focus();
            break;
          }
        }
      }
    },
    [panels, activeTabId, tabListEl]
  );

  // Handle add tab - duplicate the current panel as a new tab
  const handleAddTab = useCallback(async () => {
    if (!activePanel) return;

    try {
      const options = await buildPanelDuplicateOptions(activePanel, "dock");
      // `activateDockOnCreate` folds dock activation into the panel commit so
      // the watchdog effect cannot collapse the just-created tab. See #6590.
      const newPanelId = await addPanel({ ...options, activateDockOnCreate: true });
      if (!newPanelId) return;

      addPanelToGroup(group.id, newPanelId);
      setActiveTab(group.id, newPanelId);
    } catch (error) {
      logError("Failed to add tab", error);
    }
  }, [activePanel, group.id, addPanel, addPanelToGroup, setActiveTab]);

  const groupBlockedState = getGroupBlockedAgentState(panels);
  const blockedState = useDockBlockedState(groupBlockedState);
  const isDeprioritized = !isOpen && isGroupDeprioritized(panels);
  const showDockAgentHighlights = usePreferencesStore((s) => s.showDockAgentHighlights);

  const agentSettingsAll = useAgentSettingsStore((s) => s.settings);
  const ccrPresetsByAgent = useCcrPresetsStore((s) => s.ccrPresetsByAgent);
  const projectPresetsByAgent = useProjectPresetsStore((s) => s.presetsByAgent);

  // Per-panel preset colors for tab bar
  const panelPresetColors = useMemo(() => {
    return new Map(
      panels.map((p) => {
        const fallbackColor = deriveTerminalChrome(p).color;
        if (!p.agentPresetId || !p.launchAgentId) return [p.id, fallbackColor] as const;
        const presets = getMergedPresets(
          p.launchAgentId,
          agentSettingsAll?.agents?.[p.launchAgentId]?.customPresets,
          ccrPresetsByAgent[p.launchAgentId],
          projectPresetsByAgent[p.launchAgentId]
        );
        const preset = presets.find((f) => f.id === p.agentPresetId);
        return [p.id, preset?.color ?? p.agentPresetColor ?? fallbackColor] as const;
      })
    );
  }, [panels, agentSettingsAll, ccrPresetsByAgent, projectPresetsByAgent]);

  if (!activePanel || panels.length === 0) {
    return null;
  }

  const performanceMode = document.body.dataset.performanceMode === "true";

  const brandColor =
    panelPresetColors.get(activePanel.id) ?? deriveTerminalChrome(activePanel).color;
  const activeChrome = deriveTerminalChrome({
    kind: activePanel.kind,
    launchAgentId: activePanel.launchAgentId,
    runtimeIdentity: activePanel.runtimeIdentity,
    detectedAgentId: activePanel.detectedAgentId,
    detectedProcessId: activePanel.detectedProcessId,
    agentState: activePanel.agentState,
    runtimeStatus: activePanel.runtimeStatus,
    exitCode: activePanel.exitCode,
    presetColor: brandColor,
  });
  const agentState = getDockDisplayAgentState(activePanel);
  const isWorking = agentState === "working";
  const isWaiting = agentState === "waiting";
  const isActive = isWorking || isWaiting;
  const commandText = activePanel.activityHeadline || activePanel.lastCommand;
  const displayTitle = getBaseTitle(activePanel.title);
  const displayAgentState = getTerminalAgentDisplayState(activeChrome, agentState);
  const StateIcon = displayAgentState ? getEffectiveStateIcon(displayAgentState) : null;

  return (
    <DockPopoverChildProvider>
      <Popover open={isOpen} onOpenChange={handleOpenChange}>
        <TerminalContextMenu terminalId={activePanel.id} forceLocation="dock">
          <PopoverTrigger asChild>
            <button
              data-dock-item=""
              className={cn(
                "flex items-center gap-1.5 px-3 h-[var(--dock-item-height)] rounded-[var(--radius-md)] text-xs border transition duration-150 max-w-[280px]",
                "bg-[var(--dock-item-bg)] border-[var(--dock-item-border)] text-daintree-text/70",
                "hover:text-daintree-text hover:bg-[var(--dock-item-bg-hover)]",
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-[-2px]",
                "cursor-grab active:cursor-grabbing",
                isOpen &&
                  "bg-[var(--dock-item-bg-active)] text-daintree-text border-[var(--dock-item-border-active)] ring-1 ring-inset ring-daintree-accent/30",
                !isOpen &&
                  showDockAgentHighlights &&
                  blockedState === "waiting" &&
                  "bg-[var(--dock-item-bg-waiting)] border-[var(--dock-item-border-waiting)]",
                isDeprioritized && "text-daintree-text/40 border-[var(--dock-item-border)]/50"
              )}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (e.detail >= 2) return;
                if (isOpen) {
                  closeDockTerminal();
                } else {
                  openDockTerminal(activeTabId);
                }
              }}
              onDoubleClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                const moved = moveTerminalToGrid(activePanel.id);
                if (moved) closeDockTerminal();
              }}
              aria-label={`${activePanel.title}${displayAgentState ? ` — agent ${getEffectiveStateLabel(displayAgentState)}` : ""} (${panels.length} tabs) - Click to preview, double-click to move to grid, drag to reorder`}
            >
              <div className="flex items-center justify-center shrink-0">
                <TerminalIcon
                  kind={activePanel.kind}
                  chrome={activeChrome}
                  className="w-3.5 h-3.5"
                />
              </div>
              <span className="truncate min-w-[48px] max-w-[140px] font-sans font-medium">
                {displayTitle}
              </span>

              {/* Tab count indicator */}
              <span className="text-[10px] text-daintree-text/40 tabular-nums shrink-0">
                ({panels.length})
              </span>

              {isActive && commandText && (
                <>
                  <div className="h-3 w-px bg-border-subtle shrink-0" aria-hidden="true" />
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="truncate flex-1 min-w-0 text-[11px] text-daintree-text/50 font-mono">
                        {commandText}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">{commandText}</TooltipContent>
                  </Tooltip>
                </>
              )}

              {displayAgentState && StateIcon && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div
                      className={cn(
                        "ml-1.5 flex items-center shrink-0",
                        getEffectiveStateColor(displayAgentState)
                      )}
                    >
                      <StateIcon
                        className={cn(
                          "w-3.5 h-3.5",
                          displayAgentState === "working" && "animate-spin-slow",
                          "motion-reduce:animate-none"
                        )}
                        aria-hidden="true"
                      />
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">{`Agent ${displayAgentState}`}</TooltipContent>
                </Tooltip>
              )}
            </button>
          </PopoverTrigger>
        </TerminalContextMenu>

        <PopoverContent
          className="w-[700px] max-w-[90vw] h-[500px] max-h-[80vh] p-0 bg-daintree-bg/95 backdrop-blur-sm border border-[var(--border-dock-popup)] shadow-[var(--shadow-dock-panel-popover)] rounded-[var(--radius-lg)] overflow-hidden"
          side="top"
          align="start"
          sideOffset={10}
          collisionPadding={collisionPadding}
          onInteractOutside={(e) => handleDockInteractOutside(e, portalContainerElementRef.current)}
          onEscapeKeyDown={(e) => handleDockEscapeKeyDown(e, portalContainerElementRef.current)}
          onFocusOutside={handleDockFocusOutside}
          onOpenAutoFocus={(event) => {
            // Block Radix's own auto-focus; we focus the terminal once it has
            // migrated into the portal (see the migration-focus effect), not on
            // a fixed timer that races a cold xterm mount.
            event.preventDefault();
          }}
        >
          {/* Tab bar at top of popover */}
          <DndContext
            sensors={tabSensors}
            collisionDetection={closestCenter}
            onDragEnd={handleTabDragEnd}
            modifiers={[restrictToHorizontalAxis, restrictToParentElement]}
            autoScroll={tabAutoScroll}
            accessibility={{ announcements: tabAnnouncements }}
          >
            <SortableContext items={tabIds} strategy={horizontalListSortingStrategy}>
              <LayoutGroup id={`dock-tabs-${group.id}`}>
                <div className="group flex items-stretch border-b border-divider bg-daintree-sidebar shrink-0">
                  <div
                    ref={setTabListEl}
                    className="flex items-center min-w-0 flex-1 overflow-x-auto overscroll-x-none scrollbar-none"
                    role="tablist"
                    aria-label="Dock panel tabs"
                    onKeyDown={handleTabListKeyDown}
                  >
                    {performanceMode ? (
                      panels.map((panel) => {
                        const tabChrome = deriveTerminalChrome({
                          kind: panel.kind,
                          launchAgentId: panel.launchAgentId,
                          runtimeIdentity: panel.runtimeIdentity,
                          detectedAgentId: panel.detectedAgentId,
                          detectedProcessId: panel.detectedProcessId,
                          agentState: panel.agentState,
                          runtimeStatus: panel.runtimeStatus,
                          exitCode: panel.exitCode,
                          presetColor: panelPresetColors.get(panel.id),
                        });
                        return (
                          <SortableTabButton
                            key={panel.id}
                            id={panel.id}
                            title={getBaseTitle(panel.title)}
                            chrome={tabChrome}
                            kind={panel.kind ?? "terminal"}
                            agentState={getDockDisplayAgentState(panel)}
                            isActive={panel.id === activeTabId}
                            presetColor={panelPresetColors.get(panel.id)}
                            isUsingFallback={panel.isUsingFallback}
                            onClick={() => handleTabClick(panel.id)}
                            onClose={() => handleTabClose(panel.id)}
                            onRename={(newTitle) => handleTabRename(panel.id, newTitle)}
                          />
                        );
                      })
                    ) : (
                      <AnimatePresence initial={false} mode="popLayout">
                        {panels.map((panel) => {
                          const tabChrome = deriveTerminalChrome({
                            kind: panel.kind,
                            launchAgentId: panel.launchAgentId,
                            runtimeIdentity: panel.runtimeIdentity,
                            detectedAgentId: panel.detectedAgentId,
                            detectedProcessId: panel.detectedProcessId,
                            agentState: panel.agentState,
                            runtimeStatus: panel.runtimeStatus,
                            exitCode: panel.exitCode,
                            presetColor: panelPresetColors.get(panel.id),
                          });
                          return (
                            <m.div
                              key={panel.id}
                              layout="position"
                              transition={{
                                duration: UI_ANIMATION_DURATION / 1000,
                                ease: EASE_OUT_EXPO_FM,
                              }}
                            >
                              <SortableTabButton
                                id={panel.id}
                                title={getBaseTitle(panel.title)}
                                chrome={tabChrome}
                                kind={panel.kind ?? "terminal"}
                                agentState={getDockDisplayAgentState(panel)}
                                isActive={panel.id === activeTabId}
                                presetColor={panelPresetColors.get(panel.id)}
                                isUsingFallback={panel.isUsingFallback}
                                onClick={() => handleTabClick(panel.id)}
                                onClose={() => handleTabClose(panel.id)}
                                onRename={(newTitle) => handleTabRename(panel.id, newTitle)}
                              />
                            </m.div>
                          );
                        })}
                      </AnimatePresence>
                    )}
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleAddTab();
                          }}
                          onPointerDown={(e) => e.stopPropagation()}
                          className="shrink-0 p-1.5 hover:bg-daintree-text/10 text-daintree-text/40 hover:text-daintree-text transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-1"
                          aria-label="Duplicate panel as new tab"
                          type="button"
                        >
                          <CopyPlus className="w-3 h-3" aria-hidden="true" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">Duplicate panel as new tab</TooltipContent>
                    </Tooltip>
                  </div>
                  {hiddenPanels.length > 0 && (
                    <DropdownMenu>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <DropdownMenuTrigger asChild>
                            <button
                              type="button"
                              onPointerDown={(e) => e.stopPropagation()}
                              className="relative shrink-0 p-1.5 hover:bg-daintree-text/10 text-daintree-text/40 hover:text-daintree-text transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-1"
                              aria-label={
                                activeTabIsHidden
                                  ? `Show ${hiddenPanels.length} hidden tabs, including active`
                                  : `Show ${hiddenPanels.length} hidden tabs`
                              }
                              aria-haspopup="menu"
                              data-testid="dock-tabs-overflow"
                            >
                              <ChevronDown className="w-3 h-3" aria-hidden="true" />
                              {activeTabIsHidden && (
                                <span
                                  className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-daintree-text/70"
                                  aria-hidden="true"
                                />
                              )}
                            </button>
                          </DropdownMenuTrigger>
                        </TooltipTrigger>
                        <TooltipContent side="bottom">Show hidden tabs</TooltipContent>
                      </Tooltip>
                      <DropdownMenuContent
                        align="end"
                        className="min-w-[200px] max-w-[320px] max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto"
                      >
                        {hiddenPanels.map((panel) => {
                          const tabChrome = deriveTerminalChrome({
                            kind: panel.kind,
                            launchAgentId: panel.launchAgentId,
                            runtimeIdentity: panel.runtimeIdentity,
                            detectedAgentId: panel.detectedAgentId,
                            detectedProcessId: panel.detectedProcessId,
                            agentState: panel.agentState,
                            runtimeStatus: panel.runtimeStatus,
                            exitCode: panel.exitCode,
                            presetColor: panelPresetColors.get(panel.id),
                          });
                          const isActive = panel.id === activeTabId;
                          return (
                            <DropdownMenuItem
                              key={panel.id}
                              onSelect={() => handleTabClick(panel.id)}
                              aria-current={isActive ? "true" : undefined}
                              className={cn(
                                isActive &&
                                  "font-medium before:absolute before:left-0 before:top-2 before:bottom-2 before:w-[2px] before:rounded-r before:bg-daintree-accent before:content-['']"
                              )}
                            >
                              <span className="shrink-0 mr-2 inline-flex items-center justify-center w-3.5 h-3.5">
                                <TerminalIcon
                                  kind={panel.kind ?? "terminal"}
                                  chrome={tabChrome}
                                  className="w-3.5 h-3.5"
                                />
                              </span>
                              <span className="truncate">{getBaseTitle(panel.title)}</span>
                            </DropdownMenuItem>
                          );
                        })}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>
              </LayoutGroup>
            </SortableContext>
          </DndContext>

          {/* Portal target - content is rendered in DockPanelOffscreenContainer and portaled here */}
          <div
            ref={portalContainerRef}
            className="flex-1 min-h-0 flex flex-col"
            data-dock-portal-target={activePanel.id}
          />
        </PopoverContent>
      </Popover>
    </DockPopoverChildProvider>
  );
}
