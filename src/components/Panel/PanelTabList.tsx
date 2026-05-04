import React, { memo } from "react";
import { LayoutGroup } from "framer-motion";
import { Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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

export const PanelTabList = memo(function PanelTabList({
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
  return (
    <div className={cn("relative min-w-0 flex-1 flex", className)}>
      <div
        ref={tabListRef}
        className="flex items-center min-w-0 flex-1 overflow-x-auto scrollbar-none"
        role="tablist"
        aria-label="Panel tabs"
        onKeyDown={onKeyDown}
      >
        <LayoutGroup id={layoutGroupId}>
          <div className="flex items-center">
            {tabs.map((tab) => renderTab(tab))}
            {onAddTab && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onAddTab();
                    }}
                    onPointerDown={(e) => e.stopPropagation()}
                    className="shrink-0 p-1.5 hover:bg-daintree-text/10 text-daintree-text/40 hover:text-daintree-text transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-1"
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
});
