import React, { useCallback } from "react";
import { SortableContext, rectSortingStrategy } from "@dnd-kit/sortable";
import { LayoutGroup } from "framer-motion";
import { cn } from "@/lib/utils";
import { COMFORTABLE_PANEL_HEIGHT_PX, MIN_TERMINAL_WIDTH_PX } from "@/lib/terminalLayout";
import { GridNotificationBar } from "./GridNotificationBar";
import { GridPanel } from "./GridPanel";
import { GridTabGroup } from "./GridTabGroup";
import { GridScrollRootContext } from "./GridScrollRootContext";
import { GridAttentionStrip } from "./GridAttentionStrip";
import {
  SortableTerminal,
  GRID_PLACEHOLDER_ID,
  SortableGridPlaceholder,
} from "@/components/DragDrop";
import { GridShell } from "./GridShell";
import { TerminalCountWarning } from "./TerminalCountWarning";
import { ContentGridEmptyState } from "./ContentGridEmptyState";
import type { ContentGridContext } from "./useContentGridContext";

export function ContentGridDefault({
  ctx,
  bindCombinedGrid,
  bindGridRegion,
  className,
}: {
  ctx: ContentGridContext;
  bindCombinedGrid: (node: HTMLDivElement | null) => void;
  bindGridRegion: (node: HTMLDivElement | null) => void;
  className?: string;
}) {
  "use memo";

  // Compose the dnd droppable binding, the grid container ref, and the
  // scroll-root state setter into a single ref callback so the grid div is the
  // canonical scroll container for IntersectionObserver, scrollIntoView, and
  // attention-jump targeting.
  const { setGridScrollRoot } = ctx;
  const bindGridScrollContainer = useCallback(
    (node: HTMLDivElement | null) => {
      bindCombinedGrid(node);
      setGridScrollRoot(node);
    },
    [bindCombinedGrid, setGridScrollRoot]
  );

  return (
    <GridScrollRootContext.Provider value={ctx.gridScrollRoot}>
      <div
        key="grid-mode"
        ref={bindGridRegion}
        role="region"
        tabIndex={-1}
        aria-label="Panel grid"
        data-macro-focus={ctx.isMacroFocused ? "true" : undefined}
        onKeyDown={ctx.handleGridRegionKeyDown}
        className={cn(
          "h-full flex flex-col outline-hidden",
          "data-[macro-focus=true]:ring-2 data-[macro-focus=true]:ring-daintree-accent/60 data-[macro-focus=true]:ring-inset",
          className
        )}
      >
        <GridNotificationBar className="mx-1 mt-1 shrink-0" />
        <TerminalCountWarning className="mx-1 mt-1 shrink-0" />
        <div className="relative flex-1 min-h-0">
          <SortableContext id="grid-container" items={ctx.panelIds} strategy={rectSortingStrategy}>
            <GridShell
              ctx={ctx}
              showTerminalCountWarning={false}
              className="relative h-full min-h-0"
            >
              <div
                ref={bindGridScrollContainer}
                className={cn(
                  "h-full bg-noise p-1",
                  ctx.isOver && "ring-2 ring-daintree-accent/30 ring-inset"
                )}
                style={{
                  display: "grid",
                  gridTemplateColumns: `repeat(${ctx.gridCols}, minmax(min(100%, ${MIN_TERMINAL_WIDTH_PX}px), 1fr))`,
                  gridAutoRows: `minmax(${COMFORTABLE_PANEL_HEIGHT_PX}px, 1fr)`,
                  gap: "4px",
                  backgroundColor: "var(--color-grid-bg)",
                  overflowX: "hidden",
                  overflowY: "auto",
                  // Prevent Chromium's scroll-anchor algorithm from fighting
                  // framer-motion's `LayoutGroup` layout-projection when panels
                  // are added or removed above the viewport — Chromium 146
                  // reflow would otherwise produce visible stutter (#8805).
                  overflowAnchor: "none",
                  // Reserve gutter width so a row of cells doesn't reflow when
                  // the scrollbar appears mid-burst.
                  scrollbarGutter: "stable",
                  // Stop xterm scrollback / overflow strip-of-history from
                  // chaining into the outer chrome via overscroll bounces.
                  overscrollBehavior: "contain",
                }}
                id="panel-grid"
                data-grid-container="true"
              >
                {ctx.isEmpty && !ctx.showPlaceholder ? (
                  <div className="col-span-full row-span-full">
                    {ctx.emptyContent ?? (
                      <ContentGridEmptyState
                        hasActiveWorktree={ctx.hasActiveWorktree}
                        hasWorktrees={ctx.worktreeMap.size > 0}
                        isWorktreeInitialized={ctx.isWorktreeInitialized}
                        activeWorktreeName={ctx.activeWorktreeName}
                        activeWorktreeId={ctx.activeWorktreeId}
                        activeWorktreeBranch={ctx.activeWorktreeBranch}
                        activeWorktreeIsDetached={ctx.activeWorktreeIsDetached}
                        activeWorktreeHead={ctx.activeWorktreeHead}
                        activeWorktreePath={ctx.activeWorktreePath}
                        projectName={ctx.projectName}
                        projectEmoji={ctx.projectEmoji}
                        showProjectPulse={ctx.showProjectPulse}
                        projectIconSvg={ctx.projectIconSvg}
                        defaultCwd={ctx.defaultCwd}
                      />
                    )}
                  </div>
                ) : (
                  <LayoutGroup id="main-grid">
                    {ctx.tabGroups.map((group, index) => {
                      const groupPanels = ctx.getTabGroupPanels(group.id, "grid");
                      if (groupPanels.length === 0) return null;

                      const elements: React.ReactNode[] = [];

                      if (
                        ctx.showPlaceholder &&
                        ctx.placeholderInGrid &&
                        ctx.placeholderIndex === index
                      ) {
                        elements.push(<SortableGridPlaceholder key={GRID_PLACEHOLDER_ID} />);
                      }

                      const isGroupDisabled = groupPanels.some((p) => ctx.isInTrash(p.id));

                      if (groupPanels.length === 1) {
                        const terminal = groupPanels[0]!;
                        elements.push(
                          <SortableTerminal
                            key={group.id}
                            terminal={terminal}
                            sourceLocation="grid"
                            sourceIndex={index}
                            disabled={isGroupDisabled}
                            layoutTransition={ctx.layoutTransition}
                          >
                            <GridPanel
                              terminalId={terminal.id}
                              isFocused={terminal.id === ctx.focusedId}
                              isMultiPanelGrid={ctx.gridItemCount > 1}
                              onAddTabForPanel={ctx.handleAddTabForPanel}
                            />
                          </SortableTerminal>
                        );
                      } else {
                        const firstPanel = groupPanels[0]!;
                        elements.push(
                          <SortableTerminal
                            key={group.id}
                            terminal={firstPanel}
                            sourceLocation="grid"
                            sourceIndex={index}
                            disabled={isGroupDisabled}
                            groupId={group.id}
                            groupPanelIds={group.panelIds}
                            layoutTransition={ctx.layoutTransition}
                          >
                            <GridTabGroup
                              group={group}
                              focusedId={ctx.focusedId}
                              isMultiPanelGrid={ctx.gridItemCount > 1}
                            />
                          </SortableTerminal>
                        );
                      }

                      return elements;
                    })}
                    {ctx.showPlaceholder &&
                      ctx.placeholderInGrid &&
                      ctx.placeholderIndex === ctx.tabGroups.length && (
                        <SortableGridPlaceholder key={GRID_PLACEHOLDER_ID} />
                      )}
                  </LayoutGroup>
                )}
              </div>
            </GridShell>
          </SortableContext>
        </div>
        <GridAttentionStrip tabGroups={ctx.tabGroups} className="mx-1 mb-1 shrink-0" />
      </div>
    </GridScrollRootContext.Provider>
  );
}
