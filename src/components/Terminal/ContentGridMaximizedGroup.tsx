import { cn } from "@/lib/utils";
import { GridNotificationBar } from "./GridNotificationBar";
import { GridTabGroup } from "./GridTabGroup";
import type { ContentGridContext } from "./useContentGridContext";

export function ContentGridMaximizedGroup({
  ctx,
  bindGridRegion,
  className,
}: {
  ctx: ContentGridContext;
  bindGridRegion: (node: HTMLDivElement | null) => void;
  className?: string;
}) {
  "use memo";

  const group = ctx.maximizedGroup;
  const groupPanels = ctx.maximizedGroupPanels;
  if (!group || groupPanels.length === 0) return null;

  const effectiveFocusedId = ctx.maximizedGroupFocusTarget ?? ctx.focusedId;

  return (
    <div
      ref={bindGridRegion}
      role="region"
      tabIndex={-1}
      aria-label="Panels"
      data-macro-focus={ctx.isMacroFocused ? "true" : undefined}
      onKeyDown={ctx.handleGridRegionKeyDown}
      className={cn(
        "h-full flex flex-col bg-surface-canvas outline-hidden",
        "data-[macro-focus=true]:ring-2 data-[macro-focus=true]:ring-border-default data-[macro-focus=true]:ring-inset",
        className
      )}
    >
      <GridNotificationBar className="mx-1 mt-1 shrink-0" />
      <div className="relative min-h-0 flex-1">
        <GridTabGroup
          group={group}
          focusedId={effectiveFocusedId}
          isMultiPanelGrid={false}
          isMaximized={true}
        />
      </div>
    </div>
  );
}
