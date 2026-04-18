import { memo } from "react";
import { ArrowLeft, ArrowRight, RotateCw, X, Plus, ExternalLink, Link2 } from "lucide-react";
import {
  DndContext,
  closestCorners,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  horizontalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { PortalTab, PortalLink } from "@shared/types";
import { cn } from "@/lib/utils";
import { createTooltipWithShortcut } from "@/lib/platform";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import { usePortalStore } from "@/store/portalStore";
import { PortalIcon } from "./PortalIcon";
import { useKeybindingDisplay } from "@/hooks";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

const noopTabAction = (_tabId: string) => {};

const SortableTab = memo(function SortableTab({
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
  tabCount,
  tabIndex,
}: {
  tab: PortalTab;
  isActive: boolean;
  onClick: (id: string) => void;
  onClose: (id: string) => void;
  onDuplicate: (id: string) => void;
  onCloseOthers: (id: string) => void;
  onCloseToRight: (id: string) => void;
  onCopyUrl: (id: string) => void;
  onOpenExternal: (id: string) => void;
  onReload: (id: string) => void;
  tabCount: number;
  tabIndex: number;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
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
          {...attributes}
          {...listeners}
          role="tab"
          aria-selected={isActive}
          aria-label={tab.title}
          tabIndex={isActive ? 0 : -1}
          onClick={() => onClick(tab.id)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onClick(tab.id);
            }
          }}
          className={cn(
            "group relative flex items-center gap-2 px-3 py-1.5 text-xs font-medium cursor-pointer select-none transition",
            "rounded-full border shadow-[var(--theme-shadow-ambient)]",
            "min-w-[80px] max-w-[200px]",
            "focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2",
            isActive
              ? "bg-tint/[0.08] text-daintree-text border-daintree-accent/40 ring-1 ring-inset ring-daintree-accent/30"
              : "bg-overlay-subtle text-daintree-text/70 border-divider hover:bg-overlay-medium hover:text-daintree-text",
            isDragging &&
              "opacity-80 scale-105 shadow-[var(--theme-shadow-floating)] cursor-grabbing"
          )}
        >
          {tab.icon && (
            <div className="flex-shrink-0">
              <PortalIcon icon={tab.icon} size="tab" url={tab.url ?? undefined} />
            </div>
          )}
          <span className="truncate max-w-[120px]">{tab.title}</span>
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onClose(tab.id);
            }}
            aria-label={`Close ${tab.title}`}
            className={cn(
              "p-0.5 rounded-full transition-colors ml-1",
              isActive
                ? "text-daintree-text/60 hover:text-daintree-text hover:bg-tint/[0.06]"
                : "text-daintree-text/40 hover:text-daintree-text hover:bg-tint/[0.06] opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            )}
          >
            <X className="w-3 h-3" />
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
          Open in Browser
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => onClose(tab.id)}>Close</ContextMenuItem>
        <ContextMenuItem disabled={!hasOtherTabs} onSelect={() => onCloseOthers(tab.id)}>
          Close Others
        </ContextMenuItem>
        <ContextMenuItem disabled={!hasTabsToRight} onSelect={() => onCloseToRight(tab.id)}>
          Close to Right
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
});

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
  const closePortalShortcut = useKeybindingDisplay("panel.togglePortal");
  const newTabShortcut = useKeybindingDisplay("portal.newTab");

  const duplicateTab = onDuplicateTab ?? noopTabAction;
  const closeOthers = onCloseOthers ?? noopTabAction;
  const closeToRight = onCloseToRight ?? noopTabAction;
  const copyTabUrl = onCopyTabUrl ?? noopTabAction;
  const openTabExternal = onOpenTabExternal ?? noopTabAction;
  const reloadTab = onReloadTab ?? noopTabAction;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const oldIndex = tabs.findIndex((t) => t.id === active.id);
      const newIndex = tabs.findIndex((t) => t.id === over.id);
      reorderTabs(oldIndex, newIndex);
    }
  };

  return (
    <div className="flex flex-col bg-daintree-bg border-b border-daintree-border">
      {/* Top Row: Navigation Controls */}
      <div className="flex items-center justify-between px-2 py-1.5">
        <div className="flex items-center gap-0.5">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={onGoBack}
                  disabled={!activeTabId}
                  aria-label="Go back"
                  className="p-1 rounded hover:bg-tint/[0.06] text-muted-foreground hover:text-daintree-text transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <ArrowLeft className="w-3.5 h-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Go back</TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={onGoForward}
                  disabled={!activeTabId}
                  aria-label="Go forward"
                  className="p-1 rounded hover:bg-tint/[0.06] text-muted-foreground hover:text-daintree-text transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Go forward</TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={onReload}
                  disabled={!activeTabId}
                  aria-label="Reload"
                  className="p-1 rounded hover:bg-tint/[0.06] text-muted-foreground hover:text-daintree-text transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <RotateCw className="w-3.5 h-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Reload</TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={onCopyUrl}
                  disabled={!activeTabId || !hasActiveUrl}
                  aria-label="Copy URL"
                  className="p-1 rounded hover:bg-tint/[0.06] text-muted-foreground hover:text-daintree-text transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Link2 className="w-3.5 h-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Copy URL</TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={onOpenExternal}
                  disabled={!activeTabId || !hasActiveUrl}
                  aria-label="Open in external browser"
                  className="p-1 rounded hover:bg-tint/[0.06] text-muted-foreground hover:text-daintree-text transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Open in external browser</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>

        <div className="flex items-center gap-1">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={onClose}
                  aria-label="Close portal"
                  className="p-1 rounded hover:bg-tint/[0.06] text-muted-foreground hover:text-daintree-text transition-colors ml-1"
                >
                  <X className="w-4 h-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {createTooltipWithShortcut("Close portal", closePortalShortcut)}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>

      {/* Bottom Row: Tab Pills */}
      <div className="px-2 pb-2">
        <DndContext sensors={sensors} collisionDetection={closestCorners} onDragEnd={handleDragEnd}>
          <SortableContext items={tabs.map((t) => t.id)} strategy={horizontalListSortingStrategy}>
            <div
              className="flex flex-wrap gap-2 items-center"
              role="tablist"
              aria-orientation="horizontal"
              onKeyDown={(e) => {
                if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                  e.preventDefault();
                  const currentIndex = tabs.findIndex((t) => t.id === activeTabId);
                  if (currentIndex === -1) return;
                  const nextIndex =
                    e.key === "ArrowLeft"
                      ? currentIndex > 0
                        ? currentIndex - 1
                        : tabs.length - 1
                      : currentIndex < tabs.length - 1
                        ? currentIndex + 1
                        : 0;
                  onTabClick(tabs[nextIndex]!.id);
                }
              }}
            >
              {tabs.map((tab, index) => (
                <SortableTab
                  key={tab.id}
                  tab={tab}
                  isActive={activeTabId === tab.id}
                  onClick={onTabClick}
                  onClose={onTabClose}
                  onDuplicate={duplicateTab}
                  onCloseOthers={closeOthers}
                  onCloseToRight={closeToRight}
                  onCopyUrl={copyTabUrl}
                  onOpenExternal={openTabExternal}
                  onReload={reloadTab}
                  tabCount={tabs.length}
                  tabIndex={index}
                />
              ))}
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={onNewTab}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        void window.electron.portal.showNewTabMenu({
                          x: e.screenX,
                          y: e.screenY,
                          links: enabledLinks.map((link) => ({ title: link.title, url: link.url })),
                          defaultNewTabUrl,
                        });
                      }}
                      className="flex items-center justify-center w-8 h-[26px] rounded-full bg-overlay-subtle hover:bg-overlay-soft text-daintree-text/70 hover:text-daintree-text border border-divider transition"
                      aria-label="New Tab"
                      aria-haspopup="menu"
                    >
                      <Plus className="w-4 h-4" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {createTooltipWithShortcut("New Tab", newTabShortcut)}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
          </SortableContext>
        </DndContext>
      </div>
    </div>
  );
}
