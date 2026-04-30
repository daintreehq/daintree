import { Loader2, Layers } from "lucide-react";
import type { TerminalInstance } from "@/store";
import { PlaceholderContent } from "./PlaceholderContent";
import { deriveTerminalChrome } from "@/utils/terminalChrome";

interface TerminalDragPreviewProps {
  terminal: TerminalInstance;
  /** Number of tabs if dragging a multi-tab group */
  groupTabCount?: number;
}

export function TerminalDragPreview({ terminal, groupTabCount }: TerminalDragPreviewProps) {
  // Drag visual color mirrors the same chrome descriptor used by tabs/panels.
  const chrome = deriveTerminalChrome(terminal);
  const brandColor = chrome.color;
  const isWorking = chrome.isAgent && terminal.agentState === "working";
  const isGroupDrag = (groupTabCount ?? 0) > 1;

  return (
    <div
      style={{
        width: 240,
        height: 140,
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
            backgroundColor: "var(--color-daintree-accent)",
            color: "var(--color-daintree-bg)",
            borderRadius: "9999px",
            padding: "2px 6px",
            fontSize: 10,
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
            fontSize: 11,
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
        <PlaceholderContent
          kind={terminal.kind ?? "terminal"}
          agentId={chrome.agentId ?? undefined}
        />
      </div>
    </div>
  );
}
