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
  Pause,
  Lock,
} from "lucide-react";
import type { TerminalType, AgentState } from "@/types";
import { cn } from "@/lib/utils";
import { getBrandColorHex } from "@/lib/colorUtils";
import { StateBadge } from "./StateBadge";
import { TerminalContextMenu } from "./TerminalContextMenu";
import { TerminalIcon } from "./TerminalIcon";
import type { ActivityState } from "./TerminalPane";
import { useTerminalStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { useDragHandle } from "@/components/DragDrop/DragHandleContext";

export interface TerminalHeaderProps {
  id: string;
  title: string;
  type?: TerminalType;
  agentId?: string;
  isFocused: boolean;
  isExited: boolean;
  exitCode: number | null;
  isWorking: boolean;
  agentState?: AgentState;
  activity?: ActivityState | null;
  lastCommand?: string;
  queueCount: number;
  flowStatus?: "running" | "paused-backpressure" | "paused-user" | "suspended";

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
  wasJustSelected?: boolean;
}

function TerminalHeaderComponent({
  id,
  title,
  type,
  agentId,
  isFocused,
  isExited,
  exitCode,
  isWorking,
  agentState,
  activity: _activity,
  queueCount,
  lastCommand,
  flowStatus,
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
  wasJustSelected = false,
}: TerminalHeaderProps) {
  const showCommandPill = type === "terminal" && agentState === "running" && !!lastCommand;
  const isInputLocked = useTerminalStore((state) =>
    state.terminals.find((t) => t.id === id)
  )?.isInputLocked;
  const dragHandle = useDragHandle();
  const dragListeners =
    (location === "grid" || location === "dock") && dragHandle?.listeners
      ? dragHandle.listeners
      : undefined;

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
        {...dragListeners}
        className={cn(
          "flex items-center justify-between px-3 shrink-0 text-xs transition-colors relative overflow-hidden group",
          // Base height and separator border
          "h-8 border-b border-black/20",
          // Maximized overrides: taller height, sidebar background, standard border color
          isMaximized
            ? "h-10 bg-canopy-sidebar border-canopy-border"
            : location === "dock"
              ? "bg-[var(--color-surface)]"
              : "bg-transparent",
          dragListeners && "cursor-grab active:cursor-grabbing",
          isPinged && !isMaximized && "animate-terminal-header-ping"
        )}
        onDoubleClick={handleHeaderDoubleClick}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="shrink-0 flex items-center justify-center w-3.5 h-3.5 text-canopy-text">
            {isWorking ? (
              <Loader2
                className="w-3.5 h-3.5 animate-spin motion-reduce:animate-none"
                style={{ color: getBrandColorHex(agentId ?? type) }}
                aria-hidden="true"
              />
            ) : (
              <TerminalIcon
                type={type}
                agentId={agentId}
                className="w-3.5 h-3.5"
                brandColor={getBrandColorHex(agentId ?? type)}
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
              className="text-sm font-medium bg-canopy-bg/60 border border-canopy-accent/50 px-1 h-5 min-w-32 text-canopy-text select-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-1"
              aria-label={
                !agentId && type === "terminal" ? "Edit terminal title" : "Edit agent title"
              }
            />
          ) : (
            <div className="flex items-center gap-2 min-w-0">
              {/* Title */}
              <span
                className={cn(
                  "text-xs font-medium font-sans select-none transition-colors",
                  isFocused ? "text-canopy-text" : "text-canopy-text/70",
                  onTitleChange && "cursor-text hover:text-canopy-text",
                  isPinged &&
                    !isMaximized &&
                    (wasJustSelected ? "animate-eco-title-select" : "animate-eco-title")
                )}
                onDoubleClick={onTitleDoubleClick}
                onKeyDown={onTitleKeyDown}
                tabIndex={onTitleChange ? 0 : undefined}
                role={onTitleChange ? "button" : undefined}
                title={onTitleChange ? `${title} — Double-click to edit` : title}
                aria-label={
                  onTitleChange
                    ? !agentId && type === "terminal"
                      ? `Terminal title: ${title}. Press Enter or F2 to edit`
                      : `Agent title: ${title}. Press Enter or F2 to edit`
                    : undefined
                }
              >
                {title}
              </span>

              {/* Command Pill - shows currently running command */}
              {showCommandPill && (
                <span
                  className="px-3 py-1 rounded-full text-[11px] font-mono bg-black/10 text-canopy-text/60 border border-white/10 truncate max-w-[20rem]"
                  title={lastCommand}
                >
                  {lastCommand}
                </span>
              )}
            </div>
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
            agentState !== "working" &&
            agentState !== "running" && <StateBadge state={agentState} className="ml-2" />}

          {queueCount > 0 && (
            <div
              className="inline-flex items-center gap-1 text-xs font-sans bg-canopy-accent/15 text-canopy-text px-1.5 py-0.5 rounded ml-1"
              role="status"
              aria-live="polite"
              title={`${queueCount} command${queueCount > 1 ? "s" : ""} queued`}
            >
              <span className="font-mono tabular-nums">{queueCount}</span>
              <span>queued</span>
            </div>
          )}

          {flowStatus === "paused-backpressure" && (
            <div
              className="flex items-center gap-1 text-xs font-sans bg-[var(--color-status-warning)]/15 text-[var(--color-status-warning)] px-1.5 py-0.5 rounded ml-1"
              role="status"
              aria-live="polite"
              title="Terminal paused due to buffer overflow (right-click for Force Resume)"
            >
              <Pause className="w-3 h-3" aria-hidden="true" />
              Paused
            </div>
          )}

          {flowStatus === "suspended" && (
            <div
              className="flex items-center gap-1 text-xs font-sans bg-[var(--color-status-warning)]/15 text-[var(--color-status-warning)] px-1.5 py-0.5 rounded ml-1"
              role="status"
              aria-live="polite"
              title="Terminal output streaming suspended due to a stall (auto-recovers on focus)"
            >
              <Pause className="w-3 h-3" aria-hidden="true" />
              Suspended
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
            <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider font-semibold max-w-[300px]">
              <Grid2X2 className="w-3 h-3 shrink-0" aria-hidden="true" />
              <span className="truncate">{activeCount} Background</span>
              {workingCount > 0 && (
                <span className="flex items-center gap-1 text-[var(--color-state-working)] ml-1">
                  <Activity
                    className="w-3 h-3 animate-pulse motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                  {workingCount} working
                </span>
              )}
            </div>
          </div>
        )}

        <div className="flex items-center gap-1.5">
          {isInputLocked && (
            <div
              className="flex items-center gap-1 text-xs font-sans text-canopy-text/60 px-1.5"
              role="status"
              title="Input locked (read-only monitor mode)"
            >
              <Lock className="w-3 h-3" aria-hidden="true" />
            </div>
          )}
          <div className="flex items-center gap-1.5 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto transition-opacity motion-reduce:transition-none">
            {onRestart && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onRestart();
                }}
                className="p-1.5 hover:bg-canopy-text/10 focus-visible:bg-canopy-text/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-2 text-canopy-text/60 hover:text-canopy-text transition-colors"
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
                className="p-1.5 hover:bg-canopy-text/10 focus-visible:bg-canopy-text/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-2 text-canopy-text/60 hover:text-canopy-text transition-colors"
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
                className="p-1.5 hover:bg-canopy-text/10 focus-visible:bg-canopy-text/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-2 text-canopy-text/60 hover:text-canopy-text transition-colors"
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
                className="flex items-center gap-1.5 px-2 py-1 bg-canopy-accent/10 text-canopy-accent hover:bg-canopy-accent/20 rounded transition-colors mr-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-2"
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
                  className="p-1.5 hover:bg-canopy-text/10 focus-visible:bg-canopy-text/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-2 text-canopy-text/60 hover:text-canopy-text transition-colors"
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
              className="p-1.5 hover:bg-[color-mix(in_oklab,var(--color-status-error)_15%,transparent)] focus-visible:bg-[color-mix(in_oklab,var(--color-status-error)_15%,transparent)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-status-error)] focus-visible:outline-offset-2 text-canopy-text/60 hover:text-[var(--color-status-error)] transition-colors"
              title="Close Session (Alt+Click to force close)"
              aria-label="Close session. Hold Alt and click to force close without recovery."
            >
              <X className="w-3 h-3" aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>
    </TerminalContextMenu>
  );
}

export const TerminalHeader = React.memo(TerminalHeaderComponent);
