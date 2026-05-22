import { AnimatePresence, LayoutGroup, m } from "framer-motion";
import { cn } from "@/lib/utils";
import { MIN_TERMINAL_HEIGHT_PX, MIN_TERMINAL_WIDTH_PX } from "@/lib/terminalLayout";
import { GridNotificationBar } from "./GridNotificationBar";
import { GridPanel } from "./GridPanel";
import { GridShell } from "./GridShell";
import { ContentGridEmptyState } from "./ContentGridEmptyState";
import { pixelSnapTransform, type ContentGridContext } from "./useContentGridContext";

export function ContentGridFleetScope({
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
      key="fleet-scope-mode"
      ref={bindGridRegion}
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
          ref={bindCombinedGrid}
          className="h-full bg-noise p-1"
          style={{
            display: "grid",
            gridTemplateColumns: `repeat(${ctx.fleetGridCols}, minmax(min(100%, ${MIN_TERMINAL_WIDTH_PX}px), 1fr))`,
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
                        terminalId={terminal.id}
                        isFocused={terminal.id === ctx.focusedId}
                        isMultiPanelGrid={ctx.fleetPanels.length > 1}
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
