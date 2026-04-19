import React, { useCallback, useState, useRef, useEffect, forwardRef } from "react";
import type { DraggableAttributes, DraggableSyntheticListeners } from "@dnd-kit/core";
import { X, AlertTriangle } from "lucide-react";
import type { PanelKind, TerminalType, AgentState } from "@/types";
import type { WaitingReason } from "@shared/types/agent";
import { cn } from "@/lib/utils";
import { getBrandColorHex } from "@/lib/colorUtils";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import {
  getEffectiveStateIcon,
  getEffectiveStateColor,
} from "@/components/Worktree/terminalStateConfig";
import { usePanelStore } from "@/store";

export interface TabInfo {
  id: string;
  title: string;
  type?: TerminalType;
  agentId?: string;
  detectedProcessId?: string;
  kind: PanelKind;
  agentState?: AgentState;
  isActive: boolean;
  presetColor?: string;
  isUsingFallback?: boolean;
  fallbackTooltip?: string;
}

export interface TabButtonProps {
  id: string;
  title: string;
  type?: TerminalType;
  agentId?: string;
  detectedProcessId?: string;
  kind: PanelKind;
  agentState?: AgentState;
  isActive: boolean;
  presetColor?: string;
  onClick: () => void;
  onClose: () => void;
  sortableListeners?: DraggableSyntheticListeners;
  sortableAttributes?: DraggableAttributes;
  onRename?: (newTitle: string) => void;
  isUsingFallback?: boolean;
  fallbackTooltip?: string;
}

const TabButtonComponent = forwardRef<HTMLDivElement, TabButtonProps>(function TabButtonComponent(
  {
    id,
    title,
    type,
    agentId,
    detectedProcessId,
    kind,
    agentState,
    isActive,
    presetColor,
    onClick,
    onClose,
    sortableListeners,
    sortableAttributes,
    onRename,
    isUsingFallback,
    fallbackTooltip,
  },
  ref
) {
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
    window.addEventListener("daintree:rename-terminal", handleRenameEvent, {
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

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    // Stop propagation to prevent panel drag handle from capturing tab interactions
    // This keeps tab clicks/drags separate from panel drags
    e.stopPropagation();
  }, []);

  // For sortable tabs, merge attributes but filter out conflicting role/tabIndex
  const mergedAttributes = sortableAttributes
    ? Object.fromEntries(
        Object.entries(sortableAttributes).filter(([key]) => key !== "role" && key !== "tabIndex")
      )
    : {};

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

  // Handle main click - enter edit mode if not already editing, or trigger standard click
  const handleClick = useCallback(() => {
    if (isEditing) return;
    onClick();
  }, [isEditing, onClick]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onClick();
      }
    },
    [onClick]
  );

  const waitingReason = usePanelStore((state) => state.panelsById[id]?.waitingReason) as
    | WaitingReason
    | undefined;
  const showStateIcon = agentState && agentState !== "idle" && agentState !== "completed";
  const StateIcon = showStateIcon ? getEffectiveStateIcon(agentState, waitingReason) : null;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            ref={ref}
            role="tab"
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            onClick={handleClick}
            onKeyDown={handleKeyDown}
            onPointerDown={handlePointerDown}
            className={cn(
              "flex items-center gap-1.5 px-2 py-1 text-xs font-medium select-none cursor-pointer group/tab",
              "border-r border-divider transition-colors",
              "focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-[-2px]",
              isActive
                ? "bg-tint/[0.04] text-daintree-text"
                : "text-daintree-text/60 hover:text-daintree-text hover:bg-overlay-subtle"
            )}
            data-tab-id={id}
            {...mergedAttributes}
            {...sortableListeners}
          >
            <span className="shrink-0 flex items-center justify-center w-3.5 h-3.5">
              <TerminalIcon
                type={type}
                kind={kind}
                agentId={agentId}
                detectedProcessId={detectedProcessId}
                className="w-3.5 h-3.5"
                brandColor={presetColor ?? getBrandColorHex(agentId ?? type)}
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
                className="text-xs bg-daintree-bg/80 border border-daintree-accent/50 px-1 h-4 min-w-[60px] max-w-[100px] text-daintree-text select-text focus-visible:outline focus-visible:outline-1 focus-visible:outline-daintree-accent"
                aria-label={`Rename tab ${title}`}
              />
            ) : (
              <span
                className={cn("truncate max-w-[100px]", onRename && "cursor-text")}
                onDoubleClick={handleDoubleClick}
              >
                {title}
              </span>
            )}

            {showStateIcon && StateIcon && (
              <StateIcon
                className={cn(
                  "w-3 h-3 shrink-0",
                  getEffectiveStateColor(agentState, waitingReason),
                  agentState === "working" && "animate-spin-slow",
                  "motion-reduce:animate-none"
                )}
                aria-hidden="true"
              />
            )}

            {isUsingFallback && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <AlertTriangle
                      className="w-3 h-3 shrink-0 text-status-warning"
                      aria-label="Running on fallback preset"
                    />
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {fallbackTooltip ??
                      "Running on fallback preset — original provider unavailable"}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}

            {/* Close button - visible on hover */}
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={handleClose}
                    onKeyDown={handleCloseKeyDown}
                    className={cn(
                      "shrink-0 p-0.5 -mr-1 rounded transition-colors",
                      "opacity-0 group-hover/tab:opacity-100 focus-visible:opacity-100",
                      "hover:bg-[color-mix(in_oklab,var(--color-status-error)_15%,transparent)]",
                      "focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-1",
                      "text-daintree-text/40 hover:text-status-error"
                    )}
                    aria-label={`Close ${title}`}
                    type="button"
                  >
                    <X className="w-3 h-3" aria-hidden="true" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">Close tab</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {onRename ? `${title} — Double-click to rename` : title}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
});

export const TabButton = TabButtonComponent;
