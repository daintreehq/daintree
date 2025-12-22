import React, { useState, useCallback, useRef, useEffect, forwardRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { TerminalHeader } from "@/components/Terminal/TerminalHeader";
import { useIsDragging } from "@/components/DragDrop";
import type { TerminalKind, TerminalType, AgentState } from "@/types";
import type { ActivityState } from "@/components/Terminal/TerminalPane";

export interface BasePaneProps {
  id: string;
  title: string;
  worktreeId?: string;
  isFocused: boolean;
  isMaximized?: boolean;
  location?: "grid" | "dock";
  isTrashing?: boolean;
  gridTerminalCount?: number;
  onFocus: () => void;
  onClose: (force?: boolean) => void;
  onToggleMaximize?: () => void;
  onTitleChange?: (newTitle: string) => void;
  onMinimize?: () => void;
  onRestore?: () => void;
}

export interface ContentPaneProps extends BasePaneProps {
  kind: TerminalKind;
  children: ReactNode;
  toolbar?: ReactNode;

  // Container customization
  className?: string;
  onClick?: (e: React.MouseEvent) => void;
  onKeyDown?: (e: React.KeyboardEvent) => void;
  tabIndex?: number;
  role?: string;
  "aria-label"?: string;

  // Terminal-specific header props (optional, only used for terminal/agent panes)
  type?: TerminalType;
  agentId?: string;
  isExited?: boolean;
  exitCode?: number | null;
  isWorking?: boolean;
  agentState?: AgentState;
  activity?: ActivityState | null;
  lastCommand?: string;
  queueCount?: number;
  flowStatus?: "running" | "paused-backpressure" | "paused-user" | "suspended";
  onRestart?: () => void;
  isPinged?: boolean;
  wasJustSelected?: boolean;
}

export const ContentPane = forwardRef<HTMLDivElement, ContentPaneProps>(function ContentPane(
  {
    id,
    title,
    kind,
    isFocused,
    isMaximized = false,
    location = "grid",
    isTrashing = false,
    gridTerminalCount,
    onFocus,
    onClose,
    onToggleMaximize,
    onTitleChange,
    onMinimize,
    onRestore,
    children,
    toolbar,
    // Container customization
    className,
    onClick,
    onKeyDown,
    tabIndex,
    role,
    "aria-label": ariaLabel,
    // Terminal-specific props
    type,
    agentId,
    isExited = false,
    exitCode = null,
    isWorking = false,
    agentState,
    activity,
    lastCommand,
    queueCount = 0,
    flowStatus,
    onRestart,
    isPinged,
    wasJustSelected,
  },
  ref
) {
  const isDragging = useIsDragging();
  const titleInputRef = useRef<HTMLInputElement>(null);

  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editingValue, setEditingValue] = useState(title);

  // Sync editing value when title changes externally (only when not currently editing)
  useEffect(() => {
    if (!isEditingTitle) {
      setEditingValue(title);
    }
  }, [title, isEditingTitle]);

  const showGridAttention = location === "grid" && !isMaximized && (gridTerminalCount ?? 2) > 1;

  const handleTitleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!onTitleChange) return;
      setEditingValue(title);
      setIsEditingTitle(true);
      requestAnimationFrame(() => titleInputRef.current?.select());
    },
    [title, onTitleChange]
  );

  const handleTitleSave = useCallback(() => {
    setIsEditingTitle(false);
    if (editingValue.trim() && editingValue !== title) {
      onTitleChange?.(editingValue.trim());
    }
  }, [editingValue, title, onTitleChange]);

  const handleTitleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!onTitleChange) return;
      if (e.key === "Enter" || e.key === "F2") {
        e.preventDefault();
        setEditingValue(title);
        setIsEditingTitle(true);
        requestAnimationFrame(() => titleInputRef.current?.select());
      }
    },
    [title, onTitleChange]
  );

  const handleTitleInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        handleTitleSave();
      } else if (e.key === "Escape") {
        setIsEditingTitle(false);
        setEditingValue(title);
      }
    },
    [handleTitleSave, title]
  );

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      onClick?.(e);
      if (!e.defaultPrevented) {
        onFocus();
      }
    },
    [onFocus, onClick]
  );

  return (
    <div
      ref={ref}
      className={cn(
        "flex flex-col h-full overflow-hidden group",
        location === "grid" && !isMaximized && "bg-[var(--color-surface)]",
        (location === "dock" || isMaximized) && "bg-canopy-bg",
        location === "grid" && !isMaximized && "rounded border shadow-md",
        location === "grid" &&
          !isMaximized &&
          (isFocused && showGridAttention
            ? "terminal-selected"
            : "border-overlay hover:border-white/[0.08]"),
        location === "grid" && isMaximized && "border-0 rounded-none z-[var(--z-maximized)]",
        isTrashing && "terminal-trashing",
        isDragging && "pointer-events-none",
        className
      )}
      onClick={handleClick}
      onKeyDown={onKeyDown}
      tabIndex={tabIndex}
      role={role}
      aria-label={ariaLabel}
    >
      <TerminalHeader
        id={id}
        title={title}
        kind={kind}
        type={type}
        agentId={agentId}
        isFocused={isFocused}
        isExited={isExited}
        exitCode={exitCode}
        isWorking={isWorking}
        agentState={agentState}
        activity={activity}
        lastCommand={lastCommand}
        queueCount={queueCount}
        flowStatus={flowStatus}
        isEditingTitle={isEditingTitle}
        editingValue={editingValue}
        titleInputRef={titleInputRef}
        onEditingValueChange={setEditingValue}
        onTitleDoubleClick={handleTitleDoubleClick}
        onTitleKeyDown={handleTitleKeyDown}
        onTitleInputKeyDown={handleTitleInputKeyDown}
        onTitleSave={handleTitleSave}
        onClose={onClose}
        onFocus={onFocus}
        onToggleMaximize={onToggleMaximize}
        onTitleChange={onTitleChange}
        onMinimize={onMinimize}
        onRestore={onRestore}
        onRestart={onRestart}
        isMaximized={isMaximized}
        location={location}
        isPinged={isPinged}
        wasJustSelected={wasJustSelected}
      />

      {toolbar}

      <div className="flex-1 min-h-0 relative">{children}</div>
    </div>
  );
});
