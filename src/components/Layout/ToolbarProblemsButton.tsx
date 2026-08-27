import { Button } from "@/components/ui/button";
import { AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { createTooltipContent } from "@/lib/tooltipShortcut";
import { useAriaKeyshortcuts, useKeybindingDisplay, useShortcutHintHover } from "@/hooks";
import { useDiagnosticsStore } from "@/store/diagnosticsStore";
import { ToolbarContextMenuItems } from "./ToolbarContextMenuItems";
import { DIAGNOSTICS_DOCK_REGION_ID } from "@/components/Diagnostics/regionIds";

const toolbarIconButtonClass = "toolbar-icon-button text-text-primary";

interface ToolbarProblemsButtonProps {
  errorCount: number;
  /**
   * True while the project's recursive file watcher is degraded to the
   * polling/git-only fallback (ENOSPC/EMFILE). Surfaces a persistent Tier-1
   * warning pip that clears automatically when the watcher recovers.
   */
  watcherDegraded?: boolean;
  /**
   * True while the topology watcher is "dark" — it stopped reporting worktree
   * create/delete events, so the worktree list may be stale (#9908). Shares the
   * same Tier-1 pip as `watcherDegraded` (logical OR); both mean file watching
   * is unreliable and resolve via the same Problems area.
   */
  topologyWatcherDark?: boolean;
  onToggleProblems?: () => void;
  "data-toolbar-item"?: string;
}

export function ToolbarProblemsButton({
  errorCount,
  watcherDegraded = false,
  topologyWatcherDark = false,
  onToggleProblems,
  "data-toolbar-item": dataToolbarItem,
}: ToolbarProblemsButtonProps) {
  const watcherUnreliable = watcherDegraded || topologyWatcherDark;
  // Prefer the more specific phrasing when only the topology watcher is dark;
  // ENOSPC/EMFILE degradation takes precedence when both are set.
  const watcherAriaSuffix = watcherDegraded
    ? ", file watching degraded"
    : topologyWatcherDark
      ? ", worktree list may be stale"
      : "";
  const diagnosticsShortcut = useKeybindingDisplay("panel.toggleDiagnostics");
  const diagnosticsAriaShortcut = useAriaKeyshortcuts("panel.toggleDiagnostics");
  const diagnosticsHover = useShortcutHintHover("panel.toggleDiagnostics");
  const isDockOpen = useDiagnosticsStore((state) => state.isOpen);

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
              aria-label={`Problems: ${errorCount} error${errorCount !== 1 ? "s" : ""}${watcherAriaSuffix}`}
              aria-keyshortcuts={diagnosticsAriaShortcut}
              aria-expanded={isDockOpen}
              aria-controls={DIAGNOSTICS_DOCK_REGION_ID}
            >
              <AlertCircle />
              <span
                data-visible={errorCount > 0}
                className="toolbar-problems-badge toolbar-badge absolute top-1.5 right-1.5 w-2 h-2 rounded-full"
              />
              {/* Persistent watcher-unreliable pip. 6px + ring-surface-sidebar
                  per the toolbar pip vocabulary (semantic-status dot); pinned
                  to the opposite corner so it never collides with the 8px
                  error badge when both are visible. Shared by recursive-watcher
                  degradation and topology-watcher-dark — both mean file
                  watching is unreliable. */}
              <span
                data-testid="watcher-degraded-badge"
                data-visible={watcherUnreliable}
                className="toolbar-badge absolute bottom-1.5 right-1.5 w-1.5 h-1.5 rounded-full bg-status-warning ring-1 ring-surface-sidebar"
              />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {createTooltipContent("Show problems panel", diagnosticsShortcut)}
          </TooltipContent>
        </Tooltip>
      </ContextMenuTrigger>
      <ContextMenuContent className="max-h-[var(--radix-context-menu-content-available-height)] overflow-y-auto">
        <ToolbarContextMenuItems buttonId="problems" side="right" />
      </ContextMenuContent>
    </ContextMenu>
  );
}
