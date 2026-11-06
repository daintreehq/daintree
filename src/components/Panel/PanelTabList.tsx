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
  onFocus?: (e: React.FocusEvent<HTMLDivElement>) => void;
  onBlur?: (e: React.FocusEvent<HTMLDivElement>) => void;
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
  onFocus,
  onBlur,
  onAddTab,
  addTabTooltipContent,
  overflowTrigger,
  renderTab,
  className,
}: PanelTabListProps) {
  const performanceMode = document.body.dataset.performanceMode === "true";
  const isParked = (tab: TabInfo) => !tab.isActive && (hiddenTabIds?.has(tab.id) ?? false);
  // The active tab is never parked, so in a strip narrower than it the strip's
  // edge cuts it mid-word. Fading the last 16px of that edge makes
  // the cut read as "more to the right" rather than as a broken render.
  const activeIsCut = tabs.some((tab) => tab.isActive && (hiddenTabIds?.has(tab.id) ?? false));

  return (
    // [data-no-dnd] opts the whole tab strip out of the outer panel-move drag
    // sensor (NoDndMouseSensor) so dragging/clicking a tab — or the add/overflow
    // buttons — never arms the parent panel drag. Inner tab reorder is a separate
    // DndContext using PointerSensor, which ignores [data-no-dnd], so it still works.
    // Tabs span the bar's full height so the selected tab's underline sits on
    // the bar's bottom rule, as it does on every document tab strip.
    <div data-no-dnd className={cn("relative min-w-0 flex-1 flex self-stretch", className)}>
      <div
        // Keyed on the mode: the two branches below mount different tab
        // elements, and the overflow observer only re-observes when the strip
        // element changes — otherwise it keeps watching the old, detached tabs.
        key={performanceMode ? "static" : "animated"}
        ref={tabListRef}
        // What the maximized readout must clear: the strip's own content, not
        // the flex-1 frame around it, which always spans the bar.
        data-readout-obstacle=""
        className={cn(
          "flex items-stretch min-w-0 overflow-x-auto scrollbar-none relative",
          activeIsCut &&
            "[mask-image:linear-gradient(to_right,black_calc(100%-16px),transparent)] contrast-more:[mask-image:none] forced-colors:[mask-image:none]"
        )}
        role="tablist"
        aria-label="Panel tabs"
        onKeyDown={onKeyDown}
        onFocus={onFocus}
        onBlur={onBlur}
      >
        <LayoutGroup id={layoutGroupId}>
          <div className="flex items-stretch">
            {performanceMode ? (
              tabs.map((tab) => renderTab(tab, isParked(tab)))
            ) : (
              <AnimatePresence initial={false} mode="popLayout">
                {tabs.map((tab) => (
                  <m.div
                    key={tab.id}
                    className="flex"
                    layout="position"
                    transition={{ duration: UI_ANIMATION_DURATION / 1000, ease: EASE_OUT_EXPO_FM }}
                  >
                    {renderTab(tab, isParked(tab))}
                  </m.div>
                ))}
              </AnimatePresence>
            )}
          </div>
        </LayoutGroup>
      </div>
      {/* A sibling of the tablist, not a child: a tablist may own only tabs. */}
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
              // 14px glyph in the 24px target, like the window controls
              // at the other end of the same bar.
              className="shrink-0 self-center focus-visible:outline-offset-[-2px] [&_svg]:size-3.5"
              data-readout-obstacle=""
              aria-label="Duplicate panel as new tab"
            >
              <Plus aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{addTabTooltipContent}</TooltipContent>
        </Tooltip>
      )}
      {overflowTrigger && (
        // ml-1: the window controls' 4px step, so "+" and the chevron read as
        // two targets rather than one wide one.
        <div className="ml-1 flex items-center" data-readout-obstacle="">
          {overflowTrigger}
        </div>
      )}
    </div>
  );
}
