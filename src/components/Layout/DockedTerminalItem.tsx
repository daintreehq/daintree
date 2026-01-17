import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useDndMonitor } from "@dnd-kit/core";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn, getBaseTitle } from "@/lib/utils";
import { getBrandColorHex } from "@/lib/colorUtils";
import {
  useTerminalInputStore,
  useTerminalStore,
  useSidecarStore,
  useDockStore,
  type TerminalInstance,
} from "@/store";
import { TerminalContextMenu } from "@/components/Terminal/TerminalContextMenu";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import { getTerminalFocusTarget } from "@/components/Terminal/terminalFocus";
import { STATE_ICONS, STATE_COLORS } from "@/components/Worktree/terminalStateConfig";
import { TerminalRefreshTier } from "@/types";
import { terminalClient } from "@/clients";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { POPOVER_MIN_HEIGHT, POPOVER_MAX_HEIGHT_RATIO } from "@/store/dockStore";
import { useDockPanelPortal } from "./DockPanelOffscreenContainer";

interface DockedTerminalItemProps {
  terminal: TerminalInstance;
}

export function DockedTerminalItem({ terminal }: DockedTerminalItemProps) {
  const setFocused = useTerminalStore((s) => s.setFocused);
  const activeDockTerminalId = useTerminalStore((s) => s.activeDockTerminalId);
  const openDockTerminal = useTerminalStore((s) => s.openDockTerminal);
  const closeDockTerminal = useTerminalStore((s) => s.closeDockTerminal);
  const backendStatus = useTerminalStore((s) => s.backendStatus);
  const hybridInputEnabled = useTerminalInputStore((s) => s.hybridInputEnabled);
  const hybridInputAutoFocus = useTerminalInputStore((s) => s.hybridInputAutoFocus);

  // Derive isOpen from store state
  const isOpen = activeDockTerminalId === terminal.id;

  // Track when popover was just programmatically opened to ignore immediate close events
  const wasJustOpenedRef = useRef(false);
  const prevIsOpenRef = useRef(isOpen);

  useEffect(() => {
    prevIsOpenRef.current = isOpen;

    // Detect programmatic open (isOpen changed from false to true externally)
    if (!isOpen) return;

    wasJustOpenedRef.current = true;
    // Clear the flag after a short delay to allow the popover to stabilize
    const timer = setTimeout(() => {
      wasJustOpenedRef.current = false;
    }, 100);
    return () => clearTimeout(timer);
  }, [isOpen]);

  const { isOpen: sidecarOpen, width: sidecarWidth } = useSidecarStore(
    useShallow((s) => ({ isOpen: s.isOpen, width: s.width }))
  );

  const popoverHeight = useDockStore((s) => s.popoverHeight);
  const setPopoverHeight = useDockStore((s) => s.setPopoverHeight);

  const [isResizing, setIsResizing] = useState(false);
  const resizeStartY = useRef(0);
  const resizeStartHeight = useRef(0);
  const RESIZE_STEP = 10;

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsResizing(true);
      resizeStartY.current = e.clientY;
      resizeStartHeight.current = popoverHeight;
    },
    [popoverHeight]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowUp") {
        e.preventDefault();
        const maxHeight = window.innerHeight * POPOVER_MAX_HEIGHT_RATIO;
        const newHeight = Math.min(popoverHeight + RESIZE_STEP, maxHeight);
        setPopoverHeight(newHeight);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        const newHeight = Math.max(popoverHeight - RESIZE_STEP, POPOVER_MIN_HEIGHT);
        setPopoverHeight(newHeight);
      }
    },
    [popoverHeight, setPopoverHeight]
  );

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      const deltaY = resizeStartY.current - e.clientY;
      const newHeight = resizeStartHeight.current + deltaY;
      setPopoverHeight(newHeight);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      requestAnimationFrame(() => {
        terminalInstanceService.fit(terminal.id);
      });
    };

    const handleBlur = () => {
      setIsResizing(false);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    window.addEventListener("blur", handleBlur);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      window.removeEventListener("blur", handleBlur);
    };
  }, [isResizing, terminal.id, setPopoverHeight]);

  const collisionPadding = useMemo(() => {
    const basePadding = 32;
    return {
      top: basePadding,
      left: basePadding,
      bottom: basePadding,
      right: sidecarOpen ? sidecarWidth + basePadding : basePadding,
    };
  }, [sidecarOpen, sidecarWidth]);

  // Toggle buffering based on popover open state
  useEffect(() => {
    let cancelled = false;

    const applyBufferingState = async () => {
      try {
        if (isOpen) {
          if (!cancelled) {
            // Wait for Popover DOM to be fully mounted and XtermAdapter to attach the terminal.
            // A single RAF is not enough - React needs multiple frames to mount the component tree.
            // We retry fitting until the terminal is attached to a visible container.
            const MAX_RETRIES = 10;
            const RETRY_DELAY_MS = 16; // ~1 frame

            let dims: { cols: number; rows: number } | null = null;
            for (let attempt = 0; attempt < MAX_RETRIES && !cancelled; attempt++) {
              // Wait for next frame
              await new Promise((resolve) => requestAnimationFrame(resolve));
              if (cancelled) return;

              // Try to fit - will return null if terminal is still in offscreen container
              dims = terminalInstanceService.fit(terminal.id);
              if (dims) break;

              // If fit failed (terminal still offscreen), wait a bit and retry
              if (attempt < MAX_RETRIES - 1) {
                await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
              }
            }

            if (cancelled) return;

            if (!dims) {
              // Terminal never became visible - this can happen if popover closed quickly
              return;
            }

            // Synchronize PTY to match the exact frontend dimensions
            try {
              await terminalClient.resize(terminal.id, dims.cols, dims.rows);
            } catch (resizeError) {
              console.warn(`Failed to resize PTY for terminal ${terminal.id}:`, resizeError);
              return;
            }

            if (cancelled) return;

            terminalInstanceService.applyRendererPolicy(terminal.id, TerminalRefreshTier.VISIBLE);
          }
        } else {
          if (!cancelled) {
            terminalInstanceService.applyRendererPolicy(
              terminal.id,
              TerminalRefreshTier.BACKGROUND
            );
          }
        }
      } catch (error) {
        console.warn(`Failed to apply dock state for terminal ${terminal.id}:`, error);
      }
    };

    applyBufferingState();

    return () => {
      cancelled = true;
    };
  }, [isOpen, terminal.id]);

  // Auto-close popover when drag starts for this terminal
  useDndMonitor({
    onDragStart: ({ active }) => {
      if (active.id === terminal.id && isOpen) {
        closeDockTerminal();
      }
    },
  });

  const portalTarget = useDockPanelPortal();
  const portalContainerRef = useRef<HTMLDivElement>(null);

  // Register/unregister portal target when popover opens/closes
  useEffect(() => {
    if (isOpen && portalContainerRef.current) {
      portalTarget(terminal.id, portalContainerRef.current);
    } else {
      portalTarget(terminal.id, null);
    }

    // Cleanup on unmount to prevent portaling into detached nodes
    return () => {
      portalTarget(terminal.id, null);
    };
  }, [isOpen, terminal.id, portalTarget]);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        openDockTerminal(terminal.id);
      } else {
        // Ignore close events immediately after programmatic open
        if (wasJustOpenedRef.current) {
          return;
        }
        closeDockTerminal();
      }
    },
    [terminal.id, openDockTerminal, closeDockTerminal]
  );

  const isWorking = terminal.agentState === "working";
  const isRunning = terminal.agentState === "running";
  const isWaiting = terminal.agentState === "waiting";
  const isActive = isWorking || isRunning || isWaiting;
  const commandText = terminal.activityHeadline || terminal.lastCommand;
  const brandColor = getBrandColorHex(terminal.type);
  const agentState = terminal.agentState;
  // Use shortened title without command summary for dock items
  const displayTitle = getBaseTitle(terminal.title);
  // Only show icon for non-idle, non-completed states (reduce noise)
  const showStateIcon = agentState && agentState !== "idle" && agentState !== "completed";
  const StateIcon = showStateIcon ? STATE_ICONS[agentState] : null;

  return (
    <Popover open={isOpen} onOpenChange={handleOpenChange}>
      <TerminalContextMenu terminalId={terminal.id} forceLocation="dock">
        <PopoverTrigger asChild>
          <button
            className={cn(
              "flex items-center gap-1.5 px-3 h-[var(--dock-item-height)] rounded-[var(--radius-md)] text-xs border transition-all duration-150 max-w-[280px]",
              "bg-white/[0.02] border-divider text-canopy-text/70",
              "hover:text-canopy-text hover:bg-white/[0.04]",
              "focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-2",
              "cursor-grab active:cursor-grabbing",
              isOpen &&
                "bg-white/[0.08] text-canopy-text border-canopy-accent/40 ring-1 ring-inset ring-canopy-accent/30"
            )}
            onClick={() => setFocused(terminal.id)}
            title={`${terminal.title} - Click to preview, drag to reorder`}
            aria-label={`${terminal.title} - Click to preview, drag to reorder`}
          >
            <div
              className={cn(
                "flex items-center justify-center transition-opacity shrink-0",
                isOpen || isActive ? "opacity-100" : "opacity-70"
              )}
            >
              <TerminalIcon
                type={terminal.type}
                kind={terminal.kind}
                className="w-3.5 h-3.5"
                brandColor={brandColor}
              />
            </div>
            <span className="truncate min-w-[48px] max-w-[140px] font-sans font-medium">
              {displayTitle}
            </span>

            {isActive && commandText && (
              <>
                <div className="h-3 w-px bg-white/10 shrink-0" aria-hidden="true" />
                <span
                  className="truncate flex-1 min-w-0 text-[11px] text-canopy-text/50 font-mono"
                  title={commandText}
                >
                  {commandText}
                </span>
              </>
            )}

            {/* State icon (compact spacing from title) */}
            {showStateIcon && StateIcon && (
              <div
                className={cn("flex items-center shrink-0", STATE_COLORS[agentState])}
                title={`Agent ${agentState}`}
              >
                <StateIcon
                  className={cn(
                    "w-3.5 h-3.5",
                    agentState === "working" && "animate-spin",
                    agentState === "waiting" && "animate-breathe",
                    "motion-reduce:animate-none"
                  )}
                  aria-hidden="true"
                />
              </div>
            )}
          </button>
        </PopoverTrigger>
      </TerminalContextMenu>

      <PopoverContent
        className={cn(
          "w-[700px] max-w-[90vw] p-0 bg-canopy-bg/95 backdrop-blur-sm border border-[var(--border-overlay)] shadow-[var(--shadow-dock-popover)] rounded-[var(--radius-lg)] overflow-hidden",
          isResizing && "select-none"
        )}
        style={{ height: popoverHeight }}
        side="top"
        align="start"
        sideOffset={10}
        collisionPadding={collisionPadding}
        onEscapeKeyDown={(e) => e.preventDefault()}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          const focusTarget = getTerminalFocusTarget({
            isAgentTerminal: terminal.type !== "terminal",
            isInputDisabled: backendStatus === "disconnected" || backendStatus === "recovering",
            hybridInputEnabled,
            hybridInputAutoFocus,
          });

          if (focusTarget === "hybridInput") {
            return;
          }

          // Small delay to ensure xterm is fully mounted before focusing
          setTimeout(() => terminalInstanceService.focus(terminal.id), 50);
        }}
      >
        <div
          className={cn(
            "absolute top-0 left-0 right-0 h-2 cursor-ns-resize z-10 group flex items-center justify-center transition-colors",
            "hover:bg-white/[0.03] focus-visible:outline-none focus-visible:bg-white/[0.04] focus-visible:ring-1 focus-visible:ring-canopy-accent/50",
            isResizing && "bg-canopy-accent/20"
          )}
          onMouseDown={handleResizeStart}
          onKeyDown={handleKeyDown}
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize docked terminal popover"
          aria-valuenow={Math.round(popoverHeight)}
          aria-valuemin={POPOVER_MIN_HEIGHT}
          aria-valuemax={Math.round(window.innerHeight * POPOVER_MAX_HEIGHT_RATIO)}
          tabIndex={0}
        >
          <div
            className={cn(
              "w-10 h-0.5 rounded-full transition-colors",
              "bg-canopy-text/15",
              "group-hover:bg-canopy-text/30 group-focus-visible:bg-canopy-accent",
              isResizing && "bg-canopy-accent"
            )}
          />
        </div>
        {/* Portal target - content is rendered in DockPanelOffscreenContainer and portaled here */}
        <div
          ref={portalContainerRef}
          className="w-full h-full flex flex-col"
          data-dock-portal-target={terminal.id}
        />
      </PopoverContent>
    </Popover>
  );
}
