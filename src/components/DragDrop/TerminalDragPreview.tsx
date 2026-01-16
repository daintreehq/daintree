import { Loader2 } from "lucide-react";
import type { TerminalInstance } from "@/store";
import { PlaceholderContent } from "./PlaceholderContent";
import { getPanelKindColor } from "@shared/config/panelKindRegistry";

interface TerminalDragPreviewProps {
  terminal: TerminalInstance;
}

export function TerminalDragPreview({ terminal }: TerminalDragPreviewProps) {
  const brandColor = getPanelKindColor(terminal.kind ?? "terminal", terminal.agentId);
  const isWorking = terminal.agentState === "working";

  return (
    <div
      className="pointer-events-none select-none"
      style={{
        width: 160,
        height: 100,
        backgroundColor: "var(--color-canopy-bg)",
        border: "1px solid var(--color-canopy-border)",
        borderRadius: "var(--radius-lg)",
        boxShadow: "0 8px 24px rgba(0, 0, 0, 0.6)",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
      }}
    >
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
            className="w-3 h-3 animate-spin"
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
