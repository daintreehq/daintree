import React, { type ReactNode } from "react";
import {
  X,
  Maximize2,
  Minimize2,
  ArrowDownToLine,
  RotateCcw,
  Grid2X2,
  Activity,
} from "lucide-react";
import type { PanelKind, TerminalType } from "@/types";
import { cn, getBaseTitle } from "@/lib/utils";
import { getBrandColorHex } from "@/lib/colorUtils";
import { TerminalContextMenu } from "@/components/Terminal/TerminalContextMenu";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import { useDragHandle } from "@/components/DragDrop/DragHandleContext";
import { useBackgroundPanelStats } from "@/hooks";

export interface PanelHeaderProps {
  id: string;
  title: string;
  kind: PanelKind;
  type?: TerminalType;
  agentId?: string;
  isFocused: boolean;
  isMaximized?: boolean;
  location?: "grid" | "dock";

  // Title editing (provided by TitleEditingContext consumer)
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

  // Visual states
  isPinged?: boolean;
  wasJustSelected?: boolean;

  // Slots for kind-specific content
  headerContent?: ReactNode;
  headerActions?: ReactNode;
}

function PanelHeaderComponent({
  id,
  title,
  kind,
  type,
  agentId,
  isFocused,
  isMaximized = false,
  location = "grid",
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
  isPinged,
  wasJustSelected = false,
  headerContent,
  headerActions,
}: PanelHeaderProps) {
  const isBrowser = kind === "browser";
  const dragHandle = useDragHandle();
  const dragListeners =
    (location === "grid" || location === "dock") && dragHandle?.listeners
      ? dragHandle.listeners
      : undefined;

  // Get background activity stats for Zen Mode header
  const { activeCount, workingCount } = useBackgroundPanelStats(id);

  // In dock, show shortened title without command summary for space efficiency
  const displayTitle = location === "dock" ? getBaseTitle(title) : title;

  const handleHeaderDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.tagName === "INPUT" || target.tagName === "BUTTON") {
      return;
    }
    onToggleMaximize?.();
  };

  const getAriaLabel = () => {
    if (kind === "browser") return "Edit browser title";
    if (!agentId && type === "terminal") return "Edit terminal title";
    return "Edit agent title";
  };

  const getTitleAriaLabel = () => {
    const prefix =
      kind === "browser"
        ? "Browser title"
        : !agentId && type === "terminal"
          ? "Terminal title"
          : "Agent title";
    return `${prefix}: ${title}. Press Enter or F2 to edit`;
  };

  return (
    <TerminalContextMenu terminalId={id} forceLocation={location}>
      <div
        {...dragListeners}
        className={cn(
          "flex items-center justify-between px-3 shrink-0 text-xs transition-colors relative overflow-hidden group",
          "h-8 border-b border-divider",
          isMaximized
            ? "h-10 bg-canopy-sidebar border-canopy-border"
            : location === "dock"
              ? "bg-[var(--color-surface)]"
              : isFocused
                ? "bg-white/[0.02]"
                : "bg-transparent",
          dragListeners && "cursor-grab active:cursor-grabbing",
          isPinged && !isMaximized && "animate-terminal-header-ping"
        )}
        onDoubleClick={handleHeaderDoubleClick}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="shrink-0 flex items-center justify-center w-3.5 h-3.5 text-canopy-text">
            <TerminalIcon
              type={type}
              kind={kind}
              agentId={agentId}
              className="w-3.5 h-3.5"
              brandColor={getBrandColorHex(agentId ?? type)}
            />
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
              aria-label={getAriaLabel()}
            />
          ) : (
            <div className="flex items-center gap-2 min-w-0">
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
                aria-label={onTitleChange ? getTitleAriaLabel() : undefined}
              >
                {displayTitle}
              </span>
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
          {/* Window controls - hover only */}
          <div className="flex items-center gap-1.5 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto transition-opacity motion-reduce:transition-none">
            {headerActions}
            {!isBrowser && onRestart && (
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

          {/* Kind-specific header content slot */}
          {headerContent}
        </div>
      </div>
    </TerminalContextMenu>
  );
}

export const PanelHeader = React.memo(PanelHeaderComponent);
