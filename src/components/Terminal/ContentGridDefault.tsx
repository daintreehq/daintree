import { ProjectPluginTrustBanner } from "@/components/Plugin/ProjectPluginTrustBanner";
import React, { useCallback } from "react";
import { SortableContext, rectSortingStrategy } from "@dnd-kit/sortable";
import { LayoutGroup } from "framer-motion";
import { cn } from "@/lib/utils";
import { GRID_MIN_PANEL_ROWS, MIN_TERMINAL_WIDTH_PX, pxForRows } from "@/lib/terminalLayout";
import { GridNotificationBar } from "./GridNotificationBar";
import { GridPanel } from "./GridPanel";
import { GridTabGroup } from "./GridTabGroup";
import { GridScrollRootContext } from "./GridScrollRootContext";
import {
  SortableTerminal,
  GRID_PLACEHOLDER_ID,
  SortableGridPlaceholder,
} from "@/components/DragDrop";
import { GridShell } from "./GridShell";
import { GridScrollbar, GRID_SCROLLBAR_GUTTER_PX } from "./GridScrollbar";
import { TerminalCountWarning } from "./TerminalCountWarning";
import { BatchScrollbackRestoreBar } from "./BatchScrollbackRestoreBar";
import { ContentGridEmptyState } from "./ContentGridEmptyState";
import { ProjectSurfaceFrame } from "@/components/Plugin/ProjectSurfaceFrame";
import type { ContentGridContext } from "./useContentGridContext";

// Non-scroll row floor: the small minimum a row shrinks to before the grid has
// to scroll. Rows stretch above it (`1fr`) to fill the viewport when there is
// room. Mirrors `gridRowsOverflow`'s per-row minimum so the scroll-mode flip
// lines up exactly with the point this floor would overflow.
const NON_SCROLL_ROW_MIN_PX = pxForRows(GRID_MIN_PANEL_ROWS);

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
  // canonical scroll container for IntersectionObserver and scrollIntoView.
  const { setGridScrollRoot } = ctx;
  const bindGridScrollContainer = useCallback(
    (node: HTMLDivElement | null) => {
      bindCombinedGrid(node);
      setGridScrollRoot(node);
    },
    [bindCombinedGrid, setGridScrollRoot]
  );

  // Everything that can move a grid panel, folded into one key so the FLIP
  // wrappers only re-measure when grid geometry actually changed (see
  // SortableTerminal.layoutDependency).
  const gridLayoutDependency = [
    ctx.gridCols,
    ctx.isScrollMode ? ctx.scrollRowHeight : "fit",
    ctx.maximizedId ?? "",
    ctx.gridWidth ?? 0,
    ctx.showPlaceholder && ctx.placeholderInGrid ? ctx.placeholderIndex : "",
    ctx.tabGroups.map((g) => `${g.id}/${g.panelIds.length}`).join(","),
  ].join("|");

  return (
    <GridScrollRootContext.Provider value={ctx.gridScrollRoot}>
      <div
        key="grid-mode"
        ref={bindGridRegion}
        role="region"
        tabIndex={-1}
        aria-label="Panels"
        data-macro-focus={ctx.isMacroFocused ? "true" : undefined}
        onKeyDown={ctx.handleGridRegionKeyDown}
        className={cn(
          "h-full flex flex-col outline-hidden",
          "data-[macro-focus=true]:ring-2 data-[macro-focus=true]:ring-border-default data-[macro-focus=true]:ring-inset",
          className
        )}
      >
        <GridNotificationBar className="mx-1 mt-1 shrink-0" />
        <ProjectPluginTrustBanner />
        <TerminalCountWarning className="mx-1 mt-1 shrink-0" />
        <BatchScrollbackRestoreBar className="mx-1 mt-1 shrink-0" />
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
                  gridAutoRows: ctx.isScrollMode
                    ? `${ctx.scrollRowHeight}px`
                    : `minmax(${NON_SCROLL_ROW_MIN_PX}px, 1fr)`,
                  gap: "4px",
                  backgroundColor: "var(--color-grid-bg)",
                  overflowX: "hidden",
                  // Scroll mode shows the dedicated grid scrollbar at all
                  // times (`scroll`) so the user can always see the grid
                  // itself scrolls; non-scroll mode only scrolls if a short
                  // window genuinely clips the quad (`auto`).
                  overflowY: ctx.isScrollMode ? "scroll" : "auto",
                  // Prevent Chromium's scroll-anchor algorithm from fighting
                  // framer-motion's `LayoutGroup` layout-projection when panels
                  // are added or removed above the viewport — Chromium 146
                  // reflow would otherwise produce visible stutter (#8805).
                  overflowAnchor: "none",
                  // Stop xterm scrollback / overflow strip-of-history from
                  // chaining into the outer chrome via overscroll bounces.
                  overscrollBehavior: "contain",
                  // Reserve a real gutter on the right, only in scroll mode, so
                  // the custom overlay GridScrollbar never sits over panel
                  // content. Non-scroll mode keeps the symmetric `p-1` (4px) and
                  // reclaims the 22px — an always-on gutter wastes a strip the
                  // width of a mini-column when no bar is shown.
                  //
                  // This does NOT re-open the #10871 oscillation. That loop ran
                  // through the ResizeObserver reading `entry.contentRect`
                  // (content-box, padding-EXCLUSIVE), so toggling this padding
                  // shrank the measured width and fed back into the col/row math.
                  // Two shipped guards make the toggle inert now: (1) all three
                  // measurement paths read `clientWidth`/`clientHeight` — the
                  // padding-box (content + padding), and `#panel-grid` hides its
                  // native scrollbar in CSS (zero width) — so toggling this
                  // padding only reallocates content↔padding inside a fixed box
                  // and leaves the measured dimensions untouched — no feedback;
                  // (2) the scroll-mode boundary itself is a Schmitt trigger
                  // (`gridRowsOverflowWithHysteresis`), so a resize through the
                  // threshold flips at most once per direction. Keep both before
                  // re-narrowing this gutter.
                  paddingRight: ctx.isScrollMode ? GRID_SCROLLBAR_GUTTER_PX : undefined,
                }}
                id="panel-grid"
                data-grid-container="true"
              >
                {ctx.isEmpty && !ctx.showPlaceholder ? (
                  <div className="col-span-full row-span-full">
                    {/*
                      Passthrough unless a project plugin claims this surface
                      (§7.8), in which case it adds the one control that swaps
                      between the plugin's canvas and the host's launcher — so a
                      claimed surface can never strand the user.
                    */}
                    <ProjectSurfaceFrame>
                      {ctx.emptyContent ?? (
                        <ContentGridEmptyState
                          hasLaunchTarget={ctx.hasActiveWorktree}
                          hasProjectContext={ctx.projectName !== null}
                          hasWorktrees={ctx.worktreeMap.size > 0}
                          isWorktreeInitialized={ctx.isWorktreeInitialized}
                          activeWorktreeName={ctx.activeWorktreeName}
                          activeWorktreeId={ctx.activeWorktreeId}
                          activeWorktreeBranch={ctx.activeWorktreeBranch}
                          activeWorktreeIsDetached={ctx.activeWorktreeIsDetached}
                          activeWorktreeHead={ctx.activeWorktreeHead}
                          activeWorktreePath={ctx.activeWorktreePath}
                          workspaceName={ctx.projectName}
                          projectEmoji={ctx.projectEmoji}
                          showProjectPulse={ctx.showProjectPulse}
                          projectIconSvg={ctx.projectIconSvg}
                          defaultCwd={ctx.defaultCwd}
                        />
                      )}
                    </ProjectSurfaceFrame>
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
                            layoutEnabled={ctx.layoutAnimationEnabled}
                            layoutDependency={gridLayoutDependency}
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
                            layoutEnabled={ctx.layoutAnimationEnabled}
                            layoutDependency={gridLayoutDependency}
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
          <GridScrollbar
            scrollRoot={ctx.gridScrollRoot}
            revision={`${ctx.gridItemCount}:${ctx.gridCols}:${ctx.isScrollMode}:${ctx.scrollRowHeight}`}
          />
        </div>
      </div>
    </GridScrollRootContext.Provider>
  );
}
