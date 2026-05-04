import { useContentGridContext, type ContentGridProps } from "./useContentGridContext";
import { ContentGridFleetScope } from "./ContentGridFleetScope";
import { ContentGridMaximizedGroup } from "./ContentGridMaximizedGroup";
import { ContentGridMaximizedSingle } from "./ContentGridMaximizedSingle";
import { ContentGridTwoPaneSplit } from "./ContentGridTwoPaneSplit";
import { ContentGridDefault } from "./ContentGridDefault";

export type { ContentGridProps } from "./useContentGridContext";

export function ContentGrid({
  className,
  defaultCwd,
  agentAvailability,
  emptyContent,
}: ContentGridProps) {
  "use memo";

  const ctx = useContentGridContext({
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
    return <ContentGridFleetScope ctx={ctx} className={className} />;
  }

  // Maximized terminal or group takes full screen
  if (ctx.maximizedId && ctx.maximizeTarget) {
    if (ctx.maximizeTarget.type === "group") {
      const group = ctx.maximizedGroup;
      const groupPanels = ctx.maximizedGroupPanels;
      if (group && groupPanels.length > 0) {
        return <ContentGridMaximizedGroup ctx={ctx} className={className} />;
      }
      return null;
    } else {
      const terminal = ctx.gridTerminals.find((t) => t.id === ctx.maximizedId);
      if (terminal) {
        return <ContentGridMaximizedSingle ctx={ctx} className={className} />;
      }
      return null;
    }
  }

  if (ctx.useTwoPaneSplitMode && ctx.twoPaneTerminals) {
    return <ContentGridTwoPaneSplit ctx={ctx} className={className} />;
  }

  return <ContentGridDefault ctx={ctx} className={className} />;
}
