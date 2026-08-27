import { Layers } from "lucide-react";
import { isPtyPanel, type PanelInstance } from "@shared/types/panel";
import { PlaceholderContent } from "./PlaceholderContent";
import { deriveTerminalChrome } from "@/utils/terminalChrome";
import { getTerminalAgentDisplayState } from "@/utils/terminalAgentDisplayState";
import {
  getEffectiveStateIcon,
  getEffectiveStateColor,
} from "@/components/Worktree/terminalStateConfig";
import { cn } from "@/lib/utils";

interface TerminalDragPreviewProps {
  terminal: PanelInstance;
  /** Number of tabs if dragging a multi-tab group */
  groupTabCount?: number;
}

// Fixed dimensions of the drag ghost. Exported so the DragOverlay cursor
// modifier can center on the preview's real size — the overlay wrapper rect
// reflects the dragged panel's (much larger) dimensions, not this box.
export const TERMINAL_DRAG_PREVIEW_WIDTH = 240;
export const TERMINAL_DRAG_PREVIEW_HEIGHT = 140;

export function TerminalDragPreview({ terminal, groupTabCount }: TerminalDragPreviewProps) {
  // Drag visual color mirrors the same chrome descriptor used by tabs/panels.
  const chrome = deriveTerminalChrome(terminal);
  const brandColor = chrome.color;
  const agentState = isPtyPanel(terminal) ? terminal.agentState : undefined;
  const displayAgentState = getTerminalAgentDisplayState(chrome, agentState);
  const StateIcon = displayAgentState ? getEffectiveStateIcon(displayAgentState) : null;
  const isGroupDrag = (groupTabCount ?? 0) > 1;

  return (
    <div
      style={{
        width: TERMINAL_DRAG_PREVIEW_WIDTH,
        height: TERMINAL_DRAG_PREVIEW_HEIGHT,
        backgroundColor: "var(--color-daintree-sidebar)",
        border: "1px solid var(--color-daintree-border)",
        borderRadius: "var(--radius-lg)",
        boxShadow: "var(--theme-shadow-floating)",
        overflow: "visible",
        display: "flex",
        flexDirection: "column",
        position: "relative",
      }}
    >
      {/* Group tab count badge */}
      {isGroupDrag && (
        <div
          style={{
            position: "absolute",
            top: -8,
            right: -8,
            backgroundColor: "var(--color-daintree-text)",
            color: "var(--color-daintree-bg)",
            borderRadius: "9999px",
            padding: "2px 6px",
            fontSize: "var(--text-3xs)",
            fontWeight: 600,
            display: "flex",
            alignItems: "center",
            gap: 3,
            boxShadow: "var(--theme-shadow-ambient)",
            fontVariantNumeric: "tabular-nums",
            zIndex: 10,
          }}
        >
          <Layers style={{ width: 10, height: 10 }} aria-hidden="true" />
          <span>{groupTabCount}</span>
        </div>
      )}
      {/* Title bar */}
      <div
        style={{
          height: 24,
          padding: "0 8px",
          backgroundColor: "var(--color-daintree-border)",
          borderBottom: "1px solid var(--color-surface-highlight)",
          display: "flex",
          alignItems: "center",
          gap: 6,
          flexShrink: 0,
        }}
      >
        {/* Icon */}
        <div
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            backgroundColor: brandColor || "var(--color-daintree-text)",
            flexShrink: 0,
          }}
        />

        {/* Title text */}
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-2xs)",
            fontWeight: 500,
            color: "var(--color-daintree-text)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            flex: 1,
          }}
        >
          {terminal.title}
        </span>

        {StateIcon && displayAgentState && (
          <StateIcon
            className={cn(
              "w-3 h-3 shrink-0",
              getEffectiveStateColor(displayAgentState),
              displayAgentState === "working" && "animate-spin-slow",
              "motion-reduce:animate-none"
            )}
            aria-hidden="true"
          />
        )}
      </div>

      {/* Panel body (ghost content) */}
      <div
        style={{
          flex: 1,
          padding: 8,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <PlaceholderContent
          kind={terminal.kind ?? "terminal"}
          agentId={chrome.agentId ?? undefined}
        />
      </div>
    </div>
  );
}
