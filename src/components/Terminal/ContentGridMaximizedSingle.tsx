import { cn } from "@/lib/utils";
import { GridNotificationBar } from "./GridNotificationBar";
import { GridPanel } from "./GridPanel";
import type { ContentGridContext } from "./useContentGridContext";

export function ContentGridMaximizedSingle({
  ctx,
  className,
}: {
  ctx: ContentGridContext;
  className?: string;
}) {
  "use memo";

  const terminal = ctx.gridTerminals.find((t) => t.id === ctx.maximizedId);
  if (!terminal) return null;

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
        <GridPanel
          terminal={terminal}
          isFocused={true}
          isMaximized={true}
          gridPanelCount={ctx.gridItemCount}
        />
      </div>
    </div>
  );
}
