import { useCallback, useState } from "react";
import type React from "react";
import { useShallow } from "zustand/react/shallow";
import { AlertCircle, XCircle, Trash2 } from "lucide-react";
import { cn, getBaseTitle } from "@/lib/utils";
import { getBrandColorHex } from "@/lib/colorUtils";
import { useTerminalStore, useWorktreeSelectionStore, type TerminalInstance } from "@/store";
import { useWaitingTerminals, useFailedTerminals } from "@/hooks/useTerminalSelectors";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import { STATE_LABELS } from "@/components/Worktree/terminalStateConfig";
import type { AgentState } from "@shared/types";

interface DockColorStripProps {
  onExpandDock: () => void;
}

const STATE_COLORS_HEX: Partial<Record<AgentState, string>> = {
  working: "var(--color-state-working)",
  waiting: "var(--color-state-waiting)",
  failed: "var(--color-status-error)",
};

/**
 * DockColorStrip renders a minimal 6px color strip at the bottom of the screen
 * when the dock is hidden. Each segment represents a docked terminal or status indicator.
 *
 * Features:
 * - Hover tooltips showing terminal details
 * - Per-segment click to open specific terminal
 * - Keyboard navigation (Tab between segments)
 * - Visual state indicators for active/waiting/failed terminals
 * - Smooth hover effects and transitions
 */
export function DockColorStrip({ onExpandDock }: DockColorStripProps) {
  const activeWorktreeId = useWorktreeSelectionStore((state) => state.activeWorktreeId);
  const { selectWorktree, trackTerminalFocus } = useWorktreeSelectionStore(
    useShallow((state) => ({
      selectWorktree: state.selectWorktree,
      trackTerminalFocus: state.trackTerminalFocus,
    }))
  );

  const dockTerminals = useTerminalStore(
    useShallow((state) =>
      state.terminals.filter(
        (t) =>
          t.location === "dock" && (t.worktreeId ?? undefined) === (activeWorktreeId ?? undefined)
      )
    )
  );

  const trashedTerminals = useTerminalStore(useShallow((state) => state.trashedTerminals));
  const { openDockTerminal, activateTerminal, pingTerminal } = useTerminalStore(
    useShallow((state) => ({
      openDockTerminal: state.openDockTerminal,
      activateTerminal: state.activateTerminal,
      pingTerminal: state.pingTerminal,
    }))
  );

  const waitingTerminals = useWaitingTerminals();
  const failedTerminals = useFailedTerminals();

  const waitingCount = waitingTerminals.length;
  const failedCount = failedTerminals.length;

  const trashedCount = trashedTerminals.size;
  const hasTerminals = dockTerminals.length > 0;
  const hasStatus = waitingCount > 0 || failedCount > 0 || trashedCount > 0;

  const handleTerminalClick = useCallback(
    (terminalId: string, e: React.MouseEvent) => {
      e.stopPropagation();
      onExpandDock();
      openDockTerminal(terminalId);
    },
    [onExpandDock, openDockTerminal]
  );

  const handleTerminalDoubleClick = useCallback(
    (terminalId: string, e: React.MouseEvent) => {
      e.stopPropagation();
      activateTerminal(terminalId);
    },
    [activateTerminal]
  );

  const handleStatusClick = useCallback(
    (type: "waiting" | "failed", e: React.MouseEvent) => {
      e.stopPropagation();
      onExpandDock();
      // Focus first terminal of that type if available
      const terminals = type === "waiting" ? waitingTerminals : failedTerminals;
      if (terminals.length > 0) {
        const first = terminals[0];
        // Switch worktree if needed
        if (first.worktreeId && first.worktreeId !== activeWorktreeId) {
          trackTerminalFocus(first.worktreeId, first.id);
          selectWorktree(first.worktreeId);
        }
        // Focus and ping the terminal
        if (first.location === "dock") {
          openDockTerminal(first.id);
        } else {
          activateTerminal(first.id);
        }
        pingTerminal(first.id);
      }
    },
    [
      onExpandDock,
      waitingTerminals,
      failedTerminals,
      activeWorktreeId,
      trackTerminalFocus,
      selectWorktree,
      openDockTerminal,
      activateTerminal,
      pingTerminal,
    ]
  );

  return (
    <TooltipProvider delayDuration={300}>
      <div
        role="group"
        aria-label="Dock color strip - click segments to expand dock"
        className={cn(
          "flex items-stretch w-full h-1.5",
          "px-[var(--dock-padding-x)] gap-[var(--dock-gap)]",
          "bg-[var(--dock-bg)]/30 backdrop-blur-sm",
          "border-t border-[var(--dock-border)]/30",
          "transition-colors duration-200",
          "hover:bg-[var(--dock-bg)]/50"
        )}
        style={{ minHeight: "6px" }}
        data-dock-variant="strip"
      >
        {/* Left: Terminals area */}
        <div className="relative flex-1 min-w-0">
          <div className="flex items-stretch gap-1 h-full px-1">
            {dockTerminals.map((terminal) => (
              <TerminalSegment
                key={terminal.id}
                terminal={terminal}
                onClick={(e) => handleTerminalClick(terminal.id, e)}
                onDoubleClick={(e) => handleTerminalDoubleClick(terminal.id, e)}
              />
            ))}
          </div>
        </div>

        {/* Separator */}
        {hasTerminals && hasStatus && (
          <div
            className="w-px shrink-0 self-stretch opacity-30"
            style={{ backgroundColor: "var(--dock-border)" }}
          />
        )}

        {/* Right: Status segments */}
        <div className="shrink-0 flex items-stretch gap-1">
          {waitingCount > 0 && (
            <StatusSegment
              type="waiting"
              count={waitingCount}
              onClick={(e) => handleStatusClick("waiting", e)}
            />
          )}
          {failedCount > 0 && (
            <StatusSegment
              type="failed"
              count={failedCount}
              onClick={(e) => handleStatusClick("failed", e)}
            />
          )}
          {trashedCount > 0 && (
            <StatusSegment type="trash" count={trashedCount} onClick={onExpandDock} />
          )}
        </div>

        {/* Expand button (fallback for empty strip or general expand) */}
        {!hasTerminals && !hasStatus && (
          <button
            type="button"
            onClick={onExpandDock}
            className="flex-1 cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent"
            aria-label="Expand dock"
          />
        )}
      </div>
    </TooltipProvider>
  );
}

interface TerminalSegmentProps {
  terminal: TerminalInstance;
  onClick: (e: React.MouseEvent) => void;
  onDoubleClick: (e: React.MouseEvent) => void;
}

function TerminalSegment({ terminal, onClick, onDoubleClick }: TerminalSegmentProps) {
  const brandColor = getBrandColorHex(terminal.type) ?? getBrandColorHex(terminal.agentId);
  const displayTitle = getBaseTitle(terminal.title);
  const isWorking = terminal.agentState === "working";
  const isRunning = terminal.agentState === "running";
  const isWaiting = terminal.agentState === "waiting";
  const isFailed = terminal.agentState === "failed";
  const isActive = isWorking || isRunning;

  // Determine segment appearance based on state
  const stateColor = terminal.agentState ? STATE_COLORS_HEX[terminal.agentState] : undefined;
  const segmentColor = brandColor ?? "#9ca3af";
  const stateLabel = terminal.agentState ? STATE_LABELS[terminal.agentState] : undefined;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          onDoubleClick={onDoubleClick}
          className={cn(
            "relative flex-1 min-w-[8px] max-w-[80px] h-full",
            "transition-all duration-150 ease-out",
            "hover:brightness-110",
            "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-canopy-accent",
            "cursor-pointer"
          )}
          style={{
            backgroundColor: segmentColor,
            opacity: isActive ? 1 : isWaiting ? 0.85 : isFailed ? 0.7 : 0.6,
          }}
          aria-label={`${displayTitle || "Terminal"}${stateLabel ? ` - ${stateLabel}` : ""}`}
        >
          {/* State indicator dot for waiting/failed */}
          {(isWaiting || isFailed) && stateColor && (
            <span
              className="absolute top-0 right-0 w-1 h-1 rounded-full"
              style={{ backgroundColor: stateColor }}
              aria-hidden="true"
            />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={8} className="max-w-[200px]">
        <div className="flex items-center gap-2">
          <TerminalIcon
            type={terminal.type}
            kind={terminal.kind}
            agentId={terminal.agentId}
            className="w-3.5 h-3.5 shrink-0"
            brandColor={brandColor}
          />
          <div className="flex flex-col min-w-0">
            <span className="text-xs font-medium truncate">{displayTitle}</span>
            {stateLabel && (
              <span className="text-[10px] opacity-70" style={{ color: stateColor }}>
                {stateLabel}
              </span>
            )}
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

interface StatusSegmentProps {
  type: "waiting" | "failed" | "trash";
  count: number;
  onClick: (e: React.MouseEvent) => void;
}

const STATUS_CONFIG = {
  waiting: {
    color: "#fbbf24", // amber-400
    hoverColor: "#f59e0b", // amber-500
    icon: AlertCircle,
    label: "waiting for input",
  },
  failed: {
    color: "#f87171", // red-400
    hoverColor: "#ef4444", // red-500
    icon: XCircle,
    label: "failed",
  },
  trash: {
    color: "#6b7280", // gray-500
    hoverColor: "#4b5563", // gray-600
    icon: Trash2,
    label: "in trash",
  },
} as const;

function StatusSegment({ type, count, onClick }: StatusSegmentProps) {
  const [isHovered, setIsHovered] = useState(false);
  const config = STATUS_CONFIG[type];
  const Icon = config.icon;

  // Width scales with count, capped at a reasonable max (wider for better visibility)
  const baseWidth = Math.max(24, Math.min(count * 12, 60));

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
          className={cn(
            "relative h-full",
            "transition-all duration-150 ease-out",
            "hover:brightness-110",
            "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-canopy-accent",
            "cursor-pointer"
          )}
          style={{
            backgroundColor: isHovered ? config.hoverColor : config.color,
            width: `${baseWidth}px`,
            minWidth: `${baseWidth}px`,
            opacity: 0.85,
          }}
          aria-label={`${count} ${config.label}`}
        />
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={8}>
        <div className="flex items-center gap-1.5">
          <Icon className="w-3.5 h-3.5" style={{ color: config.color }} />
          <span className="text-xs">
            {count} {config.label}
          </span>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
