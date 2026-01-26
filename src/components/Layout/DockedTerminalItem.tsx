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
  type TerminalInstance,
} from "@/store";
import { TerminalContextMenu } from "@/components/Terminal/TerminalContextMenu";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import { getTerminalFocusTarget } from "@/components/Terminal/terminalFocus";
import { STATE_ICONS, STATE_COLORS } from "@/components/Worktree/terminalStateConfig";
import { TerminalRefreshTier } from "@/types";
import { terminalClient } from "@/clients";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { useDockPanelPortal } from "./DockPanelOffscreenContainer";

const DEBUG_DOCK = true;
function dockItemLog(message: string, ...args: unknown[]) {
  if (DEBUG_DOCK) {
    console.log(`[DockedItem] ${message}`, ...args);
  }
}

interface DockedTerminalItemProps {
  terminal: TerminalInstance;
}

export function DockedTerminalItem({ terminal }: DockedTerminalItemProps) {
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

  const collisionPadding = useMemo(() => {
    const basePadding = 32;
    return {
      top: basePadding,
      left: basePadding,
      bottom: basePadding,
      right: sidecarOpen ? sidecarWidth + basePadding : basePadding,
    };
  }, [sidecarOpen, sidecarWidth]);

  // Track if we've executed the pending command for this terminal
  const commandExecutedRef = useRef(false);

  // Toggle buffering based on popover open state
  useEffect(() => {
    let cancelled = false;

    dockItemLog("Buffering state effect running:", { terminalId: terminal.id, isOpen });

    const applyBufferingState = async () => {
      try {
        if (isOpen) {
          if (!cancelled) {
            dockItemLog("Popover is open, starting fit loop for:", terminal.id);
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
              dockItemLog(`Fit attempt ${attempt + 1}/${MAX_RETRIES} for:`, terminal.id);
              dims = terminalInstanceService.fit(terminal.id);
              dockItemLog(`Fit result for ${terminal.id}:`, dims);
              if (dims) break;

              // If fit failed (terminal still offscreen), wait a bit and retry
              if (attempt < MAX_RETRIES - 1) {
                await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
              }
            }

            if (cancelled) return;

            if (!dims) {
              dockItemLog("Fit failed after all retries for:", terminal.id);
              // Terminal never became visible - this can happen if popover closed quickly
              return;
            }

            dockItemLog("Fit succeeded, resizing PTY for:", terminal.id, dims);

            // Synchronize PTY to match the exact frontend dimensions
            try {
              await terminalClient.resize(terminal.id, dims.cols, dims.rows);
            } catch (resizeError) {
              console.warn(`Failed to resize PTY for terminal ${terminal.id}:`, resizeError);
              return;
            }

            if (cancelled) return;

            dockItemLog("Applying VISIBLE renderer policy for:", terminal.id);
            terminalInstanceService.applyRendererPolicy(terminal.id, TerminalRefreshTier.VISIBLE);

            // Execute pending command for agent terminals that haven't started yet
            // This handles the case where docked agents skip command execution during hydration
            if (
              !commandExecutedRef.current &&
              terminal.kind === "agent" &&
              terminal.command &&
              (!terminal.agentState || terminal.agentState === "idle")
            ) {
              dockItemLog("Executing pending command for:", terminal.id, terminal.command);
              commandExecutedRef.current = true;
              // Small delay to ensure terminal is ready to receive input
              await new Promise((resolve) => setTimeout(resolve, 100));
              if (cancelled) return;
              try {
                await terminalClient.write(terminal.id, `${terminal.command}\r`);
                dockItemLog("Command executed successfully for:", terminal.id);
              } catch (writeError) {
                console.warn(`Failed to execute command for terminal ${terminal.id}:`, writeError);
              }
            }
          }
        } else {
          if (!cancelled) {
            dockItemLog("Popover closed, applying BACKGROUND policy for:", terminal.id);
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
  }, [isOpen, terminal.id, terminal.kind, terminal.command, terminal.agentState]);

  // Auto-close popover when drag starts for this terminal
  useDndMonitor({
    onDragStart: ({ active }) => {
      if (active.id === terminal.id && isOpen) {
        closeDockTerminal();
      }
    },
  });

  const portalTarget = useDockPanelPortal();
  const [portalContainer, setPortalContainer] = useState<HTMLDivElement | null>(null);

  // Use callback ref to capture the DOM element when it mounts
  const portalContainerRef = useCallback((node: HTMLDivElement | null) => {
    dockItemLog("Callback ref called:", { terminalId: terminal.id, hasNode: !!node });
    setPortalContainer(node);
  }, [terminal.id]);

  // Register/unregister portal target when popover opens and container is available
  useEffect(() => {
    dockItemLog("Portal registration effect:", {
      terminalId: terminal.id,
      isOpen,
      hasPortalContainer: !!portalContainer,
    });

    if (isOpen && portalContainer) {
      dockItemLog("Registering portal target for:", terminal.id);
      portalTarget(terminal.id, portalContainer);
    } else {
      dockItemLog("Unregistering portal target for:", terminal.id, { isOpen, hasContainer: !!portalContainer });
      portalTarget(terminal.id, null);
    }

    return () => {
      dockItemLog("Cleanup: unregistering portal target for:", terminal.id);
      portalTarget(terminal.id, null);
    };
  }, [isOpen, portalContainer, terminal.id, portalTarget]);

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
            onClick={(e) => {
              // Explicitly toggle popover state on click
              // This ensures the click always works, even if dnd-kit listeners
              // interfere with Radix Popover's default trigger behavior
              e.preventDefault();
              e.stopPropagation();
              if (isOpen) {
                closeDockTerminal();
              } else {
                openDockTerminal(terminal.id);
              }
            }}
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
        className="w-[700px] max-w-[90vw] h-[500px] max-h-[80vh] p-0 bg-canopy-bg/95 backdrop-blur-sm border border-[var(--border-overlay)] shadow-[var(--shadow-dock-popover)] rounded-[var(--radius-lg)] overflow-hidden"
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
