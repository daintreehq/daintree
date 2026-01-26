import React, { useCallback, useState, useRef, useEffect } from "react";
import { X } from "lucide-react";
import type { PanelKind, TerminalType, AgentState } from "@/types";
import { cn } from "@/lib/utils";
import { getBrandColorHex } from "@/lib/colorUtils";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import { STATE_ICONS, STATE_COLORS } from "@/components/Worktree/terminalStateConfig";

export interface TabInfo {
  id: string;
  title: string;
  type?: TerminalType;
  agentId?: string;
  kind: PanelKind;
  agentState?: AgentState;
  isActive: boolean;
}

export interface TabButtonProps {
  id: string;
  title: string;
  type?: TerminalType;
  agentId?: string;
  kind: PanelKind;
  agentState?: AgentState;
  isActive: boolean;
  onClick: () => void;
  onClose: () => void;
  onRename?: (newTitle: string) => void;
}

function TabButtonComponent({
  id,
  title,
  type,
  agentId,
  kind,
  agentState,
  isActive,
  onClick,
  onClose,
  onRename,
}: TabButtonProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);
  const didCommitOrCancelRef = useRef(false);

  // Focus input when entering edit mode
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  // Sync edit value when title changes externally
  useEffect(() => {
    if (!isEditing) {
      setEditValue(title);
    }
  }, [title, isEditing]);

  // Listen for rename events from context menu
  useEffect(() => {
    if (!onRename) return;

    const handleRenameEvent = (e: Event) => {
      if (!(e instanceof CustomEvent)) return;
      const detail = e.detail as unknown;
      if (!detail || typeof (detail as { id?: unknown }).id !== "string") return;
      if ((detail as { id: string }).id === id) {
        setEditValue(title);
        setIsEditing(true);
      }
    };

    const controller = new AbortController();
    window.addEventListener("canopy:rename-terminal", handleRenameEvent, {
      signal: controller.signal,
    });
    return () => controller.abort();
  }, [id, title, onRename]);

  const handleClose = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onClose();
    },
    [onClose]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onClick();
      }
    },
    [onClick]
  );

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    // Stop propagation to prevent drag handle from capturing tab interactions
    e.stopPropagation();
  }, []);

  const handleCloseKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    },
    [onClose]
  );

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (onRename) {
        setEditValue(title);
        setIsEditing(true);
        didCommitOrCancelRef.current = false;
      }
    },
    [onRename, title]
  );

  const handleInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        const trimmed = editValue.trim();
        if (trimmed && trimmed !== title) {
          onRename?.(trimmed);
        }
        didCommitOrCancelRef.current = true;
        setIsEditing(false);
      } else if (e.key === "Escape") {
        e.preventDefault();
        setEditValue(title);
        didCommitOrCancelRef.current = true;
        setIsEditing(false);
      }
    },
    [editValue, title, onRename]
  );

  const handleInputBlur = useCallback(() => {
    // Only commit on blur if Enter/Escape didn't already handle it
    if (!didCommitOrCancelRef.current) {
      const trimmed = editValue.trim();
      if (trimmed && trimmed !== title) {
        onRename?.(trimmed);
      }
    }
    setIsEditing(false);
  }, [editValue, title, onRename]);

  const handleInputClick = useCallback((e: React.MouseEvent) => {
    // Prevent click from bubbling to tab click handler
    e.stopPropagation();
  }, []);

  const handleInputDoubleClick = useCallback((e: React.MouseEvent) => {
    // Prevent double-click from bubbling to header and triggering maximize
    e.stopPropagation();
  }, []);

  const handleInputPointerDown = useCallback((e: React.PointerEvent) => {
    // Prevent drag handle from capturing input interactions
    e.stopPropagation();
  }, []);

  const showStateIcon = agentState && agentState !== "idle" && agentState !== "completed";
  const StateIcon = showStateIcon ? STATE_ICONS[agentState] : null;

  return (
    <div
      role="tab"
      aria-selected={isActive}
      tabIndex={isActive ? 0 : -1}
      onClick={onClick}
      onKeyDown={handleKeyDown}
      onPointerDown={handlePointerDown}
      className={cn(
        "flex items-center gap-1.5 px-2 py-1 text-xs font-medium select-none cursor-pointer group/tab",
        "border-r border-divider transition-colors",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-[-2px]",
        isActive
          ? "bg-white/[0.04] text-canopy-text"
          : "text-canopy-text/60 hover:text-canopy-text hover:bg-white/[0.02]"
      )}
      title={title}
      data-tab-id={id}
    >
      <span className="shrink-0 flex items-center justify-center w-3.5 h-3.5">
        <TerminalIcon
          type={type}
          kind={kind}
          agentId={agentId}
          className="w-3.5 h-3.5"
          brandColor={getBrandColorHex(agentId ?? type)}
        />
      </span>

      {isEditing ? (
        <input
          ref={inputRef}
          type="text"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onKeyDown={handleInputKeyDown}
          onBlur={handleInputBlur}
          onClick={handleInputClick}
          onDoubleClick={handleInputDoubleClick}
          onPointerDown={handleInputPointerDown}
          className="text-xs bg-canopy-bg/80 border border-canopy-accent/50 px-1 h-4 min-w-[60px] max-w-[100px] text-canopy-text select-text focus-visible:outline focus-visible:outline-1 focus-visible:outline-canopy-accent"
          aria-label={`Rename tab ${title}`}
        />
      ) : (
        <span
          className={cn(
            "truncate max-w-[100px]",
            onRename && "cursor-text"
          )}
          onDoubleClick={handleDoubleClick}
          title={onRename ? `${title} — Double-click to rename` : title}
        >
          {title}
        </span>
      )}

      {showStateIcon && StateIcon && (
        <StateIcon
          className={cn(
            "w-3 h-3 shrink-0",
            STATE_COLORS[agentState],
            agentState === "working" && "animate-spin",
            agentState === "waiting" && "animate-breathe",
            "motion-reduce:animate-none"
          )}
          aria-hidden="true"
        />
      )}

      {/* Close button - visible on hover */}
      <button
        onClick={handleClose}
        onKeyDown={handleCloseKeyDown}
        className={cn(
          "shrink-0 p-0.5 -mr-1 rounded transition-colors",
          "opacity-0 group-hover/tab:opacity-100 focus-visible:opacity-100",
          "hover:bg-[color-mix(in_oklab,var(--color-status-error)_15%,transparent)]",
          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-1",
          "text-canopy-text/40 hover:text-[var(--color-status-error)]"
        )}
        title="Close tab"
        aria-label={`Close ${title}`}
        type="button"
      >
        <X className="w-3 h-3" aria-hidden="true" />
      </button>
    </div>
  );
}

export const TabButton = React.memo(TabButtonComponent);
