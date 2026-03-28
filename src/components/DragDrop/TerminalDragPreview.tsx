import { Loader2, Layers } from "lucide-react";
import type { TerminalInstance } from "@/store";
import { PlaceholderContent } from "./PlaceholderContent";
import { getPanelKindColor } from "@shared/config/panelKindRegistry";

interface TerminalDragPreviewProps {
  terminal: TerminalInstance;
  /** Number of tabs if dragging a multi-tab group */
  groupTabCount?: number;
}

export function TerminalDragPreview({ terminal, groupTabCount }: TerminalDragPreviewProps) {
  const brandColor = getPanelKindColor(terminal.kind ?? "terminal", terminal.agentId);
  const isWorking = terminal.agentState === "working";
  const isGroupDrag = (groupTabCount ?? 0) > 1;

  return (
    <div
      style={{
        width: 240,
        height: 140,
        backgroundColor: "var(--color-canopy-sidebar)",
        border: "1px solid var(--color-canopy-border)",
        borderRadius: "var(--radius-lg)",
        boxShadow: "0 8px 24px rgba(0, 0, 0, 0.6)",
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
            backgroundColor: "var(--color-canopy-accent)",
            color: "var(--color-canopy-bg)",
            borderRadius: "9999px",
            padding: "2px 6px",
            fontSize: 10,
            fontWeight: 600,
            display: "flex",
            alignItems: "center",
            gap: 3,
            boxShadow: "0 2px 8px rgba(0, 0, 0, 0.4)",
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
          backgroundColor: "var(--color-canopy-border)",
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
            backgroundColor: brandColor || "var(--color-canopy-text)",
            flexShrink: 0,
          }}
        />

        {/* Title text */}
        <span
          style={{
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: 11,
            fontWeight: 500,
            color: "var(--color-canopy-text)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            flex: 1,
          }}
        >
          {terminal.title}
        </span>

        {/* Working indicator */}
        {isWorking && (
          <Loader2
            className="w-3 h-3 animate-spin motion-reduce:animate-none"
            style={{ color: brandColor }}
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
        <PlaceholderContent kind={terminal.kind ?? "terminal"} agentId={terminal.agentId} />
      </div>
    </div>
  );
}
