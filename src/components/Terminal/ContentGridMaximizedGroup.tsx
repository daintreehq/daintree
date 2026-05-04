import { cn } from "@/lib/utils";
import { GridNotificationBar } from "./GridNotificationBar";
import { GridTabGroup } from "./GridTabGroup";
import type { ContentGridContext } from "./useContentGridContext";

export function ContentGridMaximizedGroup({
  ctx,
  className,
}: {
  ctx: ContentGridContext;
  className?: string;
}) {
  "use memo";

  const group = ctx.maximizedGroup;
  const groupPanels = ctx.maximizedGroupPanels;
  if (!group || groupPanels.length === 0) return null;

  const effectiveFocusedId = ctx.maximizedGroupFocusTarget ?? ctx.focusedId;

  return (
    <div
      ref={ctx.gridRegionRef}
      role="region"
      tabIndex={-1}
      aria-label="Panel grid region"
      data-macro-focus={ctx.isMacroFocused ? "true" : undefined}
      onKeyDown={ctx.handleGridRegionKeyDown}
      className={cn(
        "h-full flex flex-col bg-daintree-bg outline-hidden",
        "data-[macro-focus=true]:ring-2 data-[macro-focus=true]:ring-daintree-accent/60 data-[macro-focus=true]:ring-inset",
        className
      )}
    >
      <GridNotificationBar className="mx-1 mt-1 shrink-0" />
      <div className="relative min-h-0 flex-1">
        <GridTabGroup
          group={group}
          panels={groupPanels}
          focusedId={effectiveFocusedId}
          gridPanelCount={1}
          gridCols={1}
          isMaximized={true}
        />
      </div>
    </div>
  );
}
