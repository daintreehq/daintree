import { useContentGridContext, type ContentGridProps } from "./useContentGridContext";
import { ContentGridFleetScope } from "./ContentGridFleetScope";
import { ContentGridMaximizedGroup } from "./ContentGridMaximizedGroup";
import { ContentGridMaximizedSingle } from "./ContentGridMaximizedSingle";
import { ContentGridDefault } from "./ContentGridDefault";

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

  // Also renders the two-pane split, so crossing that boundary resizes the
  // surviving panels instead of remounting them (#12476).
  return (
    <ContentGridDefault
      ctx={ctx}
      bindCombinedGrid={bindCombinedGrid}
      bindGridRegion={bindGridRegion}
      className={className}
    />
  );
}
