import { Button } from "@/components/ui/button";
import { AlertCircle } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { createTooltipContent } from "@/lib/tooltipShortcut";
import { useAriaKeyshortcuts, useEffectiveCombo, useShortcutHintHover } from "@/hooks";
import { useDiagnosticsStore } from "@/store/diagnosticsStore";
import { ToolbarContextMenuItems } from "./ToolbarContextMenuItems";
import { DIAGNOSTICS_DOCK_REGION_ID } from "@/components/Diagnostics/regionIds";
import { pluralize } from "@/lib/pluralize";
import { toolbarIconButtonClass } from "./toolbarItemClasses";

/** Two characters at most, so the count stays a dot-sized pill. */
function countGlyph(count: number): string {
  return count > 9 ? "9+" : String(count);
}

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
  const watcherStatus = watcherDegraded
    ? "File watching degraded"
    : topologyWatcherDark
      ? "Worktree list may be stale"
      : null;
  const errorSummary = pluralize(errorCount, "error");
  const diagnosticsShortcut = useEffectiveCombo("panel.toggleDiagnostics");
  const diagnosticsAriaShortcut = useAriaKeyshortcuts("panel.toggleDiagnostics");
  const diagnosticsHover = useShortcutHintHover("panel.toggleDiagnostics");
  const isDockOpen = useDiagnosticsStore((state) => state.isOpen);
  // Name the button by what it observes, and say nothing at rest: "0 errors"
  // on every pass through the toolbar is noise.
  const observations = [
    errorCount > 0 ? errorSummary : null,
    watcherStatus ? watcherStatus.toLowerCase() : null,
  ].filter((part): part is string => part !== null);
  const label = observations.length > 0 ? `Problems — ${observations.join(", ")}` : "Problems";

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <span className="inline-flex">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                {...diagnosticsHover}
                variant="ghost"
                size="icon"
                data-toolbar-item={dataToolbarItem}
                onClick={onToggleProblems}
                className={toolbarIconButtonClass}
                aria-label={label}
                aria-keyshortcuts={diagnosticsAriaShortcut}
                aria-expanded={isDockOpen}
                aria-controls={DIAGNOSTICS_DOCK_REGION_ID}
              >
                {/* Anchored to the glyph with the strip's shared pip geometry.
                  The count stands down while the dock is open — the dock is
                  showing the errors — and comes back when it closes. The
                  watcher warning is a separate observation, so it keeps the
                  bottom corner rather than fighting the count for the top. */}
                <span className="relative inline-flex">
                  <AlertCircle />
                  <span
                    aria-hidden="true"
                    data-visible={errorCount > 0 && !isDockOpen}
                    data-badge-color="error"
                    className="toolbar-count toolbar-problems-badge toolbar-badge"
                  >
                    {countGlyph(Math.max(errorCount, 1))}
                  </span>
                  <span
                    aria-hidden="true"
                    data-testid="watcher-degraded-badge"
                    data-visible={watcherUnreliable && !isDockOpen}
                    data-badge-color="warning"
                    data-pip-corner="bottom"
                    className="toolbar-pip toolbar-badge bg-status-warning"
                  />
                </span>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <span className="flex flex-col gap-0.5">
                {createTooltipContent(
                  isDockOpen ? "Hide problems panel" : "Show problems panel",
                  diagnosticsShortcut
                )}
                <span className="text-text-secondary">
                  {errorCount > 0 ? errorSummary : "No errors"}
                </span>
                {watcherStatus && <span className="text-text-secondary">{watcherStatus}</span>}
              </span>
            </TooltipContent>
          </Tooltip>
        </span>
      </ContextMenuTrigger>
      <ContextMenuContent className="max-h-[var(--radix-context-menu-content-available-height)] overflow-y-auto">
        <ToolbarContextMenuItems buttonId="problems" side="right" />
      </ContextMenuContent>
    </ContextMenu>
  );
}
