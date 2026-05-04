import { AnimatePresence, LayoutGroup, m } from "framer-motion";
import { cn } from "@/lib/utils";
import { MIN_TERMINAL_HEIGHT_PX } from "@/lib/terminalLayout";
import { GridNotificationBar } from "./GridNotificationBar";
import { GridPanel } from "./GridPanel";
import { GridShell } from "./GridShell";
import { ContentGridEmptyState } from "./ContentGridEmptyState";
import { pixelSnapTransform, type ContentGridContext } from "./useContentGridContext";

export function ContentGridFleetScope({
  ctx,
  className,
}: {
  ctx: ContentGridContext;
  className?: string;
}) {
  "use memo";

  return (
    <div
      key="fleet-scope-mode"
      ref={ctx.gridRegionRef}
      role="region"
      tabIndex={-1}
      aria-label="Fleet scope grid"
      data-fleet-scope="true"
      data-macro-focus={ctx.isMacroFocused ? "true" : undefined}
      onKeyDown={ctx.handleGridRegionKeyDown}
      className={cn(
        "h-full flex flex-col outline-hidden",
        "data-[macro-focus=true]:ring-2 data-[macro-focus=true]:ring-daintree-accent/60 data-[macro-focus=true]:ring-inset",
        className
      )}
    >
      <GridNotificationBar className="mx-1 mt-1 shrink-0" />
      <GridShell ctx={ctx}>
        <div
          ref={ctx.combinedGridRef}
          className="h-full bg-noise p-1"
          style={{
            display: "grid",
            gridTemplateColumns: `repeat(${ctx.fleetGridCols}, minmax(0, 1fr))`,
            gridAutoRows: `minmax(${MIN_TERMINAL_HEIGHT_PX}px, 1fr)`,
            gap: "4px",
            backgroundColor: "var(--color-grid-bg)",
            overflowY: "auto",
          }}
          id="panel-grid"
          data-grid-container="true"
        >
          {ctx.fleetPanels.length === 0 ? (
            <div className="col-span-full row-span-full">
              <ContentGridEmptyState
                hasActiveWorktree={ctx.hasActiveWorktree}
                activeWorktreeName={ctx.activeWorktreeName}
                activeWorktreeId={ctx.activeWorktreeId}
                showProjectPulse={ctx.showProjectPulse}
                projectIconSvg={ctx.projectIconSvg}
                defaultCwd={ctx.defaultCwd}
              />
            </div>
          ) : (
            <LayoutGroup id="fleet-grid">
              <AnimatePresence initial={false}>
                {ctx.fleetPanels.map((terminal) => {
                  let titleOverride: string | undefined;
                  if (ctx.fleetNeedsWorktreePrefix) {
                    const worktreeId = terminal.worktreeId ?? null;
                    const worktree = worktreeId ? ctx.worktreeMap.get(worktreeId) : null;
                    const prefix = worktree
                      ? worktree.isMainWorktree
                        ? worktree.name?.trim() || worktree.branch?.trim() || "Unknown Worktree"
                        : worktree.branch?.trim() || worktree.name?.trim() || "Unknown Worktree"
                      : null;
                    if (prefix) {
                      titleOverride = `${prefix} — ${terminal.title}`;
                    }
                  }
                  return (
                    <m.div
                      key={terminal.id}
                      layout="position"
                      transition={ctx.layoutTransition}
                      transformTemplate={pixelSnapTransform}
                      className="h-full min-w-0"
                    >
                      <GridPanel
                        terminal={terminal}
                        isFocused={terminal.id === ctx.focusedId}
                        gridPanelCount={ctx.fleetPanels.length}
                        gridCols={ctx.fleetGridCols}
                        isFleetScope
                        titleOverride={titleOverride}
                      />
                    </m.div>
                  );
                })}
              </AnimatePresence>
            </LayoutGroup>
          )}
        </div>
      </GridShell>
    </div>
  );
}
