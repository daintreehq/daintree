import React from "react";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import { TerminalCountWarning } from "./TerminalCountWarning";
import type { ContentGridContext } from "./useContentGridContext";

// GridShell provides the shared ContextMenu + TerminalCountWarning scaffolding
// used by the fleet scope, two-pane split, and default grid branches.
// The `combinedGridRef` is NOT applied here — each branch attaches it on its
// own inner div to preserve exact ResizeObserver-dimension behavior.
export function GridShell({
  ctx,
  children,
  showTerminalCountWarning = true,
  className,
}: {
  ctx: ContentGridContext;
  children: React.ReactNode;
  showTerminalCountWarning?: boolean;
  className?: string;
}) {
  "use memo";

  return (
    <>
      {showTerminalCountWarning && <TerminalCountWarning className="mx-1 mt-1 shrink-0" />}
      <div className={className ?? "relative flex-1 min-h-0"}>
        <ContextMenu>
          <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
          {ctx.gridContextMenuContent}
        </ContextMenu>
      </div>
    </>
  );
}
