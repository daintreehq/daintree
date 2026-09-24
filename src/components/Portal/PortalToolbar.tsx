import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  RotateCw,
  X,
  Plus,
  ExternalLink,
  Link2,
  Server,
  ChevronDown,
} from "lucide-react";
import {
  DndContext,
  closestCorners,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import { SortableContext, useSortable, horizontalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { makeSortableAnnouncements } from "@/components/DragDrop/sortableAnnouncements";
import type { PortalTab, PortalLink } from "@shared/types";
import { cn } from "@/lib/utils";
import { createTooltipContent } from "@/lib/tooltipShortcut";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { usePortalStore } from "@/store/portalStore";
import { PortalIcon } from "./PortalIcon";
import { useAriaKeyshortcuts, useKeybindingDisplay, useOverlayClaim } from "@/hooks";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

const noopTabAction = (_tabId: string) => {};

const OVERFLOW_FADE_PX = 24;

const tabDomId = (tabId: string) => `portal-tab-${tabId}`;

// Shared with the dev-preview browser toolbar so both browser chromes read as one family.
const iconButtonClass =
  "toolbar-icon-button shrink-0 p-1.5 rounded-[var(--radius-md)] text-text-secondary disabled:opacity-30 disabled:cursor-not-allowed";

function SortableTab({
  tab,
  isActive,
  onClick,
  onClose,
  onDuplicate,
  onCloseOthers,
  onCloseToRight,
  onCopyUrl,
  onOpenExternal,
  onReload,
  onMove,
  onKeyboardClose,
  tabCount,
  tabIndex,
  isTabStop,
}: {
  tab: PortalTab;
  isActive: boolean;
  isTabStop: boolean;
  onClick: (id: string) => void;
  onClose: (id: string) => void;
  onDuplicate: (id: string) => void;
  onCloseOthers: (id: string) => void;
  onCloseToRight: (id: string) => void;
  onCopyUrl: (id: string) => void;
  onOpenExternal: (id: string) => void;
  onReload: (id: string) => void;
  onMove: (id: string, delta: -1 | 1) => void;
  onKeyboardClose: (id: string) => void;
  tabCount: number;
  tabIndex: number;
}) {
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: tab.id,
    transition: {
      duration: 150,
      easing: "cubic-bezier(0.25, 1, 0.5, 1)",
    },
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 50 : "auto",
  };

  const hasUrl = !!tab.url;
  const hasTabsToRight = tabIndex < tabCount - 1;
  const hasOtherTabs = tabCount > 1;

  return (
    <ContextMenu modal={false}>
      <ContextMenuTrigger asChild disabled={isDragging}>
        <div
          ref={setNodeRef}
          style={style}
          {...listeners}
          id={tabDomId(tab.id)}
          role="tab"
          aria-selected={isActive}
          aria-label={tab.title}
          tabIndex={isTabStop ? 0 : -1}
          onClick={() => onClick(tab.id)}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget) return;
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onClick(tab.id);
            } else if (e.key === "Delete" || e.key === "Backspace") {
              e.preventDefault();
              onKeyboardClose(tab.id);
            }
          }}
          className={cn(
            "group relative flex shrink-0 items-center gap-1.5 h-8 pl-2.5 pr-1 text-xs cursor-pointer select-none",
            "rounded-[var(--radius-md)] border transition-colors duration-150",
            "min-w-[88px] max-w-[180px]",
            "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:-outline-offset-2",
            isActive
              ? "bg-overlay-emphasis text-text-primary border-border-strong after:absolute after:inset-x-2.5 after:-bottom-px after:h-0.5 after:rounded-full after:bg-text-primary"
              : "text-text-secondary border-transparent hover:bg-overlay-soft hover:text-text-primary",
            isDragging && "opacity-80 shadow-[var(--theme-shadow-floating)] cursor-grabbing"
          )}
        >
          <span className="flex w-3.5 h-3.5 shrink-0 items-center justify-center">
            <PortalIcon icon={tab.icon ?? "globe"} size="tab" />
          </span>
          <span className="min-w-0 flex-1 truncate">{tab.title}</span>
          <button
            type="button"
            tabIndex={-1}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onClose(tab.id);
            }}
            aria-label={`Close ${tab.title}`}
            className={cn(
              "flex w-6 h-6 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-text-secondary transition-colors duration-150",
              "hover:text-text-primary hover:bg-overlay-medium",
              !isActive && "opacity-0 group-hover:opacity-100"
            )}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem disabled={!hasUrl} onSelect={() => onDuplicate(tab.id)}>
          Duplicate
        </ContextMenuItem>
        <ContextMenuItem disabled={!hasUrl} onSelect={() => onReload(tab.id)}>
          Reload
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={!hasUrl} onSelect={() => onCopyUrl(tab.id)}>
          Copy URL
        </ContextMenuItem>
        <ContextMenuItem disabled={!hasUrl} onSelect={() => onOpenExternal(tab.id)}>
          Open in browser
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={tabIndex === 0} onSelect={() => onMove(tab.id, -1)}>
          Move left
        </ContextMenuItem>
        <ContextMenuItem disabled={!hasTabsToRight} onSelect={() => onMove(tab.id, 1)}>
          Move right
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => onClose(tab.id)}>Close</ContextMenuItem>
        <ContextMenuItem disabled={!hasOtherTabs} onSelect={() => onCloseOthers(tab.id)}>
          Close others
        </ContextMenuItem>
        <ContextMenuItem disabled={!hasTabsToRight} onSelect={() => onCloseToRight(tab.id)}>
          Close tabs to the right
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

interface PortalToolbarProps {
  tabs: PortalTab[];
  activeTabId: string | null;
  onTabClick: (tabId: string) => void;
  onTabClose: (tabId: string) => void;
  onNewTab: () => void;
  defaultNewTabUrl: string | null;
  onClose: () => void;
  onGoBack?: () => void;
  onGoForward?: () => void;
  onReload?: () => void;
  onOpenExternal?: () => void;
  onCopyUrl?: () => void;
  hasActiveUrl?: boolean;
  onDuplicateTab?: (tabId: string) => void;
  onCloseOthers?: (tabId: string) => void;
  onCloseToRight?: (tabId: string) => void;
  onCopyTabUrl?: (tabId: string) => void;
  onOpenTabExternal?: (tabId: string) => void;
  onReloadTab?: (tabId: string) => void;
  enabledLinks: PortalLink[];
}

export function PortalToolbar({
  tabs,
  activeTabId,
  onTabClick,
  onTabClose,
  onNewTab,
  defaultNewTabUrl,
  onClose,
  onGoBack,
  onGoForward,
  onReload,
  onOpenExternal,
  onCopyUrl,
  hasActiveUrl = false,
  onDuplicateTab,
  onCloseOthers,
  onCloseToRight,
  onCopyTabUrl,
  onOpenTabExternal,
  onReloadTab,
  enabledLinks,
}: PortalToolbarProps) {
  const reorderTabs = usePortalStore((s) => s.reorderTabs);
  const showDevDashboard = usePortalStore((s) => s.showDevDashboard);
  const toggleDevDashboard = usePortalStore((s) => s.toggleDevDashboard);
  const closePortalShortcut = useKeybindingDisplay("panel.togglePortal");
  const newTabShortcut = useKeybindingDisplay("portal.newTab");
  const closePortalAriaShortcut = useAriaKeyshortcuts("panel.togglePortal");
  const newTabAriaShortcut = useAriaKeyshortcuts("portal.newTab");

  const duplicateTab = onDuplicateTab ?? noopTabAction;
  const closeOthers = onCloseOthers ?? noopTabAction;
  const closeToRight = onCloseToRight ?? noopTabAction;
  const copyTabUrl = onCopyTabUrl ?? noopTabAction;
  const openTabExternal = onOpenTabExternal ?? noopTabAction;
  const reloadTab = onReloadTab ?? noopTabAction;

  // Pointer-only drag: Space and Enter belong to tab activation, so keyboard
  // reordering goes through the tab's Move left / Move right menu items.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const moveTab = (tabId: string, delta: -1 | 1) => {
    const from = tabs.findIndex((t) => t.id === tabId);
    const to = from + delta;
    if (from === -1 || to < 0 || to >= tabs.length) return;
    reorderTabs(from, to);
  };

  // Deleting the focused tab hands focus to its neighbour — the following tab,
  // else the preceding one — or, with no tabs left, to the launchpad.
  const closeFromKeyboard = (tabId: string) => {
    const index = tabs.findIndex((t) => t.id === tabId);
    const next = tabs[index + 1] ?? tabs[index - 1];
    onTabClose(tabId);
    requestAnimationFrame(() => {
      const target = next
        ? document.getElementById(tabDomId(next.id))
        : document.querySelector<HTMLElement>("#portal-placeholder button");
      target?.focus();
    });
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const oldIndex = tabs.findIndex((t) => t.id === active.id);
      const newIndex = tabs.findIndex((t) => t.id === over.id);
      reorderTabs(oldIndex, newIndex);
    }
  };

  const getBrowserTabLabel = useCallback(
    (id: UniqueIdentifier) => tabs.find((t) => t.id === id)?.title,
    [tabs]
  );
  const browserTabAnnouncements = useMemo(() => {
    const base = makeSortableAnnouncements(getBrowserTabLabel, "browser tab");
    // Drag is pointer-only here, so pickup mustn't promise arrow-key moves.
    return {
      ...base,
      onDragStart: (event: Parameters<typeof base.onDragStart>[0]) => {
        base.onDragStart(event);
        return `Picked up ${getBrowserTabLabel(event.active.id) ?? "tab"}.`;
      },
    };
  }, [getBrowserTabLabel]);

  const tablistRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState({ before: false, after: false });
  const isOverflowing = overflow.before || overflow.after;

  const measureOverflow = useCallback(() => {
    const el = tablistRef.current;
    if (!el) return;
    const before = el.scrollLeft > 1;
    const after = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setOverflow((prev) =>
      prev.before === before && prev.after === after ? prev : { before, after }
    );
  }, []);

  // Set when the user scrolls the strip themselves, so a later resize or title
  // update doesn't yank it back to the active tab. Cleared on each selection.
  const userScrolledRef = useRef(false);
  const programmaticScrollRef = useRef(false);

  // Keep the active tab clear of the overflow fade, not just inside the strip.
  const revealActive = useCallback(() => {
    const strip = tablistRef.current;
    const tab = activeTabId ? document.getElementById(tabDomId(activeTabId)) : null;
    if (strip && tab) {
      const left = tab.offsetLeft - strip.offsetLeft;
      const right = left + tab.offsetWidth;
      let target: number | null = null;
      if (left - OVERFLOW_FADE_PX < strip.scrollLeft) {
        target = Math.max(0, left - OVERFLOW_FADE_PX);
      } else if (right + OVERFLOW_FADE_PX > strip.scrollLeft + strip.clientWidth) {
        target = right + OVERFLOW_FADE_PX - strip.clientWidth;
      }
      if (target !== null && Math.abs(target - strip.scrollLeft) > 1) {
        programmaticScrollRef.current = true;
        strip.scrollLeft = target;
      }
    }
    measureOverflow();
  }, [activeTabId, measureOverflow]);

  useEffect(() => {
    userScrolledRef.current = false;
    revealActive();
  }, [activeTabId, revealActive]);

  useEffect(() => {
    const el = tablistRef.current;
    if (!el) return;
    // Tabs change width as fonts land and titles update; the strip alone
    // wouldn't notice.
    const observer = new ResizeObserver(() => {
      if (userScrolledRef.current) measureOverflow();
      else revealActive();
    });
    observer.observe(el);
    for (const child of Array.from(el.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [tabs, revealActive, measureOverflow]);

  const handleStripScroll = () => {
    if (programmaticScrollRef.current) programmaticScrollRef.current = false;
    else userScrolledRef.current = true;
    measureOverflow();
  };

  const [allTabsOpen, setAllTabsOpen] = useState(false);
  // The page is a native view drawn over the DOM; claiming an overlay hides it
  // so the menu isn't painted underneath.
  useOverlayClaim("portal-all-tabs", allTabsOpen && isOverflowing);

  // With no tab selected (the launchpad over existing tabs) the first tab is
  // the strip's entry point, so the tablist never drops out of the Tab order.
  const tabStopId = tabs.some((t) => t.id === activeTabId) ? activeTabId : (tabs[0]?.id ?? null);

  const focusTab = (index: number) => {
    const tab = tabs[index];
    if (!tab) return;
    onTabClick(tab.id);
    document.getElementById(tabDomId(tab.id))?.focus();
  };

  return (
    <div className="flex flex-col bg-surface-canvas border-b border-divider">
      <div className="flex items-center gap-0.5 h-10 px-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onGoBack}
              disabled={!hasActiveUrl}
              aria-label="Go back"
              className={iconButtonClass}
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Go back</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onGoForward}
              disabled={!hasActiveUrl}
              aria-label="Go forward"
              className={iconButtonClass}
            >
              <ArrowRight className="w-4 h-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Go forward</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onReload}
              disabled={!hasActiveUrl}
              aria-label="Reload"
              className={iconButtonClass}
            >
              <RotateCw className="w-4 h-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Reload</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onCopyUrl}
              disabled={!activeTabId || !hasActiveUrl}
              aria-label="Copy URL"
              className={iconButtonClass}
            >
              <Link2 className="w-4 h-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Copy URL</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onOpenExternal}
              disabled={!activeTabId || !hasActiveUrl}
              aria-label="Open in external browser"
              className={iconButtonClass}
            >
              <ExternalLink className="w-4 h-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Open in external browser</TooltipContent>
        </Tooltip>

        <div className="flex-1" />

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={toggleDevDashboard}
              aria-label="Dev servers"
              aria-pressed={showDevDashboard}
              className={iconButtonClass}
            >
              <Server className="w-4 h-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {showDevDashboard ? "Hide dev servers" : "Show dev servers"}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close portal"
              aria-keyshortcuts={closePortalAriaShortcut}
              className={iconButtonClass}
            >
              <X className="w-4 h-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {createTooltipContent("Close portal", closePortalShortcut)}
          </TooltipContent>
        </Tooltip>
      </div>

      {tabs.length > 0 && (
        <div className="flex items-center gap-1 px-2 pb-2">
          <DndContext
            sensors={sensors}
            collisionDetection={closestCorners}
            onDragEnd={handleDragEnd}
            accessibility={{ announcements: browserTabAnnouncements }}
          >
            <SortableContext items={tabs.map((t) => t.id)} strategy={horizontalListSortingStrategy}>
              <div
                ref={tablistRef}
                onScroll={handleStripScroll}
                data-row-menu
                className={cn(
                  "flex min-w-0 flex-1 items-center gap-1 overflow-x-auto scrollbar-none",
                  overflow.before &&
                    overflow.after &&
                    "[mask-image:linear-gradient(to_right,transparent,black_24px,black_calc(100%-24px),transparent)]",
                  overflow.before &&
                    !overflow.after &&
                    "[mask-image:linear-gradient(to_right,transparent,black_24px)]",
                  !overflow.before &&
                    overflow.after &&
                    "[mask-image:linear-gradient(to_right,black_calc(100%-24px),transparent)]"
                )}
                role="tablist"
                aria-label="Portal tabs"
                aria-orientation="horizontal"
                onKeyDown={(e) => {
                  // Keys from a tab's context menu bubble here through the React
                  // tree; only act on keys that came from a tab in this strip.
                  if (e.defaultPrevented) return;
                  const fromTab =
                    e.target instanceof Element ? e.target.closest('[role="tab"]') : null;
                  if (!fromTab || !e.currentTarget.contains(fromTab)) return;
                  const currentIndex = tabs.findIndex((t) => tabDomId(t.id) === fromTab.id);
                  const last = tabs.length - 1;
                  let next: number;
                  switch (e.key) {
                    case "ArrowLeft":
                      next = currentIndex > 0 ? currentIndex - 1 : last;
                      break;
                    case "ArrowRight":
                      next = currentIndex < last ? currentIndex + 1 : 0;
                      break;
                    case "Home":
                      next = 0;
                      break;
                    case "End":
                      next = last;
                      break;
                    default:
                      return;
                  }
                  e.preventDefault();
                  focusTab(next);
                }}
              >
                {tabs.map((tab, index) => (
                  <SortableTab
                    key={tab.id}
                    tab={tab}
                    isActive={activeTabId === tab.id}
                    isTabStop={tabStopId === tab.id}
                    onClick={onTabClick}
                    onClose={onTabClose}
                    onDuplicate={duplicateTab}
                    onCloseOthers={closeOthers}
                    onCloseToRight={closeToRight}
                    onCopyUrl={copyTabUrl}
                    onOpenExternal={openTabExternal}
                    onReload={reloadTab}
                    onMove={moveTab}
                    onKeyboardClose={closeFromKeyboard}
                    tabCount={tabs.length}
                    tabIndex={index}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
          {isOverflowing && (
            <DropdownMenu open={allTabsOpen} onOpenChange={setAllTabsOpen}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label={`All tabs (${tabs.length})`}
                      className={cn(
                        iconButtonClass,
                        "flex items-center gap-0.5 text-xs tabular-nums"
                      )}
                    >
                      {tabs.length}
                      <ChevronDown className="w-3.5 h-3.5" />
                    </button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent side="bottom">All tabs</TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="end" className="max-w-[280px]">
                <DropdownMenuRadioGroup
                  value={activeTabId ?? ""}
                  onValueChange={(tabId) => onTabClick(tabId)}
                >
                  {tabs.map((tab) => (
                    <DropdownMenuRadioItem key={tab.id} value={tab.id}>
                      <span className="flex min-w-0 items-center gap-2">
                        <PortalIcon icon={tab.icon ?? "globe"} size="tab" />
                        <span className="truncate">{tab.title}</span>
                      </span>
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onNewTab}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  safeFireAndForget(
                    window.electron.portal.showNewTabMenu({
                      x: e.screenX,
                      y: e.screenY,
                      links: enabledLinks.map((link) => ({
                        title: link.title,
                        url: link.url,
                      })),
                      defaultNewTabUrl,
                    }),
                    { context: "Opening portal new-tab menu" }
                  );
                }}
                className={iconButtonClass}
                aria-label="New Tab"
                aria-keyshortcuts={newTabAriaShortcut}
                aria-haspopup="menu"
              >
                <Plus className="w-4 h-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {createTooltipContent("New Tab", newTabShortcut)}
            </TooltipContent>
          </Tooltip>
        </div>
      )}
    </div>
  );
}
