import React, { useCallback, useRef, forwardRef, useMemo, useEffect, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { PanelHeader } from "./PanelHeader";
import { useIsDragging } from "@/components/DragDrop";
import { TitleEditingProvider, useTitleEditing } from "./TitleEditingContext";
import { TerminalHeaderContent } from "@/components/Terminal/TerminalHeaderContent";
import { TerminalContextMenu } from "@/components/Terminal/TerminalContextMenu";
import type { PanelKind, TerminalType, AgentState } from "@/types";
import type { ActivityState } from "@/components/Terminal/TerminalPane";
import type { TabInfo } from "./TabButton";
import { useDockBlockedState } from "@/components/Layout/useDockBlockedState";
import { usePreferencesStore } from "@/store";
import { useWorktreeColorMap } from "@/hooks/useWorktreeColorMap";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";

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
  // Group-level ambient state: highest-urgency agent state across all tabs in a tab group.
  // When set, this overrides agentState for container border styling so hidden tabs
  // surface their state on the group container without changing the header chip.
  ambientAgentState?: AgentState;

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
    worktreeId,
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
    ambientAgentState,
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

  // Focus and select input when editing starts (handles context menu rename).
  // Use a short delay instead of rAF so the context menu's focus restoration
  // (Radix returns focus to the trigger) completes before we grab focus.
  useEffect(() => {
    if (titleEditing.isEditingTitle && titleInputRef.current) {
      const timer = setTimeout(() => titleInputRef.current?.select(), 60);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [titleEditing.isEditingTitle]);

  const showGridAttention = location === "grid" && !isMaximized && (gridPanelCount ?? 2) > 1;
  const showGridAgentHighlights = usePreferencesStore((s) => s.showGridAgentHighlights);

  // Per-worktree color identity
  const worktreeColorMap = useWorktreeColorMap();
  const worktreeAccentColor = worktreeId ? worktreeColorMap?.[worktreeId] : undefined;
  const worktreeBranch = useWorktreeStore(
    useCallback(
      (state) => {
        if (!worktreeId || !worktreeAccentColor) return undefined;
        return state.worktrees.get(worktreeId)?.branch;
      },
      [worktreeId, worktreeAccentColor]
    )
  );

  // Determine effective agent state for container border styling.
  // ambientAgentState takes priority so tab groups can surface highest-urgency
  // state from hidden tabs without affecting the header chip (which uses agentState).
  const effectiveAgentState = ambientAgentState ?? agentState;
  const blockedState = useDockBlockedState(effectiveAgentState);
  const isWorkingState = effectiveAgentState === "working";
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
    <TerminalContextMenu terminalId={id} forceLocation={location}>
      <div
        ref={ref}
        data-panel-id={id}
        data-panel-location={location}
        style={{
          contain: "content",
          ...(worktreeAccentColor
            ? ({ "--worktree-color": worktreeAccentColor } as React.CSSProperties)
            : undefined),
        }}
        className={cn(
          "flex flex-col h-full overflow-hidden group",
          location === "grid" && !isMaximized && "bg-surface",
          (location === "dock" || isMaximized) && "bg-canopy-bg",
          location === "grid" &&
            !isMaximized &&
            "rounded border shadow-[var(--theme-shadow-ambient)] transition-colors duration-300",
          location === "grid" &&
            !isMaximized &&
            (isFocused && showGridAttention
              ? "terminal-selected"
              : showGridAttention && showGridAgentHighlights && blockedState === "waiting"
                ? "panel-state-waiting"
                : showGridAttention && showGridAgentHighlights && isWorkingState
                  ? "panel-state-working"
                  : "border-overlay hover:border-tint/[0.08]"),
          location === "grid" && isMaximized && "border-0 rounded-none z-[var(--z-maximized)]",
          worktreeAccentColor && location === "grid" && !isMaximized && "panel-worktree-identity",
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
          worktreeAccentColor={worktreeAccentColor}
          worktreeBranch={worktreeBranch}
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
    </TerminalContextMenu>
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
