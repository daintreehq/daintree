import React, { useCallback, useRef, forwardRef, useMemo, useEffect, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { PanelHeader } from "./PanelHeader";
import { useIsDragging } from "@/components/DragDrop";
import { TitleEditingProvider, useTitleEditing } from "./TitleEditingContext";
import { TerminalHeaderContent } from "@/components/Terminal/TerminalHeaderContent";
import type { PanelKind, TerminalType, AgentState } from "@/types";
import type { ActivityState } from "@/components/Terminal/TerminalPane";
import type { TabInfo } from "./TabButton";

/**
 * Base props for all panel types.
 * Panels include terminals, agent terminals, browser panels, and extension-provided panels.
 */
export interface BasePanelProps {
  id: string;
  title: string;
  worktreeId?: string;
  isFocused: boolean;
  isMaximized?: boolean;
  location?: "grid" | "dock";
  isTrashing?: boolean;
  gridPanelCount?: number;
  onFocus: () => void;
  onClose: (force?: boolean) => void;
  onToggleMaximize?: () => void;
  onTitleChange?: (newTitle: string) => void;
  onMinimize?: () => void;
  onRestore?: () => void;
}

export interface ContentPanelProps extends BasePanelProps {
  kind: PanelKind;
  children: ReactNode;

  // Slots
  headerContent?: ReactNode;
  headerActions?: ReactNode;
  toolbar?: ReactNode;

  // Container customization
  className?: string;
  onClick?: (e: React.MouseEvent) => void;
  onKeyDown?: (e: React.KeyboardEvent) => void;
  tabIndex?: number;
  role?: string;
  "aria-label"?: string;

  // Terminal-specific header props (optional, only used for terminal/agent panels)
  type?: TerminalType;
  agentId?: string;
  detectedProcessId?: string;
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

  // Tab support
  tabs?: TabInfo[];
  groupId?: string;
  onTabClick?: (tabId: string) => void;
  onTabClose?: (tabId: string) => void;
  onTabRename?: (tabId: string, newTitle: string) => void;
  onAddTab?: () => void;
  onTabReorder?: (newOrder: string[]) => void;
}

const ContentPanelInner = forwardRef<HTMLDivElement, ContentPanelProps>(function ContentPanelInner(
  {
    id,
    title,
    kind,
    isFocused,
    isMaximized = false,
    location = "grid",
    isTrashing = false,
    gridPanelCount,
    onFocus,
    onClose,
    onToggleMaximize,
    onTitleChange,
    onMinimize,
    onRestore,
    children,
    headerContent,
    headerActions,
    toolbar,
    className,
    onClick,
    onKeyDown,
    tabIndex,
    role,
    "aria-label": ariaLabel,
    type,
    agentId,
    detectedProcessId,
    isExited = false,
    exitCode = null,
    isWorking: _isWorking = false,
    agentState,
    activity,
    lastCommand,
    queueCount = 0,
    flowStatus,
    onRestart,
    isPinged,
    wasJustSelected,
    tabs,
    groupId,
    onTabClick,
    onTabClose,
    onTabRename,
    onAddTab,
    onTabReorder,
  },
  ref
) {
  const isDragging = useIsDragging();
  const titleInputRef = useRef<HTMLInputElement>(null);
  const titleEditing = useTitleEditing();

  // Focus and select input when editing starts (handles context menu rename)
  useEffect(() => {
    if (titleEditing.isEditingTitle && titleInputRef.current) {
      requestAnimationFrame(() => titleInputRef.current?.select());
    }
  }, [titleEditing.isEditingTitle]);

  const showGridAttention = location === "grid" && !isMaximized && (gridPanelCount ?? 2) > 1;

  // Auto-construct TerminalHeaderContent for terminal/agent kinds if headerContent not provided
  const resolvedHeaderContent = useMemo(() => {
    if (headerContent !== undefined) return headerContent;
    if (kind === "terminal" || kind === "agent") {
      return (
        <TerminalHeaderContent
          id={id}
          kind={kind}
          type={type}
          agentState={agentState}
          activity={activity}
          lastCommand={lastCommand}
          isExited={isExited}
          exitCode={exitCode}
          queueCount={queueCount}
          flowStatus={flowStatus}
        />
      );
    }
    return null;
  }, [
    headerContent,
    kind,
    id,
    type,
    agentState,
    activity,
    lastCommand,
    isExited,
    exitCode,
    queueCount,
    flowStatus,
  ]);

  const handleTitleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!onTitleChange) return;
      titleEditing.startEditing();
      requestAnimationFrame(() => titleInputRef.current?.select());
    },
    [onTitleChange, titleEditing]
  );

  const handleTitleSave = useCallback(() => {
    titleEditing.stopEditing();
    if (titleEditing.editingValue.trim() && titleEditing.editingValue !== title) {
      onTitleChange?.(titleEditing.editingValue.trim());
    }
  }, [titleEditing, title, onTitleChange]);

  const handleTitleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!onTitleChange) return;
      if (e.key === "Enter" || e.key === "F2") {
        e.preventDefault();
        titleEditing.startEditing();
        requestAnimationFrame(() => titleInputRef.current?.select());
      }
    },
    [onTitleChange, titleEditing]
  );

  const handleTitleInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        handleTitleSave();
      } else if (e.key === "Escape") {
        titleEditing.stopEditing();
        titleEditing.setEditingValue(title);
      }
    },
    [handleTitleSave, title, titleEditing]
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
      data-panel-id={id}
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
        className
      )}
      onClick={handleClick}
      onKeyDown={onKeyDown}
      tabIndex={tabIndex}
      role={role}
      aria-label={ariaLabel}
    >
      <PanelHeader
        isDragging={isDragging}
        id={id}
        title={title}
        kind={kind}
        type={type}
        agentId={agentId}
        detectedProcessId={detectedProcessId}
        isFocused={isFocused}
        isMaximized={isMaximized}
        location={location}
        isEditingTitle={titleEditing.isEditingTitle}
        editingValue={titleEditing.editingValue}
        titleInputRef={titleInputRef}
        onEditingValueChange={titleEditing.setEditingValue}
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
        isPinged={isPinged}
        wasJustSelected={wasJustSelected}
        headerContent={resolvedHeaderContent}
        headerActions={headerActions}
        tabs={tabs}
        groupId={groupId}
        onTabClick={onTabClick}
        onTabClose={onTabClose}
        onTabRename={onTabRename}
        onAddTab={onAddTab}
        onTabReorder={onTabReorder}
      />

      {toolbar}

      <div className="flex-1 min-h-0 relative flex flex-col">{children}</div>
    </div>
  );
});

/**
 * Universal content panel component.
 * Base container for all panel types: terminals, agents, browsers, and extensions.
 */
export const ContentPanel = forwardRef<HTMLDivElement, ContentPanelProps>(
  function ContentPanel(props, ref) {
    return (
      <TitleEditingProvider id={props.id} title={props.title} onTitleChange={props.onTitleChange}>
        <ContentPanelInner {...props} ref={ref} />
      </TitleEditingProvider>
    );
  }
);
