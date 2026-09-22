import { Layers } from "lucide-react";
import { isPtyPanel, type PanelInstance } from "@shared/types/panel";
import { PlaceholderContent } from "./PlaceholderContent";
import { deriveTerminalChrome } from "@/utils/terminalChrome";
import { getTerminalAgentDisplayState } from "@/utils/terminalAgentDisplayState";
import {
  getEffectiveStateIcon,
  getEffectiveStateColor,
} from "@/components/Worktree/terminalStateConfig";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface TerminalDragPreviewProps {
  terminal: PanelInstance;
  /** Number of tabs if dragging a multi-tab group */
  groupTabCount?: number;
}

// Fixed dimensions of the drag ghost. Exported so the DragOverlay cursor
// modifier can center on the preview's real size — the overlay wrapper rect
// reflects the dragged panel's (much larger) dimensions, not this box. Kept in
// px, not the rem scale, so the modifier and the box can never disagree.
export const TERMINAL_DRAG_PREVIEW_WIDTH = 240;
export const TERMINAL_DRAG_PREVIEW_HEIGHT = 140;

export function TerminalDragPreview({ terminal, groupTabCount }: TerminalDragPreviewProps) {
  // Drag visual color mirrors the same chrome descriptor used by tabs/panels.
  const chrome = deriveTerminalChrome(terminal);
  const agentState = isPtyPanel(terminal) ? terminal.agentState : undefined;
  const displayAgentState = getTerminalAgentDisplayState(chrome, agentState);
  const StateIcon = displayAgentState ? getEffectiveStateIcon(displayAgentState) : null;
  const isGroupDrag = (groupTabCount ?? 0) > 1;

  return (
    <div
      className="relative rounded-lg border border-border-default bg-surface-panel shadow-[var(--theme-shadow-floating)]"
      style={{ width: TERMINAL_DRAG_PREVIEW_WIDTH, height: TERMINAL_DRAG_PREVIEW_HEIGHT }}
    >
      {/* Group tab count. Sits outside the clipping wrapper so it can overhang the corner. */}
      {isGroupDrag && (
        <Badge
          size="xs"
          shape="pill"
          className="absolute -top-2 -right-2 z-10 gap-0.5 bg-text-primary text-surface-canvas shadow-[var(--theme-shadow-ambient)] tabular-nums"
        >
          <Layers aria-hidden="true" />
          <span>{groupTabCount}</span>
        </Badge>
      )}
      <div className="flex h-full flex-col overflow-hidden rounded-lg">
        {/* Title bar — the panel header's own recipe, so the ghost reads as the lifted panel */}
        <div
          className={cn(
            "flex h-8 shrink-0 items-center gap-2 border-b border-border-strong/30 bg-overlay-medium px-3 text-xs",
            // Clear the badge so it never covers the state glyph.
            isGroupDrag && "pr-7"
          )}
        >
          <TerminalIcon kind={terminal.kind} chrome={chrome} className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate font-medium text-text-primary">
            {terminal.title}
          </span>
          {StateIcon && displayAgentState && (
            <StateIcon
              className={cn(
                "h-3 w-3 shrink-0",
                getEffectiveStateColor(displayAgentState),
                displayAgentState === "working" && "animate-spin-slow",
                "motion-reduce:animate-none"
              )}
              aria-hidden="true"
            />
          )}
        </div>

        <div className="flex flex-1 flex-col p-3">
          <PlaceholderContent
            kind={terminal.kind ?? "terminal"}
            agentId={chrome.agentId ?? undefined}
          />
        </div>
      </div>
    </div>
  );
}
