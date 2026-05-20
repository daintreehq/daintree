import React from "react";
import { SortableContext, rectSortingStrategy } from "@dnd-kit/sortable";
import { LayoutGroup } from "framer-motion";
import { cn } from "@/lib/utils";
import { MIN_TERMINAL_HEIGHT_PX, MIN_TERMINAL_WIDTH_PX } from "@/lib/terminalLayout";
import { GridNotificationBar } from "./GridNotificationBar";
import { GridPanel } from "./GridPanel";
import { GridTabGroup } from "./GridTabGroup";
import { GridFullOverlay } from "./GridFullOverlay";
import { OverflowStatusStrip } from "./OverflowStatusStrip";
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

  return (
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
          <GridShell ctx={ctx} showTerminalCountWarning={false} className="relative h-full min-h-0">
            <div
              ref={bindCombinedGrid}
              className={cn(
                "h-full bg-noise p-1",
                ctx.isOver && "ring-2 ring-daintree-accent/30 ring-inset"
              )}
              style={{
                display: "grid",
                gridTemplateColumns: `repeat(${ctx.gridCols}, minmax(min(100%, ${MIN_TERMINAL_WIDTH_PX}px), 1fr))`,
                gridAutoRows: `minmax(${MIN_TERMINAL_HEIGHT_PX}px, 1fr)`,
                gap: "4px",
                backgroundColor: "var(--color-grid-bg)",
                overflowY: "auto",
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
                  {ctx.visibleTabGroups.map((group, index) => {
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
                            gridPanelCount={ctx.gridItemCount}
                            gridCols={ctx.gridCols}
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
                            gridPanelCount={ctx.gridItemCount}
                            gridCols={ctx.gridCols}
                          />
                        </SortableTerminal>
                      );
                    }

                    return elements;
                  })}
                  {ctx.showPlaceholder &&
                    ctx.placeholderInGrid &&
                    ctx.placeholderIndex === ctx.visibleTabGroups.length && (
                      <SortableGridPlaceholder key={GRID_PLACEHOLDER_ID} />
                    )}
                </LayoutGroup>
              )}
            </div>
          </GridShell>
        </SortableContext>

        <GridFullOverlay maxTerminals={ctx.maxGridCapacity} show={ctx.showGridFullOverlay} />
      </div>
      <OverflowStatusStrip groups={ctx.overflowTabGroups} />
    </div>
  );
}
