import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LayoutGroup } from "framer-motion";
import {
  ArrowLeft,
  ArrowRight,
  ArrowRightToLine,
  RotateCw,
  X,
  Plus,
  CopyPlus,
  ExternalLink,
  Globe,
  Link,
  Link2,
  ListX,
  PanelRight,
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
import {
  DocumentTabClose,
  DocumentTabIndicator,
  documentTabClassName,
} from "@/components/ui/document-tab";
import { isTabCloseKey, useKeyboardTabClose } from "@/hooks/useKeyboardTabClose";
import { usePortalStore } from "@/store/portalStore";
import { actionService } from "@/services/ActionService";
import { PortalIcon } from "./PortalIcon";
import { PORTAL_TAB_PANEL_ID, portalTabDomId } from "./portalTabIds";
import { useAriaKeyshortcuts, useEffectiveCombo, useOverlayClaim } from "@/hooks";
import { useToolbarRoving } from "@/hooks/useToolbarRoving";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuActionItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  stopContextMenuPropagation,
} from "@/components/ui/context-menu";
import {
  PANE_TOOLBAR_ICON_BUTTON_CLASS,
  PANE_TOOLBAR_ICON_CLASS,
} from "@/components/ui/paneToolbarStyles";
import { PortalDefaultNewTabSubmenu } from "./PortalDefaultNewTabSubmenu";

const noopTabAction = (_tabId: string) => {};

/**
 * A menu drawn over the portal's native page view. While it is open it claims
 * an overlay so the page hides instead of painting over it, and because portal
 * actions refuse to act while any overlay is claimed, a chosen command runs only
 * once the menu has closed and released its claim.
 */
function useNativeViewMenu(claimId: string) {
  const [open, setOpen] = useState(false);
  const pendingRef = useRef<(() => void) | null>(null);
  useOverlayClaim(claimId, open);
  useEffect(() => {
    if (open || !pendingRef.current) return;
    const run = pendingRef.current;
    pendingRef.current = null;
    run();
  }, [open]);
  const afterClose = useCallback(
    (run: () => void) => () => {
      pendingRef.current = run;
    },
    []
  );
  return { setOpen, afterClose };
}

const OVERFLOW_FADE_PX = 24;

const tabDomId = portalTabDomId;

// The pane-toolbar icon button the dev-preview browser toolbar uses too, so both
// browser chromes read as one family.
const iconButtonClass = PANE_TOOLBAR_ICON_BUTTON_CLASS;

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
  onTabFocus,
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
  onTabFocus: (id: string) => void;
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
  const { setOpen: setMenuOpen, afterClose } = useNativeViewMenu(`portal-tab-menu-${tab.id}`);

  return (
    <ContextMenu modal={false} onOpenChange={setMenuOpen}>
      <Tooltip autoDismiss={false}>
        {/* The dock's own menu wraps the strip; the tab's replaces it, as the
            "+" button's does, for a right-click and a touch long-press alike. */}
        <ContextMenuTrigger
          asChild
          disabled={isDragging}
          onContextMenu={stopContextMenuPropagation}
          onPointerDown={(e) => {
            if (e.pointerType !== "mouse") e.stopPropagation();
          }}
        >
          <TooltipTrigger asChild>
            <div
              ref={setNodeRef}
              style={style}
              {...listeners}
              id={tabDomId(tab.id)}
              role="tab"
              aria-selected={isActive}
              aria-controls={PORTAL_TAB_PANEL_ID}
              aria-label={tab.title}
              aria-keyshortcuts="Delete"
              data-document-tab=""
              tabIndex={isTabStop ? 0 : -1}
              onClick={() => onClick(tab.id)}
              onFocus={(e) => {
                if (e.target === e.currentTarget) onTabFocus(tab.id);
              }}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget) return;
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onClick(tab.id);
                } else if (isTabCloseKey(e.key)) {
                  e.preventDefault();
                  onKeyboardClose(tab.id);
                }
              }}
              className={cn(
                documentTabClassName(isActive),
                "shrink-0 h-8 pl-2.5 pr-1 min-w-[88px] max-w-[180px]",
                isDragging && "opacity-80 shadow-[var(--theme-shadow-floating)] cursor-grabbing"
              )}
            >
              {isActive && <DocumentTabIndicator />}
              <span className="flex w-3.5 h-3.5 shrink-0 items-center justify-center">
                <PortalIcon icon={tab.icon ?? "globe"} size="tab" />
              </span>
              <span className="min-w-0 flex-1 truncate">{tab.title}</span>
              <DocumentTabClose
                title={tab.title}
                isActive={isActive}
                onClose={() => onClose(tab.id)}
              />
            </div>
          </TooltipTrigger>
        </ContextMenuTrigger>
        <TooltipContent side="bottom">
          {tab.url ? `${tab.title} — ${tab.url}` : tab.title}
        </TooltipContent>
      </Tooltip>
      <ContextMenuContent>
        <ContextMenuItem disabled={!hasUrl} onSelect={afterClose(() => onDuplicate(tab.id))}>
          <CopyPlus data-menu-icon className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
          Duplicate
        </ContextMenuItem>
        <ContextMenuItem disabled={!hasUrl} onSelect={afterClose(() => onReload(tab.id))}>
          <RotateCw data-menu-icon className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
          Reload
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={!hasUrl} onSelect={afterClose(() => onCopyUrl(tab.id))}>
          <Link data-menu-icon className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
          Copy URL
        </ContextMenuItem>
        <ContextMenuItem disabled={!hasUrl} onSelect={afterClose(() => onOpenExternal(tab.id))}>
          <Globe data-menu-icon className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
          Open in browser
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={tabIndex === 0} onSelect={afterClose(() => onMove(tab.id, -1))}>
          <ArrowLeft data-menu-icon className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
          Move left
        </ContextMenuItem>
        <ContextMenuItem disabled={!hasTabsToRight} onSelect={afterClose(() => onMove(tab.id, 1))}>
          <ArrowRight data-menu-icon className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
          Move right
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={afterClose(() => onClose(tab.id))}>
          <X data-menu-icon className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
          Close
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!hasOtherTabs}
          onSelect={afterClose(() => onCloseOthers(tab.id))}
        >
          <ListX data-menu-icon className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
          Close others
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!hasTabsToRight}
          onSelect={afterClose(() => onCloseToRight(tab.id))}
        >
          <ArrowRightToLine data-menu-icon className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
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
  const closePortalShortcut = useEffectiveCombo("panel.togglePortal");
  const newTabShortcut = useEffectiveCombo("portal.newTab");
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

  const tabIds = useMemo(() => tabs.map((t) => t.id), [tabs]);
  const focusTabById = useCallback((tabId: string) => {
    document.getElementById(tabDomId(tabId))?.focus();
  }, []);
  // With no tabs left the strip unmounts, so focus goes to the launchpad.
  const focusLaunchpad = useCallback(() => {
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`#${PORTAL_TAB_PANEL_ID} button`)?.focus();
    });
  }, []);
  const { armKeyboardClose, disarmKeyboardClose } = useKeyboardTabClose({
    ids: tabIds,
    activeId: activeTabId,
    focusTab: focusTabById,
    onEmpty: focusLaunchpad,
  });

  const closeFromKeyboard = (tabId: string) => {
    armKeyboardClose(tabId);
    onTabClose(tabId);
  };

  const closeFromPointer = (tabId: string) => {
    disarmKeyboardClose();
    onTabClose(tabId);
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
  // The control row is a toolbar like every pane toolbar: one tab stop, arrow
  // keys between its buttons. The tab strip below keeps its own tablist.
  // Unavailable buttons are aria-disabled, not disabled, so they keep their
  // place in that arrow-key order.
  const controlsRef = useRef<HTMLDivElement>(null);
  const onControlsKeyDown = useToolbarRoving(controlsRef);
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

  // Keep a tab clear of the overflow fade, not just inside the strip: the fade
  // would otherwise eat the edge of the tab and of its focus ring.
  const revealTab = useCallback(
    (tabId: string | null) => {
      const strip = tablistRef.current;
      const tab = tabId ? document.getElementById(tabDomId(tabId)) : null;
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
    },
    [measureOverflow]
  );
  const revealActive = useCallback(() => revealTab(activeTabId), [revealTab, activeTabId]);

  const handleTabFocus = useCallback(
    (tabId: string) => {
      // Focus arriving back on a tab a keyboard close was waiting on means the
      // close was cancelled.
      disarmKeyboardClose(tabId);
      revealTab(tabId);
    },
    [disarmKeyboardClose, revealTab]
  );

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
  const { setOpen: setNewTabMenuOpen, afterClose: afterNewTabMenuClose } =
    useNativeViewMenu("portal-new-tab-menu");

  // With no tab selected (the launchpad over existing tabs) the first tab is
  // the strip's entry point, so the tablist never drops out of the Tab order.
  const tabStopId = tabs.some((t) => t.id === activeTabId) ? activeTabId : (tabs[0]?.id ?? null);

  // Manual activation, like every document tab strip: arrows and Home/End move
  // focus, Enter/Space select. Selecting swaps the native page view in, which
  // is too much to do on every arrow press.
  const focusTab = (index: number) => {
    const tab = tabs[index];
    if (tab) focusTabById(tab.id);
  };

  return (
    <div className="flex flex-col bg-surface-canvas border-b border-divider">
      <div
        ref={controlsRef}
        role="toolbar"
        aria-label="Portal controls"
        onKeyDown={onControlsKeyDown}
        className="flex items-center gap-0.5 h-10 px-2"
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => {
                if (hasActiveUrl) onGoBack?.();
              }}
              aria-disabled={!hasActiveUrl || undefined}
              aria-label="Go back"
              className={iconButtonClass}
            >
              <ArrowLeft className={PANE_TOOLBAR_ICON_CLASS} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Go back</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => {
                if (hasActiveUrl) onGoForward?.();
              }}
              aria-disabled={!hasActiveUrl || undefined}
              aria-label="Go forward"
              className={iconButtonClass}
            >
              <ArrowRight className={PANE_TOOLBAR_ICON_CLASS} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Go forward</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => {
                if (hasActiveUrl) onReload?.();
              }}
              aria-disabled={!hasActiveUrl || undefined}
              aria-label="Reload"
              className={iconButtonClass}
            >
              <RotateCw className={PANE_TOOLBAR_ICON_CLASS} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Reload</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => {
                if (activeTabId && hasActiveUrl) onCopyUrl?.();
              }}
              aria-disabled={!activeTabId || !hasActiveUrl || undefined}
              aria-label="Copy URL"
              className={iconButtonClass}
            >
              <Link2 className={PANE_TOOLBAR_ICON_CLASS} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Copy URL</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => {
                if (activeTabId && hasActiveUrl) onOpenExternal?.();
              }}
              aria-disabled={!activeTabId || !hasActiveUrl || undefined}
              aria-label="Open in external browser"
              className={iconButtonClass}
            >
              <ExternalLink className={PANE_TOOLBAR_ICON_CLASS} />
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
              <Server className={PANE_TOOLBAR_ICON_CLASS} />
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
              <X className={PANE_TOOLBAR_ICON_CLASS} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {createTooltipContent("Close portal", closePortalShortcut)}
          </TooltipContent>
        </Tooltip>
      </div>

      {tabs.length > 0 && (
        // No bottom padding: the selected tab's underline sits on the toolbar's
        // bottom rule, as it does on the dock popover's strip.
        <div className="flex items-center gap-1 px-2">
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
                  "flex min-w-0 flex-1 items-center overflow-x-auto scrollbar-none",
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
                <LayoutGroup id="portal-tabs">
                  {tabs.map((tab, index) => (
                    <SortableTab
                      key={tab.id}
                      tab={tab}
                      isActive={activeTabId === tab.id}
                      isTabStop={tabStopId === tab.id}
                      onClick={onTabClick}
                      onClose={closeFromPointer}
                      onDuplicate={duplicateTab}
                      onCloseOthers={closeOthers}
                      onCloseToRight={closeToRight}
                      onCopyUrl={copyTabUrl}
                      onOpenExternal={openTabExternal}
                      onReload={reloadTab}
                      onMove={moveTab}
                      onKeyboardClose={closeFromKeyboard}
                      onTabFocus={handleTabFocus}
                      tabCount={tabs.length}
                      tabIndex={index}
                    />
                  ))}
                </LayoutGroup>
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
          <ContextMenu modal={false} onOpenChange={setNewTabMenuOpen}>
            <Tooltip>
              <TooltipTrigger asChild>
                <ContextMenuTrigger asChild>
                  <button
                    type="button"
                    onClick={onNewTab}
                    // The dock's own context menu wraps this button; the "+"
                    // menu replaces it here rather than stacking on top of it,
                    // for a right-click and for a touch or pen long-press alike.
                    onContextMenu={(e) => e.stopPropagation()}
                    onPointerDown={(e) => {
                      if (e.pointerType !== "mouse") e.stopPropagation();
                    }}
                    className={iconButtonClass}
                    aria-label="New Tab"
                    aria-keyshortcuts={newTabAriaShortcut}
                  >
                    <Plus className={PANE_TOOLBAR_ICON_CLASS} />
                  </button>
                </ContextMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {createTooltipContent("New Tab", newTabShortcut)}
              </TooltipContent>
            </Tooltip>
            <ContextMenuContent>
              {enabledLinks.map((link) => (
                <ContextMenuItem
                  key={link.url}
                  onSelect={afterNewTabMenuClose(
                    () =>
                      void actionService.dispatch(
                        "portal.openUrl",
                        { url: link.url, title: link.title },
                        { source: "context-menu" }
                      )
                  )}
                >
                  <PortalIcon icon={link.icon} size="tab" className="mr-2 shrink-0" />
                  <span className="truncate">{link.title}</span>
                </ContextMenuItem>
              ))}
              {enabledLinks.length > 0 && <ContextMenuSeparator />}
              <ContextMenuItem
                onSelect={afterNewTabMenuClose(
                  () =>
                    void actionService.dispatch("portal.openLaunchpad", undefined, {
                      source: "context-menu",
                    })
                )}
              >
                <Plus data-menu-icon className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
                Open launchpad
              </ContextMenuItem>
              <ContextMenuSeparator />
              <PortalDefaultNewTabSubmenu
                links={enabledLinks}
                defaultNewTabUrl={defaultNewTabUrl}
              />
              <ContextMenuSeparator />
              <ContextMenuActionItem actionId="app.settings.openTab" args={{ tab: "portal" }}>
                <PanelRight data-menu-icon className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
                Portal settings…
              </ContextMenuActionItem>
            </ContextMenuContent>
          </ContextMenu>
        </div>
      )}
    </div>
  );
}
