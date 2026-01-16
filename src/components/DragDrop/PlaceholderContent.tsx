import type { PanelKind } from "@shared/types/domain";
import { getPanelKindColor } from "@shared/config/panelKindRegistry";

interface PlaceholderContentProps {
  kind: PanelKind;
  agentId?: string;
  /** Use compact mode for smaller spaces like dock */
  compact?: boolean;
}

/**
 * Panel-specific placeholder content for drag operations.
 * Each panel type has a distinct visual representation.
 */
export function PlaceholderContent({ kind, agentId, compact = false }: PlaceholderContentProps) {
  const color = getPanelKindColor(kind, agentId);

  switch (kind) {
    case "terminal":
      return <TerminalPlaceholder color={color} compact={compact} />;
    case "agent":
      return <AgentPlaceholder color={color} compact={compact} />;
    case "browser":
      return <BrowserPlaceholder color={color} compact={compact} />;
    case "notes":
      return <NotesPlaceholder color={color} compact={compact} />;
    case "dev-preview":
      return <DevPreviewPlaceholder color={color} compact={compact} />;
    default:
      return <TerminalPlaceholder color={color} compact={compact} />;
  }
}

interface PlaceholderProps {
  color: string;
  compact: boolean;
}

/**
 * Terminal placeholder: 3 horizontal lines simulating text output
 */
function TerminalPlaceholder({ color, compact }: PlaceholderProps) {
  const lineHeight = compact ? 4 : 6;
  const gap = compact ? 3 : 4;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap, width: "100%" }}>
      <div
        style={{
          height: lineHeight,
          width: "70%",
          backgroundColor: `color-mix(in srgb, ${color} 10%, transparent)`,
          borderRadius: "var(--radius-sm)",
        }}
      />
      <div
        style={{
          height: lineHeight,
          width: "50%",
          backgroundColor: `color-mix(in srgb, ${color} 10%, transparent)`,
          borderRadius: "var(--radius-sm)",
        }}
      />
      {!compact && (
        <div
          style={{
            height: lineHeight,
            width: "40%",
            backgroundColor: `color-mix(in srgb, ${color} 10%, transparent)`,
            borderRadius: "var(--radius-sm)",
          }}
        />
      )}
    </div>
  );
}

/**
 * Agent placeholder: Abstract chat UI with alternating message bubbles
 */
function AgentPlaceholder({ color, compact }: PlaceholderProps) {
  const bubbleHeight = compact ? 4 : 6;
  const gap = compact ? 3 : 5;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap, width: "100%" }}>
      {/* User message (left-aligned, smaller) */}
      <div style={{ display: "flex", justifyContent: "flex-start" }}>
        <div
          style={{
            height: bubbleHeight,
            width: "35%",
            backgroundColor: `color-mix(in srgb, ${color} 8%, transparent)`,
            borderRadius: "var(--radius-sm)",
          }}
        />
      </div>
      {/* Agent reply (right-aligned, larger) */}
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <div
          style={{
            height: bubbleHeight,
            width: "55%",
            backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)`,
            borderRadius: "var(--radius-sm)",
          }}
        />
      </div>
      {/* User message */}
      <div style={{ display: "flex", justifyContent: "flex-start" }}>
        <div
          style={{
            height: bubbleHeight,
            width: "40%",
            backgroundColor: `color-mix(in srgb, ${color} 8%, transparent)`,
            borderRadius: "var(--radius-sm)",
          }}
        />
      </div>
      {!compact && (
        /* Agent reply */
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <div
            style={{
              height: bubbleHeight,
              width: "60%",
              backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)`,
              borderRadius: "var(--radius-sm)",
            }}
          />
        </div>
      )}
    </div>
  );
}

/**
 * Browser placeholder: Address bar + content area with page elements
 */
function BrowserPlaceholder({ color, compact }: PlaceholderProps) {
  const barHeight = compact ? 5 : 6;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: compact ? 4 : 6, width: "100%" }}>
      {/* Address bar */}
      <div
        style={{
          height: barHeight,
          width: "85%",
          backgroundColor: `color-mix(in srgb, ${color} 10%, transparent)`,
          borderRadius: "var(--radius-sm)",
        }}
      />
      {/* Page content area */}
      <div
        style={{
          flex: 1,
          minHeight: compact ? 0 : 30,
          padding: compact ? 4 : 6,
          backgroundColor: `color-mix(in srgb, ${color} 5%, transparent)`,
          borderRadius: "var(--radius-sm)",
          display: "flex",
          flexDirection: "column",
          gap: compact ? 3 : 4,
        }}
      >
        {/* Page elements row */}
        <div style={{ display: "flex", gap: compact ? 3 : 4 }}>
          <div
            style={{
              width: compact ? 8 : 10,
              height: compact ? 8 : 10,
              backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)`,
              borderRadius: "var(--radius-sm)",
            }}
          />
          <div
            style={{
              width: compact ? 8 : 10,
              height: compact ? 8 : 10,
              backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)`,
              borderRadius: "var(--radius-sm)",
            }}
          />
          <div
            style={{
              width: compact ? 8 : 10,
              height: compact ? 8 : 10,
              backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)`,
              borderRadius: "var(--radius-sm)",
            }}
          />
        </div>
        {/* Content line */}
        {!compact && (
          <div
            style={{
              height: 5,
              width: "80%",
              backgroundColor: `color-mix(in srgb, ${color} 8%, transparent)`,
              borderRadius: "var(--radius-sm)",
            }}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Notes placeholder: Title line + body text lines
 */
function NotesPlaceholder({ color, compact }: PlaceholderProps) {
  const titleHeight = compact ? 5 : 7;
  const lineHeight = compact ? 4 : 5;
  const gap = compact ? 3 : 4;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap, width: "100%" }}>
      {/* Title (thicker) */}
      <div
        style={{
          height: titleHeight,
          width: "75%",
          backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)`,
          borderRadius: "var(--radius-sm)",
        }}
      />
      {/* Body text lines */}
      <div style={{ display: "flex", flexDirection: "column", gap: compact ? 2 : 3, marginTop: 2 }}>
        <div
          style={{
            height: lineHeight,
            width: "90%",
            backgroundColor: `color-mix(in srgb, ${color} 8%, transparent)`,
            borderRadius: "var(--radius-sm)",
          }}
        />
        <div
          style={{
            height: lineHeight,
            width: "70%",
            backgroundColor: `color-mix(in srgb, ${color} 8%, transparent)`,
            borderRadius: "var(--radius-sm)",
          }}
        />
        {!compact && (
          <>
            <div
              style={{
                height: lineHeight,
                width: "80%",
                backgroundColor: `color-mix(in srgb, ${color} 8%, transparent)`,
                borderRadius: "var(--radius-sm)",
              }}
            />
            <div
              style={{
                height: lineHeight,
                width: "50%",
                backgroundColor: `color-mix(in srgb, ${color} 8%, transparent)`,
                borderRadius: "var(--radius-sm)",
              }}
            />
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Dev Preview placeholder: Address bar with status indicator + split preview area
 */
function DevPreviewPlaceholder({ color, compact }: PlaceholderProps) {
  const barHeight = compact ? 5 : 6;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: compact ? 4 : 6, width: "100%" }}>
      {/* Address bar with status indicator */}
      <div style={{ display: "flex", alignItems: "center", gap: compact ? 4 : 6 }}>
        <div
          style={{
            height: barHeight,
            flex: 1,
            backgroundColor: `color-mix(in srgb, ${color} 10%, transparent)`,
            borderRadius: "var(--radius-sm)",
          }}
        />
        {/* Status indicator dot */}
        <div
          style={{
            width: compact ? 6 : 8,
            height: compact ? 6 : 8,
            backgroundColor: color,
            borderRadius: "50%",
            opacity: 0.6,
            flexShrink: 0,
          }}
        />
      </div>
      {/* Split preview content */}
      <div
        style={{
          flex: 1,
          minHeight: compact ? 0 : 30,
          display: "flex",
          gap: compact ? 3 : 4,
        }}
      >
        {/* Code/terminal side (narrower) */}
        <div
          style={{
            width: "30%",
            backgroundColor: `color-mix(in srgb, ${color} 6%, transparent)`,
            borderRadius: "var(--radius-sm)",
            padding: compact ? 3 : 4,
            display: "flex",
            flexDirection: "column",
            gap: 2,
          }}
        >
          <div
            style={{
              height: 3,
              width: "80%",
              backgroundColor: `color-mix(in srgb, ${color} 10%, transparent)`,
              borderRadius: "var(--radius-sm)",
            }}
          />
          <div
            style={{
              height: 3,
              width: "60%",
              backgroundColor: `color-mix(in srgb, ${color} 10%, transparent)`,
              borderRadius: "var(--radius-sm)",
            }}
          />
        </div>
        {/* Preview side (wider) */}
        <div
          style={{
            flex: 1,
            backgroundColor: `color-mix(in srgb, ${color} 5%, transparent)`,
            borderRadius: "var(--radius-sm)",
            padding: compact ? 3 : 4,
            display: "flex",
            flexDirection: "column",
            gap: compact ? 2 : 3,
          }}
        >
          {/* Preview content elements */}
          <div style={{ display: "flex", gap: compact ? 2 : 3 }}>
            <div
              style={{
                width: compact ? 6 : 8,
                height: compact ? 6 : 8,
                backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)`,
                borderRadius: "var(--radius-sm)",
              }}
            />
            <div
              style={{
                width: compact ? 6 : 8,
                height: compact ? 6 : 8,
                backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)`,
                borderRadius: "var(--radius-sm)",
              }}
            />
          </div>
          {!compact && (
            <div
              style={{
                height: 4,
                width: "70%",
                backgroundColor: `color-mix(in srgb, ${color} 8%, transparent)`,
                borderRadius: "var(--radius-sm)",
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
