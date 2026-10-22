import { useProjectSurface } from "@/components/Plugin/ProjectSurfaceView";
import { cn } from "@/lib/utils";
import { selectProjectMainAreaRoute, useProjectHomeStore } from "@/store/projectHomeStore";
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
  const route = useProjectHomeStore(selectProjectMainAreaRoute);

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

  // Maximized terminal or group takes full screen
  if (ctx.maximizedId && ctx.maximizeTarget) {
    if (ctx.maximizeTarget.type === "group") {
      const group = ctx.maximizedGroup;
      const groupPanels = ctx.maximizedGroupPanels;
      if (group && groupPanels.length > 0) {
        return (
          <ContentGridMaximizedGroup
            ctx={ctx}
            bindGridRegion={bindGridRegion}
            className={className}
          />
        );
      }
      return null;
    } else {
      const terminal = ctx.gridTerminals.find((t) => t.id === ctx.maximizedId);
      if (terminal) {
        return (
          <ContentGridMaximizedSingle
            ctx={ctx}
            bindGridRegion={bindGridRegion}
            className={className}
          />
        );
      }
      return null;
    }
  }

  // Home and the grid share one wrapper, whether or not this project has a
  // Home, so a claim arriving after the first render (or the user choosing no
  // Home) adds or drops the switch without remounting the grid under it.
  return (
    <div className={cn("flex flex-col", className)}>
      {homeSurface !== null && <ProjectHomeNav route={route} />}
      <div className="min-h-0 flex-1">
        {homeSurface !== null && route === "home" ? (
          <ContentGridProjectHome
            config={homeSurface.config}
            isMacroFocused={ctx.isMacroFocused}
            bindGridRegion={bindGridRegion}
            className="w-full"
          />
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
    </div>
  );
}
