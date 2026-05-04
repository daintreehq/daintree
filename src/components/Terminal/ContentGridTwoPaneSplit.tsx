import { cn } from "@/lib/utils";
import { GridNotificationBar } from "./GridNotificationBar";
import { GridFullOverlay } from "./GridFullOverlay";
import { TwoPaneSplitLayout } from "./TwoPaneSplitLayout";
import { GridShell } from "./GridShell";
import type { ContentGridContext } from "./useContentGridContext";

export function ContentGridTwoPaneSplit({
  ctx,
  className,
}: {
  ctx: ContentGridContext;
  className?: string;
}) {
  "use memo";

  if (!ctx.twoPaneTerminals) return null;

  return (
    <div
      key="split-mode"
      ref={ctx.gridRegionRef}
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
      <GridShell ctx={ctx}>
        <div
          ref={ctx.combinedGridRef}
          className={cn(
            "relative h-full min-h-0",
            ctx.isOver && "ring-2 ring-daintree-accent/30 ring-inset"
          )}
        >
          <TwoPaneSplitLayout
            terminals={ctx.twoPaneTerminals}
            focusedId={ctx.focusedId}
            activeWorktreeId={ctx.activeWorktreeId}
            isInTrash={ctx.isInTrash}
            onAddTabLeft={() => ctx.handleAddTabForPanel(ctx.twoPaneTerminals![0])}
            onAddTabRight={() => ctx.handleAddTabForPanel(ctx.twoPaneTerminals![1])}
          />
          <GridFullOverlay maxTerminals={ctx.maxGridCapacity} show={ctx.showGridFullOverlay} />
        </div>
      </GridShell>
    </div>
  );
}
