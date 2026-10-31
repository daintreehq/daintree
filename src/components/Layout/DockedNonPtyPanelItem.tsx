import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDndMonitor } from "@dnd-kit/core";
import type { DraggableSyntheticListeners } from "@dnd-kit/core";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useDragHandle } from "@/components/DragDrop/DragHandleContext";
import { cn } from "@/lib/utils";
import { usePanelStore, useFocusStore, usePreferencesStore } from "@/store";
import type { PanelInstance } from "@shared/types/panel";
import { TerminalContextMenu } from "@/components/Terminal/TerminalContextMenu";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import { deriveTerminalChrome } from "@/utils/terminalChrome";
import { useDockPanelPortal } from "./dockPanelPortalContext";
import { DockChipBadge, useDockChipBadge } from "./DockChipBadge";
import { dockChipBadgeLabelSuffix } from "./dockChipBadgeModel";
import { DOCK_CHIP_CLASS, DOCK_CHIP_OPEN_CLASS, DOCK_CHIP_WAITING_CLASS } from "./dockChipStyles";
import {
  PluginPanelActivityDockCue,
  pluginPanelActivityLabelSuffix,
  usePluginPanelActivity,
} from "@/components/Panel/PluginPanelActivity";
import { useDockPopoverResize } from "./useDockPopoverResize";
import { DockPopoverResizeHandle } from "./DockPopoverResizeHandle";
import {
  handleDockInteractOutside,
  handleDockEscapeKeyDown,
  handleDockFocusOutside,
} from "./dockPopoverGuard";
import { DockPopoverChildProvider } from "@/components/ui/DockPopoverChildContext";
import { animatePanelMove } from "@/components/Panel/animatePanelMove";

import { useRevealDockChipOnOpen } from "./useRevealDockChipOnOpen";
import { DockChipLabel } from "./DockChipLabel";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useDismissableTooltip } from "@/hooks/useDismissableTooltip";
interface DockedNonPtyPanelItemProps {
  /**
   * Any non-PTY dock panel. The chip only reads `id`/`kind`/`title`, so it
   * hosts file, browser, file-browser, and plugin view kinds alike (#11332,
   * #11917); the caller derives the label per kind via `dockChipTitle`.
   */
  panel: PanelInstance;
  /** Chip label, derived per-kind by the caller (file name, host, folder, …). */
  displayTitle: string;
}

/**
 * Dock chip for a non-PTY content panel (file viewer, browser, file browser,
 * plugin view).
 * Mirrors DockedTerminalItem's popover + stable-wrapper relocation flow, minus
 * everything PTY: no renderer policies, no xterm fit, no agent state — only
 * what the owning plugin reports it is doing, drawn like an agent's. The
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
  const openDockTerminal = usePanelStore((s) => s.openDockTerminal);
  const closeDockTerminal = usePanelStore((s) => s.closeDockTerminal);
  const moveTerminalToGrid = usePanelStore((s) => s.moveTerminalToGrid);

  const isOpen = usePanelStore((s) => s.activeDockTerminalId === panel.id);
  const chipRef = useRevealDockChipOnOpen(isOpen);
  // A long file or page title may lose its middle; hover and keyboard arrival
  // show it whole, as on the terminal chips.
  const titleTip = useDismissableTooltip();
  const showTitleTip = displayTitle.length > 18;

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

  // A keyboard open owes the keyboard somewhere to land. The host asks the
  // panel to focus its own input once relocated; when the panel has none, focus
  // would stay on the chip with the preview's content a Tab-walk away, so the
  // preview itself takes it. Pointer opens leave focus where it is.
  const openedFromKeyboardRef = useRef(false);
  useEffect(() => {
    if (!isOpen || !portalContainer || !openedFromKeyboardRef.current) return;
    openedFromKeyboardRef.current = false;
    const rafId = requestAnimationFrame(() => {
      if (portalContainer.contains(document.activeElement)) return;
      const active = document.activeElement;
      if (active !== chipRef.current && active !== document.body) return;
      portalContainer.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(rafId);
  }, [isOpen, portalContainer, chipRef]);

  // Auto-close popover when drag starts for this panel
  useDndMonitor({
    onDragStart: ({ active }) => {
      if (active.id === panel.id && isOpen) {
        closeDockTerminal(panel.id);
      }
    },
  });

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        openDockTerminal(panel.id);
      } else {
        closeDockTerminal(panel.id);
      }
    },
    [panel.id, openDockTerminal, closeDockTerminal]
  );

  const handleMoveToGrid = useCallback(() => {
    animatePanelMove(panel.id, "restore", () => {
      const moved = moveTerminalToGrid(panel.id);
      if (moved) closeDockTerminal(panel.id);
      return moved;
    });
  }, [panel.id, moveTerminalToGrid, closeDockTerminal]);

  const chrome = useMemo(() => deriveTerminalChrome({ kind: panel.kind }), [panel.kind]);
  const badge = useDockChipBadge(panel.id);
  const activity = usePluginPanelActivity(panel.id);
  const showDockAgentHighlights = usePreferencesStore((s) => s.showDockAgentHighlights);

  const { height: popoverHeight, isResizing, handleProps } = useDockPopoverResize();

  return (
    <DockPopoverChildProvider>
      <Popover open={isOpen} onOpenChange={handleOpenChange}>
        <div className="relative flex items-center">
          <TerminalContextMenu terminalId={panel.id} forceLocation="dock">
            <PopoverTrigger asChild>
              <button
                ref={chipRef}
                {...dragPointerListeners}
                data-dock-item=""
                className={cn(
                  DOCK_CHIP_CLASS,
                  isOpen && DOCK_CHIP_OPEN_CLASS,
                  !isOpen &&
                    showDockAgentHighlights &&
                    activity?.shown === "waiting" &&
                    DOCK_CHIP_WAITING_CLASS
                )}
                onFocus={(e) => {
                  if (showTitleTip && e.currentTarget.matches(":focus-visible")) {
                    titleTip.onOpenChange(true);
                  }
                }}
                onBlur={() => titleTip.onOpenChange(false)}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  titleTip.dismiss();
                  if (e.detail >= 2) return;
                  // Enter/Space fire click with no pointer detail.
                  openedFromKeyboardRef.current = !isOpen && e.detail === 0;
                  if (isOpen) {
                    closeDockTerminal(panel.id);
                  } else {
                    openDockTerminal(panel.id);
                  }
                }}
                onDoubleClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  handleMoveToGrid();
                }}
                aria-label={`${displayTitle}${pluginPanelActivityLabelSuffix(activity)}${dockChipBadgeLabelSuffix(badge)} - Click to preview, double-click to move to grid, drag to reorder`}
              >
                <div className="flex items-center justify-center shrink-0">
                  <TerminalIcon kind={panel.kind} chrome={chrome} className="w-3.5 h-3.5" />
                </div>
                {showTitleTip ? (
                  <Tooltip open={titleTip.open} onOpenChange={titleTip.onOpenChange}>
                    <TooltipTrigger asChild onPointerEnter={titleTip.onPointerEnter}>
                      <DockChipLabel title={displayTitle} />
                    </TooltipTrigger>
                    <TooltipContent side="top">{displayTitle}</TooltipContent>
                  </Tooltip>
                ) : (
                  <DockChipLabel title={displayTitle} />
                )}
                <DockChipBadge model={badge} />
                {activity && <PluginPanelActivityDockCue activity={activity} />}
              </button>
            </PopoverTrigger>
          </TerminalContextMenu>
        </div>

        <PopoverContent
          aria-label={`Preview: ${displayTitle}`}
          className="w-[700px] max-w-[90vw] max-h-[80vh] p-0 bg-daintree-bg/95 backdrop-blur-sm border border-[var(--border-dock-popup)] shadow-[var(--shadow-dock-panel-popover)] rounded-[var(--radius-lg)] overflow-hidden"
          style={{ height: popoverHeight }}
          side="top"
          align="start"
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
              tabIndex={-1}
              className="w-full h-full flex flex-col outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:-outline-offset-2"
              data-dock-portal-target={panel.id}
            />
          </div>
        </PopoverContent>
      </Popover>
    </DockPopoverChildProvider>
  );
}
