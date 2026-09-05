import { ProjectPluginTrustBanner } from "@/components/Plugin/ProjectPluginTrustBanner";
import { cn } from "@/lib/utils";
import { GridNotificationBar } from "./GridNotificationBar";
import { BatchScrollbackRestoreBar } from "./BatchScrollbackRestoreBar";
import { TwoPaneSplitLayout } from "./TwoPaneSplitLayout";
import { GridShell } from "./GridShell";
import type { ContentGridContext } from "./useContentGridContext";

export function ContentGridTwoPaneSplit({
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

  if (!ctx.twoPaneTerminals) return null;

  return (
    <div
      key="split-mode"
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
      <BatchScrollbackRestoreBar className="mx-1 mt-1 shrink-0" />
      <GridShell ctx={ctx}>
        <div
          ref={bindCombinedGrid}
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
            onAddTabForPanel={ctx.handleAddTabForPanel}
          />
        </div>
      </GridShell>
    </div>
  );
}
