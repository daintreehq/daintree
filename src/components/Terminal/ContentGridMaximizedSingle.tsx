import { cn } from "@/lib/utils";
import { GridNotificationBar } from "./GridNotificationBar";
import { GridPanel } from "./GridPanel";
import type { ContentGridContext } from "./useContentGridContext";

export function ContentGridMaximizedSingle({
  ctx,
  bindGridRegion,
  className,
}: {
  ctx: ContentGridContext;
  bindGridRegion: (node: HTMLDivElement | null) => void;
  className?: string;
}) {
  "use memo";

  const maximizedId = ctx.maximizedId;
  if (!maximizedId) return null;

  return (
    <div
      ref={bindGridRegion}
      role="region"
      tabIndex={-1}
      aria-label="Content"
      data-macro-focus={ctx.isMacroFocused ? "true" : undefined}
      onKeyDown={ctx.handleGridRegionKeyDown}
      className={cn(
        "h-full flex flex-col bg-daintree-bg outline-hidden",
        "data-[macro-focus=true]:ring-2 data-[macro-focus=true]:ring-border-default data-[macro-focus=true]:ring-inset",
        className
      )}
    >
      <GridNotificationBar className="mx-1 mt-1 shrink-0" />
      <div className="relative min-h-0 flex-1">
        <GridPanel
          terminalId={maximizedId}
          isFocused={true}
          isMaximized={true}
          isMultiPanelGrid={ctx.gridItemCount > 1}
        />
      </div>
    </div>
  );
}
