import { useCallback, useEffect, useMemo, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { useDndMonitor } from "@dnd-kit/core";
import { Loader2 } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { getBrandColorHex } from "@/lib/colorUtils";
import { useTerminalStore, useSidecarStore, type TerminalInstance } from "@/store";
import { DockedTerminalPane } from "@/components/Terminal/DockedTerminalPane";
import { TerminalContextMenu } from "@/components/Terminal/TerminalContextMenu";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import type { AgentState } from "@/types";
import { TerminalRefreshTier } from "@/types";
import { terminalClient } from "@/clients";
import { terminalInstanceService } from "@/services/TerminalInstanceService";

interface DockedTerminalItemProps {
  terminal: TerminalInstance;
}

function getStateIndicator(state?: AgentState) {
  if (!state || state === "idle" || state === "working") return null;

  switch (state) {
    case "completed":
      return (
        <span
          className="w-2 h-2 rounded-full bg-[var(--color-status-success)]"
          aria-hidden="true"
        />
      );
    case "failed":
      return (
        <span className="w-2 h-2 rounded-full bg-[var(--color-status-error)]" aria-hidden="true" />
      );
    default:
      return null;
  }
}

export function DockedTerminalItem({ terminal }: DockedTerminalItemProps) {
  const setFocused = useTerminalStore((s) => s.setFocused);
  const activeDockTerminalId = useTerminalStore((s) => s.activeDockTerminalId);
  const openDockTerminal = useTerminalStore((s) => s.openDockTerminal);
  const closeDockTerminal = useTerminalStore((s) => s.closeDockTerminal);

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
    const basePadding = 16;
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
            // Wait for Popover DOM to be fully mounted and measurable
            await new Promise((resolve) => requestAnimationFrame(resolve));

            if (cancelled) return;

            // Force xterm to measure the actual DOM and calculate exact dimensions
            const dims = terminalInstanceService.fit(terminal.id);
            if (!dims) {
              console.warn(`Failed to fit terminal ${terminal.id}, skipping dimension sync`);
              return;
            }

            if (cancelled) return;

            // Synchronize PTY to match the exact frontend dimensions
            try {
              await terminalClient.resize(terminal.id, dims.cols, dims.rows);
            } catch (resizeError) {
              console.warn(`Failed to resize PTY for terminal ${terminal.id}:`, resizeError);
              return;
            }

            if (cancelled) return;

            // NOW it's safe to flush - backend and frontend dimensions match
            await terminalClient.setBuffering(terminal.id, false);
            await terminalClient.flush(terminal.id);
            terminalInstanceService.applyRendererPolicy(terminal.id, TerminalRefreshTier.VISIBLE);
          }
        } else {
          if (!cancelled) {
            await terminalClient.setBuffering(terminal.id, true);
            terminalInstanceService.applyRendererPolicy(
              terminal.id,
              TerminalRefreshTier.BACKGROUND
            );
          }
        }
      } catch (error) {
        console.warn(`Failed to apply buffering state for terminal ${terminal.id}:`, error);
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

  const handlePopoverClose = useCallback(() => {
    closeDockTerminal();
  }, [closeDockTerminal]);

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
  const brandColor = getBrandColorHex(terminal.type);

  return (
    <Popover open={isOpen} onOpenChange={handleOpenChange}>
      <TerminalContextMenu terminalId={terminal.id} forceLocation="dock">
        <PopoverTrigger asChild>
          <button
            className={cn(
              "flex items-center gap-2.5 px-3 py-1.5 h-8 rounded-md text-xs border transition-all",
              "bg-[var(--color-surface)] border-canopy-border text-canopy-text/80",
              "hover:text-canopy-text hover:border-canopy-accent/30 hover:bg-[var(--color-surface-highlight)]",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-canopy-accent",
              "cursor-grab active:cursor-grabbing",
              isOpen &&
                "bg-[var(--color-surface-highlight)] border-white/20 text-canopy-text shadow-sm"
            )}
            onClick={() => setFocused(terminal.id)}
            title={`${terminal.title} - Click to preview, drag to reorder`}
          >
            <div
              className={cn(
                "flex items-center justify-center transition-opacity",
                isOpen || isWorking ? "opacity-100" : "opacity-70"
              )}
            >
              {isWorking ? (
                <Loader2
                  className="w-3.5 h-3.5 animate-spin"
                  style={{ color: brandColor }}
                  aria-hidden="true"
                />
              ) : (
                <TerminalIcon
                  type={terminal.type}
                  className="w-3.5 h-3.5"
                  brandColor={brandColor}
                />
              )}
            </div>
            {getStateIndicator(terminal.agentState)}
            <span className="truncate max-w-[120px] font-mono font-medium">{terminal.title}</span>
          </button>
        </PopoverTrigger>
      </TerminalContextMenu>

      <PopoverContent
        className="w-[700px] h-[500px] p-0 border-canopy-border bg-canopy-bg shadow-2xl"
        side="top"
        align="start"
        sideOffset={8}
        collisionPadding={collisionPadding}
        onEscapeKeyDown={(e) => e.preventDefault()}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          // Small delay to ensure xterm is fully mounted before focusing
          setTimeout(() => terminalInstanceService.focus(terminal.id), 50);
        }}
      >
        <DockedTerminalPane terminal={terminal} onPopoverClose={handlePopoverClose} />
      </PopoverContent>
    </Popover>
  );
}
