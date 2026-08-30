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
        {/* Being the only pane on screen is not the same as owning the keyboard:
            while a dock popover is open, focus belongs to the dock pane. Pinning
            this to `true` meant the prop never changed on the way back, so the
            pane never re-claimed DOM focus when the popover closed (#11133). */}
        <GridPanel
          terminalId={maximizedId}
          isFocused={ctx.focusedId === maximizedId}
          isMaximized={true}
          isMultiPanelGrid={ctx.gridItemCount > 1}
        />
      </div>
    </div>
  );
}
