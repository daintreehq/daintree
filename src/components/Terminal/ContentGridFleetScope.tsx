import { ProjectPluginTrustBanner } from "@/components/Plugin/ProjectPluginTrustBanner";
import { AnimatePresence, LayoutGroup, m } from "framer-motion";
import { cn } from "@/lib/utils";
import { COMFORTABLE_PANEL_HEIGHT_PX, MIN_TERMINAL_WIDTH_PX } from "@/lib/terminalLayout";
import { GridNotificationBar } from "./GridNotificationBar";
import { GridPanel } from "./GridPanel";
import { GridShell } from "./GridShell";
import { ContentGridEmptyState } from "./ContentGridEmptyState";
import { pixelSnapTransform, type ContentGridContext } from "./useContentGridContext";
import { getTerminalDisplayTitle } from "@/utils/terminalTitleDisplay";
import { usePreferencesStore } from "@/store/preferencesStore";

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

  const showAgentTaskTitles = usePreferencesStore((s) => s.showAgentTaskTitles);

  // framer-motion's `layout="position"` snapshots every wrapper via
  // getBoundingClientRect on any commit whose layoutDependency changed — or is
  // undefined. Without a key, every fleet-subtree commit (focus, agent-state,
  // title) forces a per-panel layout read on the same frame the WebGL canvas
  // composites. Derive the key from exactly what moves a fleet panel's box:
  // column count + container width (column widths derive from it, shifting the
  // origin of every non-first column) + the ordered panel-id set. Mirrors
  // ContentGridDefault's gridLayoutDependency, including the gridWidth term.
  const fleetLayoutDependency = [
    ctx.fleetGridCols,
    ctx.gridWidth ?? 0,
    ctx.fleetPanels.map((p) => p.id).join(","),
  ].join("|");

  return (
    <div
      key="fleet-scope-mode"
      ref={bindGridRegion}
      role="region"
      tabIndex={-1}
      aria-label="Panels"
      data-fleet-scope="true"
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
      <GridShell ctx={ctx}>
        <div
          ref={bindCombinedGrid}
          className="h-full bg-noise p-1"
          style={{
            display: "grid",
            gridTemplateColumns: `repeat(${ctx.fleetGridCols}, minmax(min(100%, ${MIN_TERMINAL_WIDTH_PX}px), 1fr))`,
            gridAutoRows: `minmax(${COMFORTABLE_PANEL_HEIGHT_PX}px, 1fr)`,
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
                      titleOverride = `${prefix} — ${getTerminalDisplayTitle(terminal, "full", {
                        showTask: showAgentTaskTitles,
                      })}`;
                    }
                  }
                  return (
                    <m.div
                      key={terminal.id}
                      layout={ctx.layoutAnimationEnabled ? "position" : false}
                      layoutDependency={fleetLayoutDependency}
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
