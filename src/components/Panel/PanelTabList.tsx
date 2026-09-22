import React from "react";
import { LayoutGroup, AnimatePresence, m } from "framer-motion";
import { Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { UI_ANIMATION_DURATION, EASE_OUT_EXPO_FM } from "@/lib/animationUtils";
import type { TabInfo } from "./TabButton";

export interface PanelTabListProps {
  layoutGroupId: string;
  tabs: TabInfo[];
  /**
   * Tabs the overflow observer has marked as not fitting. They stay in the
   * strip's layout — the observer needs their boxes to notice when they fit
   * again — but they are painted `invisible` rather than left as fragments
   * at the clipped edge. The active tab is never hidden: it is scrolled into
   * view, and the observer can flag it mid-scroll.
   */
  hiddenTabIds?: ReadonlySet<string>;
  tabListRef: (el: HTMLDivElement | null) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onAddTab?: () => void;
  addTabTooltipContent: React.ReactNode;
  overflowTrigger: React.ReactNode | null;
  /** `parked` is true for a tab the overflow observer could not fit (never the active one). */
  renderTab: (tab: TabInfo, parked: boolean) => React.ReactNode;
  className?: string;
}

export function PanelTabList({
  layoutGroupId,
  tabs,
  hiddenTabIds,
  tabListRef,
  onKeyDown,
  onAddTab,
  addTabTooltipContent,
  overflowTrigger,
  renderTab,
  className,
}: PanelTabListProps) {
  const performanceMode = document.body.dataset.performanceMode === "true";
  const isParked = (tab: TabInfo) => !tab.isActive && (hiddenTabIds?.has(tab.id) ?? false);

  return (
    // [data-no-dnd] opts the whole tab strip out of the outer panel-move drag
    // sensor (NoDndMouseSensor) so dragging/clicking a tab — or the add/overflow
    // buttons — never arms the parent panel drag. Inner tab reorder is a separate
    // DndContext using PointerSensor, which ignores [data-no-dnd], so it still works.
    <div data-no-dnd className={cn("relative min-w-0 flex-1 flex", className)}>
      <div
        // Keyed on the mode: the two branches below mount different tab
        // elements, and the overflow observer only re-observes when the strip
        // element changes — otherwise it keeps watching the old, detached tabs.
        key={performanceMode ? "static" : "animated"}
        ref={tabListRef}
        className="flex items-center min-w-0 flex-1 overflow-x-auto scrollbar-none relative"
        role="tablist"
        aria-label="Panel tabs"
        onKeyDown={onKeyDown}
      >
        <LayoutGroup id={layoutGroupId}>
          <div className="flex items-center">
            {performanceMode ? (
              // No wrapper here: a sortable tab's drag is restricted to its
              // parent element, and a per-tab box would pin it in place.
              tabs.map((tab) => renderTab(tab, isParked(tab)))
            ) : (
              <AnimatePresence initial={false} mode="popLayout">
                {tabs.map((tab) => (
                  <m.div
                    key={tab.id}
                    layout="position"
                    transition={{ duration: UI_ANIMATION_DURATION / 1000, ease: EASE_OUT_EXPO_FM }}
                  >
                    {renderTab(tab, isParked(tab))}
                  </m.div>
                ))}
              </AnimatePresence>
            )}
            {onAddTab && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={(e) => {
                      e.stopPropagation();
                      onAddTab();
                    }}
                    onPointerDown={(e) => e.stopPropagation()}
                    className="shrink-0"
                    aria-label="Duplicate panel as new tab"
                  >
                    <Plus aria-hidden="true" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{addTabTooltipContent}</TooltipContent>
              </Tooltip>
            )}
          </div>
        </LayoutGroup>
      </div>
      {overflowTrigger}
    </div>
  );
}
