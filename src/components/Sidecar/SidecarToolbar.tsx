import { memo } from "react";
import {
  ArrowLeft,
  ArrowRight,
  RotateCw,
  X,
  Plus,
  ExternalLink,
  Link2,
  Copy,
  Trash2,
} from "lucide-react";
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
import type { SidecarTab } from "@shared/types";
import { cn } from "@/lib/utils";
import { useSidecarStore } from "@/store/sidecarStore";
import { SidecarIcon } from "./SidecarIcon";
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
  tab: SidecarTab;
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
    <ContextMenu>
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
          className={cn(
            "group relative flex items-center gap-2 px-3 py-1.5 text-xs font-medium cursor-pointer select-none transition-all",
            "rounded-full border shadow-sm",
            "min-w-[80px] max-w-[200px]",
            isActive
              ? "bg-foreground text-background border-foreground/20 ring-1 ring-foreground/30"
              : "bg-canopy-border text-canopy-text border-canopy-border hover:bg-canopy-border/80 hover:text-foreground hover:border-canopy-border",
            isDragging && "opacity-80 scale-105 shadow-xl cursor-grabbing"
          )}
        >
          {tab.icon && (
            <div className="flex-shrink-0">
              <SidecarIcon icon={tab.icon} size="tab" url={tab.url ?? undefined} />
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
                ? "text-background hover:text-background hover:bg-foreground/20"
                : "text-muted-foreground hover:text-foreground hover:bg-canopy-bg opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            )}
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => onDuplicate(tab.id)} disabled={!hasUrl}>
          <Copy className="w-3.5 h-3.5 mr-2" />
          Duplicate
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => onReload(tab.id)} disabled={!hasUrl}>
          <RotateCw className="w-3.5 h-3.5 mr-2" />
          Reload
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => onCopyUrl(tab.id)} disabled={!hasUrl}>
          <Link2 className="w-3.5 h-3.5 mr-2" />
          Copy URL
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => onOpenExternal(tab.id)} disabled={!hasUrl}>
          <ExternalLink className="w-3.5 h-3.5 mr-2" />
          Open in Browser
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => onClose(tab.id)}>
          <X className="w-3.5 h-3.5 mr-2" />
          Close
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => onCloseOthers(tab.id)} disabled={!hasOtherTabs}>
          <Trash2 className="w-3.5 h-3.5 mr-2" />
          Close Others
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => onCloseToRight(tab.id)} disabled={!hasTabsToRight}>
          <Trash2 className="w-3.5 h-3.5 mr-2" />
          Close to Right
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
});

interface SidecarToolbarProps {
  tabs: SidecarTab[];
  activeTabId: string | null;
  onTabClick: (tabId: string) => void;
  onTabClose: (tabId: string) => void;
  onNewTab: () => void;
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
}

export function SidecarToolbar({
  tabs,
  activeTabId,
  onTabClick,
  onTabClose,
  onNewTab,
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
}: SidecarToolbarProps) {
  const reorderTabs = useSidecarStore((s) => s.reorderTabs);

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
    <div className="flex flex-col bg-canopy-bg border-b border-canopy-border">
      {/* Top Row: Navigation Controls */}
      <div className="flex items-center justify-between px-2 py-1.5">
        <div className="flex items-center gap-0.5">
          <button
            onClick={onGoBack}
            disabled={!activeTabId}
            aria-label="Go back"
            className="p-1 rounded hover:bg-canopy-border text-muted-foreground hover:text-canopy-text transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title="Go back"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={onGoForward}
            disabled={!activeTabId}
            aria-label="Go forward"
            className="p-1 rounded hover:bg-canopy-border text-muted-foreground hover:text-canopy-text transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title="Go forward"
          >
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={onReload}
            disabled={!activeTabId}
            aria-label="Reload"
            className="p-1 rounded hover:bg-canopy-border text-muted-foreground hover:text-canopy-text transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title="Reload"
          >
            <RotateCw className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={onCopyUrl}
            disabled={!activeTabId || !hasActiveUrl}
            aria-label="Copy URL"
            className="p-1 rounded hover:bg-canopy-border text-muted-foreground hover:text-canopy-text transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title="Copy URL"
          >
            <Link2 className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={onOpenExternal}
            disabled={!activeTabId || !hasActiveUrl}
            aria-label="Open in external browser"
            className="p-1 rounded hover:bg-canopy-border text-muted-foreground hover:text-canopy-text transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title="Open in external browser"
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="flex items-center gap-1">
          <button
            onClick={onClose}
            aria-label="Close sidecar"
            className="p-1 rounded hover:bg-canopy-border text-muted-foreground hover:text-canopy-text transition-colors ml-1"
            title="Close sidecar"
          >
            <X className="w-4 h-4" />
          </button>
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
                  onTabClick(tabs[nextIndex].id);
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

              <button
                onClick={onNewTab}
                className="flex items-center justify-center w-8 h-[26px] rounded-full bg-canopy-border hover:bg-canopy-border/80 text-canopy-text hover:text-foreground border border-canopy-border hover:border-canopy-border transition-all"
                title="New Tab"
              >
                <Plus className="w-4 h-4" />
              </button>
            </div>
          </SortableContext>
        </DndContext>
      </div>
    </div>
  );
}
