import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDndMonitor } from "@dnd-kit/core";
import type { DraggableSyntheticListeners } from "@dnd-kit/core";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useDragHandle } from "@/components/DragDrop/DragHandleContext";
import { cn } from "@/lib/utils";
import { usePanelStore, useFocusStore } from "@/store";
import type { BrowserPanelData, FilePanelData } from "@shared/types/panel";
import { TerminalContextMenu } from "@/components/Terminal/TerminalContextMenu";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import { deriveTerminalChrome } from "@/utils/terminalChrome";
import { useDockPanelPortal } from "./dockPanelPortalContext";
import { useDockPopoverResize } from "./useDockPopoverResize";
import { DockPopoverResizeHandle } from "./DockPopoverResizeHandle";
import {
  handleDockInteractOutside,
  handleDockEscapeKeyDown,
  handleDockFocusOutside,
} from "./dockPopoverGuard";
import { DockPopoverChildProvider } from "@/components/ui/DockPopoverChildContext";

interface DockedNonPtyPanelItemProps {
  panel: FilePanelData | BrowserPanelData;
  /** Chip label, derived per-kind by the caller (file name, browser host). */
  displayTitle: string;
}

/**
 * Dock chip for a non-PTY content panel (file viewer, browser). Mirrors
 * DockedTerminalItem's popover + stable-wrapper relocation flow, minus
 * everything PTY: no renderer policies, no xterm fit, no agent state. The
 * panel's React subtree lives in DockPanelOffscreenContainer and is moved (not
 * remounted) into this popover — a webview's guest survives the move too — so
 * scroll position, view mode, and page state survive open/close.
 */
export function DockedNonPtyPanelItem({ panel, displayTitle }: DockedNonPtyPanelItemProps) {
  // Pointer/touch drag listeners only — dnd-kit's keyboard handler would
  // preventDefault() this button's activation click (see DockedTerminalItem).
  const dragHandle = useDragHandle();
  const dragPointerListeners: DraggableSyntheticListeners = dragHandle?.listeners
    ? Object.fromEntries(
        Object.entries(dragHandle.listeners).filter(([name]) => name !== "onKeyDown")
      )
    : undefined;
  const activeDockTerminalId = usePanelStore((s) => s.activeDockTerminalId);
  const openDockTerminal = usePanelStore((s) => s.openDockTerminal);
  const closeDockTerminal = usePanelStore((s) => s.closeDockTerminal);
  const moveTerminalToGrid = usePanelStore((s) => s.moveTerminalToGrid);

  const isOpen = activeDockTerminalId === panel.id;

  const sidebarHidden = useFocusStore((s) => s.gestureSidebarHidden);
  const collisionPadding = useMemo(() => {
    const basePadding = 32;
    return {
      top: basePadding,
      left: sidebarHidden ? 8 : basePadding,
      bottom: basePadding,
      right: basePadding,
    };
  }, [sidebarHidden]);

  const moveToDestination = useDockPanelPortal();
  const portalContainerElementRef = useRef<HTMLDivElement | null>(null);
  const [portalContainer, setPortalContainer] = useState<HTMLDivElement | null>(null);
  const portalContainerRef = useCallback((node: HTMLDivElement | null) => {
    portalContainerElementRef.current = node;
    setPortalContainer(node);
  }, []);

  // Relocate the panel's stable wrapper into the popover on open, back to the
  // offscreen parking container on close (same contract as terminals).
  useEffect(() => {
    if (isOpen && portalContainer) {
      moveToDestination(panel.id, portalContainer);
    } else {
      moveToDestination(panel.id, null);
    }
    return () => {
      moveToDestination(panel.id, null);
    };
  }, [isOpen, portalContainer, panel.id, moveToDestination]);

  // Auto-close popover when drag starts for this panel
  useDndMonitor({
    onDragStart: ({ active }) => {
      if (active.id === panel.id && isOpen) {
        closeDockTerminal();
      }
    },
  });

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        openDockTerminal(panel.id);
      } else {
        closeDockTerminal();
      }
    },
    [panel.id, openDockTerminal, closeDockTerminal]
  );

  const handleMoveToGrid = useCallback(() => {
    const moved = moveTerminalToGrid(panel.id);
    if (moved) closeDockTerminal();
  }, [panel.id, moveTerminalToGrid, closeDockTerminal]);

  const chrome = useMemo(() => deriveTerminalChrome({ kind: panel.kind }), [panel.kind]);

  const { height: popoverHeight, isResizing, handleProps } = useDockPopoverResize();

  return (
    <DockPopoverChildProvider>
      <Popover open={isOpen} onOpenChange={handleOpenChange}>
        <div className="relative flex items-center">
          <TerminalContextMenu terminalId={panel.id} forceLocation="dock">
            <PopoverTrigger asChild>
              <button
                {...dragPointerListeners}
                data-dock-item=""
                className={cn(
                  "flex items-center gap-1.5 px-3 h-[var(--dock-item-height)] rounded-[var(--radius-md)] text-xs border transition duration-150 max-w-[280px]",
                  "bg-[var(--dock-item-bg)] border-[var(--dock-item-border)] text-daintree-text/70",
                  "hover:text-daintree-text hover:bg-[var(--dock-item-bg-hover)]",
                  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-[-2px]",
                  "cursor-grab active:cursor-grabbing",
                  isOpen &&
                    "bg-[var(--dock-item-bg-active)] text-daintree-text border-[var(--dock-item-border-active)] ring-1 ring-inset ring-daintree-accent/30"
                )}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (e.detail >= 2) return;
                  if (isOpen) {
                    closeDockTerminal();
                  } else {
                    openDockTerminal(panel.id);
                  }
                }}
                onDoubleClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  handleMoveToGrid();
                }}
                aria-label={`${displayTitle} - Click to preview, double-click to move to grid, drag to reorder`}
              >
                <div className="flex items-center justify-center shrink-0">
                  <TerminalIcon kind={panel.kind} chrome={chrome} className="w-3.5 h-3.5" />
                </div>
                <span className="truncate min-w-[48px] max-w-[140px] font-sans font-medium">
                  {displayTitle}
                </span>
              </button>
            </PopoverTrigger>
          </TerminalContextMenu>
        </div>

        <PopoverContent
          className="w-[700px] max-w-[90vw] max-h-[80vh] p-0 bg-daintree-bg/95 backdrop-blur-sm border border-[var(--border-dock-popup)] shadow-[var(--shadow-dock-panel-popover)] rounded-[var(--radius-lg)] overflow-hidden data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:duration-200 data-[state=closed]:duration-120 data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-97 data-[state=open]:zoom-in-97 data-[side=bottom]:slide-in-from-top-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1 data-[side=top]:slide-in-from-bottom-1"
          style={{ height: popoverHeight }}
          side="top"
          align="start"
          sideOffset={10}
          collisionPadding={collisionPadding}
          onInteractOutside={(e) => handleDockInteractOutside(e, portalContainerElementRef.current)}
          onEscapeKeyDown={(e) => handleDockEscapeKeyDown(e, portalContainerElementRef.current)}
          onFocusOutside={handleDockFocusOutside}
          onOpenAutoFocus={(event) => {
            // No terminal to hand focus to — keep focus on the chip so Escape
            // closes without a focus jump.
            event.preventDefault();
          }}
        >
          <div className="relative w-full h-full group">
            <DockPopoverResizeHandle handleProps={handleProps} isResizing={isResizing} />
            {/* Portal target — content renders in DockPanelOffscreenContainer
                and is relocated here on open. */}
            <div
              ref={portalContainerRef}
              className="w-full h-full flex flex-col"
              data-dock-portal-target={panel.id}
            />
          </div>
        </PopoverContent>
      </Popover>
    </DockPopoverChildProvider>
  );
}
