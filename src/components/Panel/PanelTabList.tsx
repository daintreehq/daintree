import React from "react";
import { LayoutGroup, AnimatePresence, m } from "framer-motion";
import { Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { UI_ANIMATION_DURATION, EASE_OUT_EXPO_FM } from "@/lib/animationUtils";
import type { TabInfo } from "./TabButton";

export interface PanelTabListProps {
  layoutGroupId: string;
  tabs: TabInfo[];
  tabListRef: (el: HTMLDivElement | null) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onAddTab?: () => void;
  addTabTooltipContent: React.ReactNode;
  overflowTrigger: React.ReactNode | null;
  renderTab: (tab: TabInfo) => React.ReactNode;
  className?: string;
}

export function PanelTabList({
  layoutGroupId,
  tabs,
  tabListRef,
  onKeyDown,
  onAddTab,
  addTabTooltipContent,
  overflowTrigger,
  renderTab,
  className,
}: PanelTabListProps) {
  const performanceMode = document.body.dataset.performanceMode === "true";

  return (
    // [data-no-dnd] opts the whole tab strip out of the outer panel-move drag
    // sensor (NoDndMouseSensor) so dragging/clicking a tab — or the add/overflow
    // buttons — never arms the parent panel drag. Inner tab reorder is a separate
    // DndContext using PointerSensor, which ignores [data-no-dnd], so it still works.
    <div data-no-dnd className={cn("relative min-w-0 flex-1 flex", className)}>
      <div
        ref={tabListRef}
        className="flex items-center min-w-0 flex-1 overflow-x-auto scrollbar-none relative"
        role="tablist"
        aria-label="Panel tabs"
        onKeyDown={onKeyDown}
      >
        <LayoutGroup id={layoutGroupId}>
          <div className="flex items-center">
            {performanceMode ? (
              tabs.map((tab) => renderTab(tab))
            ) : (
              <AnimatePresence initial={false} mode="popLayout">
                {tabs.map((tab) => (
                  <m.div
                    key={tab.id}
                    layout="position"
                    transition={{ duration: UI_ANIMATION_DURATION / 1000, ease: EASE_OUT_EXPO_FM }}
                  >
                    {renderTab(tab)}
                  </m.div>
                ))}
              </AnimatePresence>
            )}
            {onAddTab && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onAddTab();
                    }}
                    onPointerDown={(e) => e.stopPropagation()}
                    className="shrink-0 p-1.5 hover:bg-daintree-text/10 text-daintree-text/40 hover:text-text-primary transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-1"
                    aria-label="Duplicate panel as new tab"
                    type="button"
                  >
                    <Plus className="w-3 h-3" aria-hidden="true" />
                  </button>
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
