import { Button } from "@/components/ui/button";
import { AlertCircle, Unplug } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ShortcutRevealChip } from "@/components/ui/ShortcutRevealChip";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { createTooltipContent } from "@/lib/tooltipShortcut";
import { useAriaKeyshortcuts, useKeybindingDisplay, useShortcutHintHover } from "@/hooks";
import { useDiagnosticsStore } from "@/store/diagnosticsStore";
import { useToolbarPreferencesStore } from "@/store/toolbarPreferencesStore";
import { DIAGNOSTICS_DOCK_REGION_ID } from "@/components/Diagnostics/DiagnosticsDock";

const toolbarIconButtonClass = "toolbar-icon-button text-daintree-text";

interface ToolbarProblemsButtonProps {
  errorCount: number;
  /**
   * True while the project's recursive file watcher is degraded to the
   * polling/git-only fallback (ENOSPC/EMFILE). Surfaces a persistent Tier-1
   * warning pip that clears automatically when the watcher recovers.
   */
  watcherDegraded?: boolean;
  onToggleProblems?: () => void;
  "data-toolbar-item"?: string;
}

export function ToolbarProblemsButton({
  errorCount,
  watcherDegraded = false,
  onToggleProblems,
  "data-toolbar-item": dataToolbarItem,
}: ToolbarProblemsButtonProps) {
  const diagnosticsShortcut = useKeybindingDisplay("panel.toggleDiagnostics");
  const diagnosticsAriaShortcut = useAriaKeyshortcuts("panel.toggleDiagnostics");
  const diagnosticsHover = useShortcutHintHover("panel.toggleDiagnostics");
  const isDockOpen = useDiagnosticsStore((state) => state.isOpen);
  const toggleButtonVisibility = useToolbarPreferencesStore((s) => s.toggleButtonVisibility);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              {...diagnosticsHover}
              variant="ghost"
              size="icon"
              data-toolbar-item={dataToolbarItem}
              onClick={onToggleProblems}
              className={cn(toolbarIconButtonClass, "relative")}
              aria-label={`Problems: ${errorCount} error${errorCount !== 1 ? "s" : ""}${
                watcherDegraded ? ", file watching degraded" : ""
              }`}
              aria-keyshortcuts={diagnosticsAriaShortcut}
              aria-expanded={isDockOpen}
              aria-controls={DIAGNOSTICS_DOCK_REGION_ID}
            >
              <AlertCircle />
              <span
                data-visible={errorCount > 0}
                className="toolbar-problems-badge toolbar-badge absolute top-1.5 right-1.5 w-2 h-2 rounded-full"
              />
              {/* Persistent watcher-degraded pip. 6px + ring-daintree-sidebar
                  per the toolbar pip vocabulary (semantic-status dot); pinned
                  to the opposite corner so it never collides with the 8px
                  error badge when both are visible. */}
              <span
                data-testid="watcher-degraded-badge"
                data-visible={watcherDegraded}
                className="toolbar-badge absolute bottom-1.5 right-1.5 w-1.5 h-1.5 rounded-full bg-status-warning ring-1 ring-daintree-sidebar"
              />
              <ShortcutRevealChip actionId="panel.toggleDiagnostics" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {createTooltipContent("Show Problems Panel", diagnosticsShortcut)}
          </TooltipContent>
        </Tooltip>
      </ContextMenuTrigger>
      <ContextMenuContent className="max-h-[var(--radix-context-menu-content-available-height)] overflow-y-auto">
        <ContextMenuItem onSelect={() => toggleButtonVisibility("problems", "right")}>
          <Unplug className="mr-2 h-3.5 w-3.5" />
          Unpin from Toolbar
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
