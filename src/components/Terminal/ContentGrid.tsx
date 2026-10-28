import { useProjectSurface } from "@/components/Plugin/ProjectSurfaceView";
import { cn } from "@/lib/utils";
import {
  applicationDefaultRoute,
  selectProjectMainAreaRoute,
  useProjectHomeStore,
} from "@/store/projectHomeStore";
import { useProjectPluginStore } from "@/store/projectPluginStore";
import { useContentGridContext, type ContentGridProps } from "./useContentGridContext";
import { ContentGridFleetScope } from "./ContentGridFleetScope";
import { ContentGridMaximizedGroup } from "./ContentGridMaximizedGroup";
import { ContentGridMaximizedSingle } from "./ContentGridMaximizedSingle";
import { ContentGridDefault } from "./ContentGridDefault";
import { ContentGridProjectHome } from "./ContentGridProjectHome";
import { ProjectHomeNav } from "./ProjectHomeNav";

export type { ContentGridProps } from "./useContentGridContext";

export function ContentGrid({
  className,
  defaultCwd,
  agentAvailability,
  emptyContent,
}: ContentGridProps) {
  "use memo";

  const { ctx, bindCombinedGrid, bindGridRegion } = useContentGridContext({
    className,
    defaultCwd,
    agentAvailability,
    emptyContent,
  });
  // `null` unless a project plugin's Home can show and the user hasn't chosen
  // to have none, so a route left on Home in a project whose plugin is gone
  // draws the grid instead of a blank.
  const homeSurface = useProjectSurface("projectHome");
  // A route the user chose wins; a project they never chose one in opens where
  // its application asks to (#14107).
  const fallbackRoute = useProjectPluginStore((s) => applicationDefaultRoute(s.application));
  const route = useProjectHomeStore((s) => selectProjectMainAreaRoute(s, fallbackRoute));
  const showsHome = homeSurface !== null && route !== "grid";
  const isSplit = showsHome && route === "split";

  // Fleet scope render path: a flat grid of armed terminals from every
  // worktree, each input-locked with a broadcast overlay. Deliberately
  // placed before the maximize branch — a maximize captured against a
  // different worktree must not shadow the fleet view. DnD, two-pane, and
  // tab-group logic are bypassed entirely; the armed set is the source of
  // truth for both membership and order.
  if (ctx.isFleetScopeRender) {
    return (
      <ContentGridFleetScope
        ctx={ctx}
        bindCombinedGrid={bindCombinedGrid}
        bindGridRegion={bindGridRegion}
        className={className}
      />
    );
  }

  const isMaximized = Boolean(ctx.maximizedId && ctx.maximizeTarget);
  const renderMaximized = (maximizedClassName: string | undefined) => {
    if (ctx.maximizeTarget?.type === "group") {
      if (!ctx.maximizedGroup || ctx.maximizedGroupPanels.length === 0) return null;
      return (
        <ContentGridMaximizedGroup
          ctx={ctx}
          bindGridRegion={bindGridRegion}
          className={maximizedClassName}
        />
      );
    }
    if (!ctx.gridTerminals.some((t) => t.id === ctx.maximizedId)) return null;
    return (
      <ContentGridMaximizedSingle
        ctx={ctx}
        bindGridRegion={bindGridRegion}
        className={maximizedClassName}
      />
    );
  };

  // Maximized terminal or group takes full screen, except in a split, where it
  // fills only the panels' side and the application stays in view.
  if (isMaximized && !isSplit) return renderMaximized(className);

  // Home, the grid and the split between them share one wrapper, whether or
  // not this project has a Home, so a claim arriving after the first render
  // (or the user choosing no Home) adds or drops the switch without remounting
  // the grid under it. Home and the panels are keyed siblings of one row, so
  // going from Home to the split keeps the application's view mounted, and
  // from the grid to the split keeps every panel mounted.
  return (
    <div className={cn("flex flex-col", className)}>
      {homeSurface !== null && <ProjectHomeNav route={route} />}
      <div className="@container/main-area min-h-0 flex-1">
        <div
          className={cn(
            "flex h-full min-h-0",
            // Too narrow for the application and a terminal side by side
            // (twice MIN_TERMINAL_WIDTH_PX), the split stacks them instead, so
            // neither is ever hidden behind the other.
            "@max-[800px]/main-area:flex-col"
          )}
          data-main-area-route={showsHome ? route : "grid"}
        >
          {showsHome && (
            <ContentGridProjectHome
              key="home"
              config={homeSurface.config}
              beside={isSplit}
              isMacroFocused={ctx.isMacroFocused}
              bindGridRegion={bindGridRegion}
              className="min-h-0 min-w-0 flex-1 basis-0"
            />
          )}
          {!(showsHome && !isSplit) && (
            <div
              key="grid"
              className={cn(
                "min-h-0 min-w-0 flex-1 basis-0",
                isSplit &&
                  "border-l border-divider @max-[800px]/main-area:border-t @max-[800px]/main-area:border-l-0"
              )}
            >
              {isMaximized ? (
                renderMaximized("h-full w-full")
              ) : (
                // Also renders the two-pane split, so crossing that boundary resizes
                // the surviving panels instead of remounting them (#12476).
                <ContentGridDefault
                  ctx={ctx}
                  bindCombinedGrid={bindCombinedGrid}
                  bindGridRegion={bindGridRegion}
                  className="w-full"
                />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
