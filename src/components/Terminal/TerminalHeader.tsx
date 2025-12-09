import React from "react";
import {
  X,
  Maximize2,
  Minimize2,
  ArrowDownToLine,
  Loader2,
  RotateCcw,
  Grid2X2,
  Activity,
} from "lucide-react";
import type { TerminalType, AgentState } from "@/types";
import { cn } from "@/lib/utils";
import { getBrandColorHex } from "@/lib/colorUtils";
import { StateBadge } from "./StateBadge";
import { ActivityBadge } from "./ActivityBadge";
import { TerminalContextMenu } from "./TerminalContextMenu";
import { TerminalIcon } from "./TerminalIcon";
import type { ActivityState } from "./TerminalPane";
import { useTerminalStore } from "@/store";
import { useShallow } from "zustand/react/shallow";

export interface TerminalHeaderProps {
  id: string;
  title: string;
  type: TerminalType;
  isFocused: boolean;
  isExited: boolean;
  exitCode: number | null;
  isWorking: boolean;
  agentState?: AgentState;
  activity?: ActivityState | null;
  queueCount: number;

  // Title editing
  isEditingTitle: boolean;
  editingValue: string;
  titleInputRef: React.RefObject<HTMLInputElement | null>;
  onEditingValueChange: (value: string) => void;
  onTitleDoubleClick: (e: React.MouseEvent) => void;
  onTitleKeyDown: (e: React.KeyboardEvent) => void;
  onTitleInputKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onTitleSave: () => void;

  // Actions
  onClose: (force?: boolean) => void;
  onFocus: () => void;
  onToggleMaximize?: () => void;
  onTitleChange?: (newTitle: string) => void;
  onMinimize?: () => void;
  onRestore?: () => void;
  onRestart?: () => void;

  isMaximized?: boolean;
  location?: "grid" | "dock";
  isPinged?: boolean;
}

function TerminalHeaderComponent({
  id,
  title,
  type,
  isFocused,
  isExited,
  exitCode,
  isWorking,
  agentState,
  activity,
  queueCount,
  isEditingTitle,
  editingValue,
  titleInputRef,
  onEditingValueChange,
  onTitleDoubleClick,
  onTitleKeyDown,
  onTitleInputKeyDown,
  onTitleSave,
  onClose,
  onFocus,
  onToggleMaximize,
  onTitleChange,
  onMinimize,
  onRestore,
  onRestart,
  isMaximized,
  location = "grid",
  isPinged,
}: TerminalHeaderProps) {
  // Get background activity stats for Zen Mode header (optimized single-pass)
  // Only count grid terminals - docked terminals are visually separate
  // Treat undefined location as grid for compatibility with persisted data
  const { activeCount, workingCount } = useTerminalStore(
    useShallow((state) => {
      let active = 0;
      let working = 0;
      for (const t of state.terminals) {
        if (t.id !== id && (t.location === "grid" || t.location === undefined)) {
          active++;
          if (t.agentState === "working") working++;
        }
      }
      return { activeCount: active, workingCount: working };
    })
  );

  const handleHeaderDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.tagName === "INPUT" || target.tagName === "BUTTON") {
      return;
    }
    onToggleMaximize?.();
  };

  return (
    <TerminalContextMenu terminalId={id} forceLocation={location}>
      <div
        className={cn(
          "flex items-center justify-between px-3 shrink-0 font-mono text-xs transition-colors relative overflow-hidden",
          isMaximized ? "h-10 bg-canopy-sidebar border-b border-canopy-border" : "h-8",
          !isMaximized &&
            !isPinged &&
            (isFocused ? "bg-[var(--color-surface-highlight)]" : "bg-[var(--color-surface)]"),
          isPinged && !isMaximized && "animate-ping-header bg-[var(--color-surface-highlight)]"
        )}
        style={
          !isMaximized && getBrandColorHex(type)
            ? {
                backgroundImage: `linear-gradient(to right, ${getBrandColorHex(type)}0c 0%, transparent 60%)`,
              }
            : undefined
        }
        onDoubleClick={handleHeaderDoubleClick}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="shrink-0 flex items-center justify-center w-3.5 h-3.5 text-canopy-text">
            {isWorking ? (
              <Loader2
                className="w-3.5 h-3.5 animate-spin"
                style={{ color: getBrandColorHex(type) }}
                aria-hidden="true"
              />
            ) : (
              <TerminalIcon
                type={type}
                className="w-3.5 h-3.5"
                brandColor={getBrandColorHex(type)}
              />
            )}
          </span>

          {isEditingTitle ? (
            <input
              ref={titleInputRef}
              type="text"
              value={editingValue}
              onChange={(e) => onEditingValueChange(e.target.value)}
              onKeyDown={onTitleInputKeyDown}
              onBlur={onTitleSave}
              className="text-sm font-medium bg-canopy-bg/60 border border-canopy-accent/50 px-1 h-5 min-w-32 outline-none text-canopy-text select-text"
              aria-label={type === "shell" ? "Edit terminal title" : "Edit agent title"}
            />
          ) : (
            <span
              className={cn(
                isFocused ? "text-canopy-text" : "text-canopy-text/70",
                "font-medium truncate select-none",
                onTitleChange && "cursor-text hover:text-canopy-text"
              )}
              onDoubleClick={onTitleDoubleClick}
              onKeyDown={onTitleKeyDown}
              tabIndex={onTitleChange ? 0 : undefined}
              role={onTitleChange ? "button" : undefined}
              title={onTitleChange ? `${title} — Double-click or press Enter to edit` : title}
              aria-label={
                onTitleChange
                  ? type === "shell"
                    ? `Terminal title: ${title}. Press Enter or F2 to edit`
                    : `Agent title: ${title}. Press Enter or F2 to edit`
                  : undefined
              }
            >
              {title}
            </span>
          )}

          {isExited && (
            <span
              className="text-xs font-mono text-[var(--color-status-error)] ml-1"
              role="status"
              aria-live="polite"
            >
              [exit {exitCode}]
            </span>
          )}

          {agentState &&
            agentState !== "idle" &&
            agentState !== "waiting" &&
            agentState !== "working" && <StateBadge state={agentState} className="ml-2" />}

          {activity &&
            activity.headline &&
            agentState !== "failed" &&
            agentState !== "completed" && (
              <ActivityBadge
                headline={activity.headline}
                status={activity.status}
                type={activity.type}
                className="ml-2"
              />
            )}

          {queueCount > 0 && (
            <div
              className="text-xs font-mono bg-canopy-accent/15 text-canopy-text px-1.5 py-0.5 rounded ml-1"
              role="status"
              aria-live="polite"
              title={`${queueCount} command${queueCount > 1 ? "s" : ""} queued`}
            >
              {queueCount} queued
            </div>
          )}
        </div>

        {/* Centered Zen Mode indicator (only visible when maximized) */}
        {isMaximized && activeCount > 0 && (
          <div
            className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex items-center gap-3 text-canopy-text/40 select-none pointer-events-none"
            role="status"
            aria-live="polite"
          >
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-semibold">
              <Grid2X2 className="w-3 h-3" aria-hidden="true" />
              <span>{activeCount} Background</span>
              {workingCount > 0 && (
                <span className="flex items-center gap-1 text-[var(--color-state-working)] ml-1">
                  <Activity className="w-3 h-3 animate-pulse" aria-hidden="true" />
                  {workingCount} working
                </span>
              )}
            </div>
          </div>
        )}

        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
          {onRestart && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onRestart();
              }}
              className="p-1.5 hover:bg-canopy-text/10 focus-visible:bg-canopy-text/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent text-canopy-text/60 hover:text-canopy-text transition-colors"
              title="Restart Session"
              aria-label="Restart Session"
            >
              <RotateCcw className="w-3 h-3" aria-hidden="true" />
            </button>
          )}
          {onMinimize && !isMaximized && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onMinimize();
              }}
              className="p-1.5 hover:bg-canopy-text/10 focus-visible:bg-canopy-text/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent text-canopy-text/60 hover:text-canopy-text transition-colors"
              title={location === "dock" ? "Minimize" : "Minimize to dock"}
              aria-label={location === "dock" ? "Minimize" : "Minimize to dock"}
            >
              <ArrowDownToLine className="w-3 h-3" aria-hidden="true" />
            </button>
          )}
          {location === "dock" && onRestore && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onRestore();
              }}
              className="p-1.5 hover:bg-canopy-text/10 focus-visible:bg-canopy-text/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent text-canopy-text/60 hover:text-canopy-text transition-colors"
              title="Restore to grid"
              aria-label="Restore to grid"
            >
              <Maximize2 className="w-3 h-3" aria-hidden="true" />
            </button>
          )}
          {onToggleMaximize && isMaximized ? (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onFocus();
                onToggleMaximize();
              }}
              className="flex items-center gap-1.5 px-2 py-1 bg-canopy-accent/10 text-canopy-accent hover:bg-canopy-accent/20 rounded transition-colors mr-1"
              title="Restore Grid View (Ctrl+Shift+F)"
              aria-label="Exit Focus mode and restore grid view"
            >
              <Minimize2 className="w-3.5 h-3.5" aria-hidden="true" />
              <span className="font-medium">Exit Focus</span>
            </button>
          ) : (
            onToggleMaximize && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onFocus();
                  onToggleMaximize();
                }}
                className="p-1.5 hover:bg-canopy-text/10 focus-visible:bg-canopy-text/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent text-canopy-text/60 hover:text-canopy-text transition-colors"
                title="Maximize (Ctrl+Shift+F)"
                aria-label="Maximize"
              >
                <Maximize2 className="w-3 h-3" aria-hidden="true" />
              </button>
            )
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onClose(e.altKey);
            }}
            onKeyDown={(e) => {
              if ((e.key === "Enter" || e.key === " ") && e.altKey) {
                e.preventDefault();
                e.stopPropagation();
                onClose(true);
              }
            }}
            className="p-1.5 hover:bg-[color-mix(in_oklab,var(--color-status-error)_15%,transparent)] focus-visible:bg-[color-mix(in_oklab,var(--color-status-error)_15%,transparent)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-status-error)] text-canopy-text/60 hover:text-[var(--color-status-error)] transition-colors"
            title="Close Session (Alt+Click to force close)"
            aria-label="Close session. Hold Alt and click to force close without recovery."
          >
            <X className="w-3 h-3" aria-hidden="true" />
          </button>
        </div>
      </div>
    </TerminalContextMenu>
  );
}

export const TerminalHeader = React.memo(TerminalHeaderComponent);
