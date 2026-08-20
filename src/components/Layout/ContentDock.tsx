import { useMemo, useRef, useCallback, useLayoutEffect, useSyncExternalStore } from "react";

import { useShallow } from "zustand/react/shallow";
import { SortableContext, horizontalListSortingStrategy } from "@dnd-kit/sortable";
import { useDndContext, useDroppable } from "@dnd-kit/core";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { usePanelStore, useWorktreeSelectionStore } from "@/store";
import {
  isBrowserPanel,
  isDockPanel,
  isFilePanel,
  isPtyPanel,
  type BrowserPanelData,
  type DockPanelData,
  type FilePanelData,
  type PanelInstance,
} from "@shared/types/panel";
import { extractHostPort } from "@/components/Browser/browserUtils";
import { getRenderablePanel } from "@/store/slices/panelRegistry/selectors";
import {
  collectUngroupedCandidateIds,
  panelMatchesWorktreeScope,
} from "@/store/slices/panelRegistry/worktreeIndex";
import type { TrashedTerminal } from "@/store/slices";
import { DockedTerminalItem } from "./DockedTerminalItem";
import { DockedNonPtyPanelItem } from "./DockedNonPtyPanelItem";
import { DockedTabGroup } from "./DockedTabGroup";
import { TrashContainer } from "./TrashContainer";
import { WaitingContainer } from "./WaitingContainer";
import { ErrorsContainer } from "./ErrorsContainer";
import { BackgroundContainer } from "./BackgroundContainer";
import { DockLaunchButton } from "./DockLaunchButton";
import { useLauncherData } from "./useLauncherData";
import { DockLaunchMenuItems, type DockLaunchMenuComponents } from "./DockLaunchMenuItems";
import {
  SortableDockItem,
  SortableDockPlaceholder,
  DOCK_PLACEHOLDER_ID,
  useIsWorktreeSortDragging,
  useDndPlaceholder,
} from "@/components/DragDrop";
import {
  subscribeToPanelKindRegistry,
  getPanelKindRegistrySnapshot,
} from "@shared/config/panelKindRegistry";
import { useHorizontalScrollControls } from "@/hooks";
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
  // Ultimate fallback so the chip is never blank (e.g. empty title + no URL).
  return host || panel.title || "Browser";
}

// Chip label for a non-PTY dock panel. File and browser get their kind-specific
// derivations; every other dockable kind (dev-preview if opted in, plugin view
// panels — #11332) falls back to the panel title so the chip is never blank.
function dockChipTitle(panel: PanelInstance): string {
  if (isFilePanel(panel)) return fileChipTitle(panel);
  if (isBrowserPanel(panel)) return browserChipTitle(panel);
  return panel.title;
}

export function ContentDock({ density = "normal" }: ContentDockProps) {
  // Subscribe to panel-kind metadata changes (#11375). The dock-membership
  // selectors below call `isDockPanel` (→ `panelKindIsDockable`), which reads
  // the registry, not the panel store — so a `dockable`-only flip or a plugin
  // unregister wouldn't re-run them on its own. This subscription forces a
  // re-render on any registry change, and the re-render re-evaluates the Zustand
  // selectors against the fresh registry. Return value intentionally unused —
  // mirrors `GridPanel`/`DockedPanel`'s definition-registry subscription.
  useSyncExternalStore(
    subscribeToPanelKindRegistry,
    getPanelKindRegistrySnapshot,
    getPanelKindRegistrySnapshot
  );

  const activeWorktreeId = useWorktreeSelectionStore((state) => state.activeWorktreeId);

  const trashedTerminals = usePanelStore((state) => state.trashedTerminals);
  const storeTabGroups = usePanelStore((state) => state.tabGroups);
  const helpTerminalId = useHelpPanelStore((s) => s.terminalId);
  const setDockDensity = usePreferencesStore((s) => s.setDockDensity);

  // Narrow dock subscription (#10908). Subscribing to the whole `panelsById`
  // re-rendered the dock on every panel's rAF status-buffer flush — including
  // grid agents that never appear here. This selector reacts only to dock
  // panels. Membership is `isDockPanel` — every registered kind that hasn't
  // opted out with `dockable: false`, PTY and non-PTY alike, including plugin
  // kinds (#11332). Panels are read through `getRenderablePanel` (not
  // `getNarrowPanel`, which drops plugin kinds); the PTY chip and the generic
  // `DockedNonPtyPanelItem` chip cover every member below. This is NOT the
  // #10512 grid render-eligibility predicate, which deliberately does not
  // apply to the dock.
  //
  // The list is object-valued (the dock renders live activity/agent state from
  // it) and ordered, and it is the sole authority for chip order — so a pure
  // `reorderTerminals`, which rewrites only `panelIds`/`panelIdsByWorktreeId`,
  // repaints the rail. Order used to come from the `getTabGroups` action behind
  // a `useMemo` whose deps were read for invalidation only; React Compiler
  // drops deps a callback never consumes, so that memo held the pre-drag order
  // and every dock reorder snapped back (#11873). Everything downstream now
  // consumes its inputs for real, so the compiler keeps them in the cache key.
  //
  // Candidate ids come from `collectUngroupedCandidateIds`, the same helper
  // `getTabGroups` uses, so a panel committed mid-spawn-batch — eagerly in the
  // worktree index while `panelIds` only appends at flush — still paints on
  // first mount (#9649).
  const dockTerminalsRaw = usePanelStore(
    useShallow((state) => {
      const result: DockPanelData[] = [];
      for (const id of collectUngroupedCandidateIds(
        state.panelIds,
        state.panelIdsByWorktreeId,
        undefined
      )) {
        const terminal = getRenderablePanel(state.panelsById, id);
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

  const dockTerminals = useMemo<DockPanelData[]>(() => {
    // `dockTerminalsRaw` already narrows to dock/dockable/non-trashed panels;
    // apply the help-panel and active-worktree filters here (external stores
    // the store selector can't read).
    const result: DockPanelData[] = [];
    for (const terminal of dockTerminalsRaw) {
      if (
        terminal.id !== helpTerminalId &&
        panelMatchesWorktreeScope(terminal.worktreeId, activeWorktreeId, "dock")
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

  // Inventory, cwd and recipe variables all come from the shared launcher hook
  // now that the toolbar hosts the same component (#11691) — two copies of these
  // rules is how the two placements start offering different things.
  const {
    agents: launchAgents,
    pinnedCount,
    agentInventoryState,
    cwd,
    recipeContext,
    hasWorkspace,
    hasProject,
  } = useLauncherData();

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
      // Issue #11156 — React synthetic events bubble the React tree, so keydowns
      // from a docked panel's Radix Popover content (portaled to document.body)
      // still reach this handler. Not every input surface cancels them first:
      // xterm stops propagation for keys it handles but deliberately does not in
      // screenReaderMode, and the CodeMirror input bar preventDefaults without
      // stopping propagation. Either way an arrow typed into a docked terminal
      // would rove the rail and yank focus off the panel mid-type. Gate on DOM
      // containment — portal content is not a DOM descendant of the rail — so
      // key ownership follows the real tree. Mirrors Toolbar.tsx.
      if (!(e.target instanceof Node) || !scrollContainerRef.current?.contains(e.target)) return;

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

  // A panel whose kind the dock can't render can't drop here either (#11054).
  // `activeDragRejectsDock` is group-aware — for a group drag it reflects ANY
  // non-dockable member, not just the dragged representative (#11375) — so the
  // reject cue matches exactly what `cancelDrop`/`collisionDetection` enforce.
  const { activeDragRejectsDock } = useDndPlaceholder();
  const isDockDropRejected = isWorktreeSortDragging || activeDragRejectsDock;

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
    async (agentId: string, source: ActionSource = "menu", presetId?: string | null) => {
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
          // Spread rather than passed as `presetId: presetId`: `null` is the
          // explicit-default sentinel the launcher relies on, and `undefined`
          // must leave the key off entirely so the saved preset still resolves.
          ...(presetId !== undefined ? { presetId } : {}),
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

  // Every input is genuinely consumed, so React Compiler keeps all three in the
  // cache key — the reason chip order now tracks `panelIds` (#11873).
  const dockItems = useMemo<DockRenderItem[]>(() => {
    return buildDockRenderItems(dockTerminals, storeTabGroups, activeWorktreeId);
  }, [dockTerminals, storeTabGroups, activeWorktreeId]);

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
              agentInventoryState={agentInventoryState}
              hasWorkspace={hasWorkspace}
              hasProject={hasProject}
              onLaunchAgent={(agentId, presetId) =>
                void handleAddTerminal(agentId, "menu", presetId)
              }
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
                isDockDropRejected && "cursor-no-drop",
                isOver &&
                  !isDockDropRejected &&
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
                            ) : (
                              <DockedNonPtyPanelItem
                                panel={terminal}
                                displayTitle={dockChipTitle(terminal)}
                              />
                            )}
                          </SortableDockItem>
                        );
                      }

                      // Multi-panel group: pass group context for group-aware DnD.
                      // `buildDockRenderItems` resolves group members PTY-only,
                      // so the runtime narrow below never drops a panel.
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
          activeWorktreeId={activeWorktreeId}
          cwd={cwd}
          recipeContext={recipeContext}
          onLaunchAgent={(agentId) => void handleAddTerminal(agentId, "context-menu")}
          surface="dock"
          source="context-menu"
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
