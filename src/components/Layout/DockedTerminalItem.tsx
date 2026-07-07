import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDndMonitor } from "@dnd-kit/core";
import type { DraggableSyntheticListeners } from "@dnd-kit/core";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useDragHandle } from "@/components/DragDrop/DragHandleContext";
import { cn } from "@/lib/utils";
import { useTerminalInputStore, usePanelStore, useFocusStore } from "@/store";
import type { PtyPanelData } from "@shared/types/panel";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { useCcrPresetsStore } from "@/store/ccrPresetsStore";
import { useProjectPresetsStore } from "@/store/projectPresetsStore";
import { getMergedPresets } from "@/config/agents";
import { TerminalContextMenu } from "@/components/Terminal/TerminalContextMenu";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import { getTerminalFocusTarget } from "@/components/Terminal/terminalFocus";
import { deriveTerminalChrome } from "@/utils/terminalChrome";
import { getTerminalAgentDisplayState } from "@/utils/terminalAgentDisplayState";
import {
  getEffectiveStateIcon,
  getEffectiveStateColor,
  getEffectiveStateLabel,
} from "@/components/Worktree/terminalStateConfig";
import { TerminalRefreshTier } from "@/types";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { useDockPanelPortal } from "./dockPanelPortalContext";
import { useDockPopoverResize } from "./useDockPopoverResize";
import { DockPopoverResizeHandle } from "./DockPopoverResizeHandle";
import {
  getDockDisplayAgentState,
  isDockAgentStateDeprioritized,
  useDockBlockedState,
} from "./useDockBlockedState";
import {
  handleDockInteractOutside,
  handleDockEscapeKeyDown,
  handleDockFocusOutside,
} from "./dockPopoverGuard";
import { usePreferencesStore } from "@/store";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useDismissableTooltip } from "@/hooks/useDismissableTooltip";
import { DockPopoverChildProvider } from "@/components/ui/DockPopoverChildContext";

interface DockedTerminalItemProps {
  terminal: PtyPanelData;
}

export function DockedTerminalItem({ terminal }: DockedTerminalItemProps) {
  // Forward only the pointer/touch drag listeners SortableDockItem publishes via
  // DragHandleProvider, so the chip becomes a real drag source (reorder/eject)
  // instead of just grab-cursor styling. The KeyboardSensor's onKeyDown is
  // dropped on purpose: the chip is its own preview trigger, and dnd-kit's
  // Space/Enter handler calls preventDefault() to start a keyboard drag, which
  // would suppress this native <button>'s activation click — the sole keyboard
  // path to the chip's primary action. (Grid PanelHeader has no such conflict:
  // its drag surface is a non-interactive <div>.) Keyboard-driven reordering of
  // dock chips is intentionally out of scope.
  const dragHandle = useDragHandle();
  const dragPointerListeners: DraggableSyntheticListeners = dragHandle?.listeners
    ? Object.fromEntries(
        Object.entries(dragHandle.listeners).filter(([name]) => name !== "onKeyDown")
      )
    : undefined;

  // Chip-local hover tooltips (command text, agent state) are force-closed when
  // the chip is clicked or dragged, mirroring the toolbar buttons — a click that
  // opens the preview popover (or a drag) over the chip would otherwise leave the
  // hover tooltip stranded open.
  const commandTip = useDismissableTooltip();
  const stateTip = useDismissableTooltip();
  const dismissTips = () => {
    commandTip.dismiss();
    stateTip.dismiss();
  };

  const activeDockTerminalId = usePanelStore((s) => s.activeDockTerminalId);
  const openDockTerminal = usePanelStore((s) => s.openDockTerminal);
  const closeDockTerminal = usePanelStore((s) => s.closeDockTerminal);
  const moveTerminalToGrid = usePanelStore((s) => s.moveTerminalToGrid);
  const backendStatus = usePanelStore((s) => s.backendStatus);
  const hybridInputEnabled = useTerminalInputStore((s) => s.hybridInputEnabled);
  const preferredTerminalFocusTarget = usePanelStore((s) => s.preferredTerminalFocusTarget);

  // Derive isOpen from store state
  const isOpen = activeDockTerminalId === terminal.id;

  // Tracks whether the worktree sidebar is hidden by the chrome gesture, so
  // popover collision padding can extend left when there's no sidebar there.
  // The assistant lives on the right, so its gesture state doesn't affect
  // left-side padding. Right padding is handled by PopoverContent's
  // collisionBoundary (width: 100vw − --right-obstruction-offset), so the
  // assistant/portal exclusion is not re-counted here.
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

  // Use callback ref to capture the DOM element when it mounts
  const portalContainerRef = useCallback((node: HTMLDivElement | null) => {
    portalContainerElementRef.current = node;
    setPortalContainer(node);
  }, []);

  // Toggle buffering based on popover open state. The terminal's stable wrapper
  // is relocated into this popover's container on open (and parked offscreen on
  // close) without a React remount. One layout pass after the move settles is
  // enough for `checkVisibility()` inside `fit()` to flip — no retry loop needed.
  useEffect(() => {
    if (!isOpen) {
      try {
        terminalInstanceService.applyRendererPolicy(terminal.id, TerminalRefreshTier.BACKGROUND);
      } catch (error) {
        console.warn(`Failed to apply dock state for terminal ${terminal.id}:`, error);
      }
      return;
    }

    if (!portalContainer) return;

    const rafId = requestAnimationFrame(() => {
      try {
        const dims = terminalInstanceService.fit(terminal.id);
        if (!dims) return;
        terminalInstanceService.applyRendererPolicy(terminal.id, TerminalRefreshTier.VISIBLE);
      } catch (error) {
        console.warn(`Failed to apply dock state for terminal ${terminal.id}:`, error);
      }
    });

    return () => {
      cancelAnimationFrame(rafId);
    };
  }, [isOpen, portalContainer, terminal.id]);

  // Auto-close popover when drag starts for this terminal
  useDndMonitor({
    onDragStart: ({ active }) => {
      if (active.id === terminal.id) {
        dismissTips();
        if (isOpen) closeDockTerminal();
      }
    },
  });

  // Move the panel's stable wrapper into this popover when it opens and back to
  // the offscreen parking container when it closes. The move is synchronous and
  // preserves the subtree (no remount), so a tab/popover toggle is cheap.
  useEffect(() => {
    if (isOpen && portalContainer) {
      moveToDestination(terminal.id, portalContainer);
    } else {
      moveToDestination(terminal.id, null);
    }

    return () => {
      moveToDestination(terminal.id, null);
    };
  }, [isOpen, portalContainer, terminal.id, moveToDestination]);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        openDockTerminal(terminal.id);
      } else {
        // Focus-driven dismissals are blocked upstream by onFocusOutside, so a
        // close here is a genuine pointer-outside or Escape and is honored.
        closeDockTerminal();
      }
    },
    [terminal.id, openDockTerminal, closeDockTerminal]
  );

  // Move this terminal out of the dock and into the grid. Mirrors the
  // double-click backstop: only close the dock popover if the move succeeded
  // (the store wrapper clears activeDockTerminalId — see #4997).
  const handleMoveToGrid = useCallback(() => {
    const moved = moveTerminalToGrid(terminal.id);
    if (moved) closeDockTerminal();
  }, [terminal.id, moveTerminalToGrid, closeDockTerminal]);

  const presetCustomPresets = useAgentSettingsStore((s) =>
    terminal.launchAgentId ? s.settings?.agents?.[terminal.launchAgentId]?.customPresets : undefined
  );
  const presetCcrPresets = useCcrPresetsStore((s) =>
    terminal.launchAgentId ? s.ccrPresetsByAgent[terminal.launchAgentId] : undefined
  );
  const presetProjectPresets = useProjectPresetsStore((s) =>
    terminal.launchAgentId ? s.presetsByAgent[terminal.launchAgentId] : undefined
  );
  const baseChrome = useMemo(
    () =>
      deriveTerminalChrome({
        kind: terminal.kind,
        launchAgentId: terminal.launchAgentId,
        runtimeIdentity: terminal.runtimeIdentity,
        detectedAgentId: terminal.detectedAgentId,
        detectedProcessId: terminal.detectedProcessId,
        agentState: terminal.agentState,
        runtimeStatus: terminal.runtimeStatus,
        exitCode: terminal.exitCode,
      }),
    [
      terminal.kind,
      terminal.launchAgentId,
      terminal.runtimeIdentity,
      terminal.detectedAgentId,
      terminal.detectedProcessId,
      terminal.agentState,
      terminal.runtimeStatus,
      terminal.exitCode,
    ]
  );
  const { color: brandColor, userChosen: brandColorUserChosen } = useMemo(() => {
    const fallbackColor = baseChrome.color;
    if (!terminal.agentPresetId || !terminal.launchAgentId)
      return { color: fallbackColor, userChosen: false };
    const preset = getMergedPresets(
      terminal.launchAgentId,
      presetCustomPresets,
      presetCcrPresets,
      presetProjectPresets
    ).find((f) => f.id === terminal.agentPresetId);
    const presetColor = preset?.color ?? terminal.agentPresetColor;
    return { color: presetColor ?? fallbackColor, userChosen: !!presetColor };
  }, [
    terminal.launchAgentId,
    terminal.agentPresetId,
    terminal.agentPresetColor,
    baseChrome.color,
    presetCustomPresets,
    presetCcrPresets,
    presetProjectPresets,
  ]);
  const chrome = useMemo(
    () =>
      deriveTerminalChrome({
        kind: terminal.kind,
        launchAgentId: terminal.launchAgentId,
        runtimeIdentity: terminal.runtimeIdentity,
        detectedAgentId: terminal.detectedAgentId,
        detectedProcessId: terminal.detectedProcessId,
        agentState: terminal.agentState,
        runtimeStatus: terminal.runtimeStatus,
        exitCode: terminal.exitCode,
        presetColor: brandColor,
      }),
    [
      terminal.kind,
      terminal.launchAgentId,
      terminal.runtimeIdentity,
      terminal.detectedAgentId,
      terminal.detectedProcessId,
      terminal.agentState,
      terminal.runtimeStatus,
      terminal.exitCode,
      brandColor,
    ]
  );

  // Focus the terminal once the popover is open and its wrapper has been moved
  // in. The move effect above runs first (effects fire in declaration order),
  // so by the time this runs the terminal host is a live descendant of
  // PopoverContent. Honors the focus-preserve and hybrid-input skips (see #6959).
  useEffect(() => {
    if (!isOpen || !portalContainer) return;
    if (terminal.focusPolicy === "preserve") return;

    const focusTarget = getTerminalFocusTarget({
      preferredTarget: preferredTerminalFocusTarget,
      hasHybridInputSurface: chrome.isAgent,
      isInputDisabled: backendStatus === "disconnected" || backendStatus === "recovering",
      hybridInputEnabled,
    });
    if (focusTarget === "hybridInput") return;

    terminalInstanceService.focus(terminal.id);
  }, [
    isOpen,
    portalContainer,
    terminal.id,
    terminal.focusPolicy,
    preferredTerminalFocusTarget,
    chrome.isAgent,
    backendStatus,
    hybridInputEnabled,
  ]);

  const agentState = getDockDisplayAgentState(terminal);
  const isWorking = agentState === "working";
  const isWaiting = agentState === "waiting";
  const isActive = isWorking || isWaiting;
  const commandText = terminal.activityHeadline || terminal.lastCommand;
  const blockedState = useDockBlockedState(agentState);
  const showDockAgentHighlights = usePreferencesStore((s) => s.showDockAgentHighlights);
  // Use shortened title without command summary for dock items
  const displayTitle = terminal.title;
  // Indicator stays visible for the lifetime of the agent chrome — idle/missing
  // state coerces to waiting so it never disappears mid-flight.
  const displayAgentState = getTerminalAgentDisplayState(chrome, agentState);
  const StateIcon = displayAgentState ? getEffectiveStateIcon(displayAgentState) : null;
  const isDeprioritized = !isOpen && isDockAgentStateDeprioritized(agentState);

  // Re-fit the terminal once a resize gesture settles on a new popover height.
  const {
    height: popoverHeight,
    isResizing,
    handleProps,
  } = useDockPopoverResize(() => {
    requestAnimationFrame(() => {
      try {
        terminalInstanceService.fit(terminal.id);
      } catch {
        // fit() guards zero-dimension cases internally; ignore transient throws.
      }
    });
  });

  return (
    <DockPopoverChildProvider>
      <Popover open={isOpen} onOpenChange={handleOpenChange}>
        <div className="relative flex items-center">
          <TerminalContextMenu terminalId={terminal.id} forceLocation="dock">
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
                    "bg-[var(--dock-item-bg-active)] text-daintree-text border-[var(--dock-item-border-active)] ring-1 ring-inset ring-daintree-accent/30",
                  !isOpen &&
                    showDockAgentHighlights &&
                    blockedState === "waiting" &&
                    "bg-[var(--dock-item-bg-waiting)] border-[var(--dock-item-border-waiting)]",
                  isDeprioritized && "text-daintree-text/40 border-[var(--dock-item-border)]/50"
                )}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  dismissTips();
                  if (e.detail >= 2) return;
                  if (isOpen) {
                    closeDockTerminal();
                  } else {
                    openDockTerminal(terminal.id);
                  }
                }}
                onDoubleClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  handleMoveToGrid();
                }}
                aria-label={`${terminal.title}${displayAgentState ? ` — agent ${getEffectiveStateLabel(displayAgentState)}` : ""} - Click to preview, double-click to move to grid, drag to reorder`}
              >
                <div className="flex items-center justify-center shrink-0">
                  <TerminalIcon
                    kind={terminal.kind}
                    chrome={chrome}
                    className="w-3.5 h-3.5"
                    userChosen={brandColorUserChosen}
                  />
                </div>
                <span className="truncate min-w-[48px] max-w-[140px] font-sans font-medium">
                  {displayTitle}
                </span>

                {isActive && commandText && (
                  <>
                    <div className="h-3 w-px bg-border-subtle shrink-0" aria-hidden="true" />
                    <Tooltip open={commandTip.open} onOpenChange={commandTip.onOpenChange}>
                      <TooltipTrigger asChild onPointerEnter={commandTip.onPointerEnter}>
                        <span className="truncate flex-1 min-w-0 text-[11px] text-daintree-text/50 font-mono">
                          {commandText}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">{commandText}</TooltipContent>
                    </Tooltip>
                  </>
                )}

                {/* State icon (compact spacing from title) */}
                {displayAgentState && StateIcon && (
                  <Tooltip open={stateTip.open} onOpenChange={stateTip.onOpenChange}>
                    <TooltipTrigger asChild onPointerEnter={stateTip.onPointerEnter}>
                      <div
                        className={cn(
                          "ml-1.5 flex items-center shrink-0",
                          getEffectiveStateColor(displayAgentState)
                        )}
                      >
                        <StateIcon
                          className={cn(
                            "w-3.5 h-3.5",
                            displayAgentState === "working" && "animate-spin-slow",
                            "motion-reduce:animate-none"
                          )}
                          aria-hidden="true"
                        />
                      </div>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">{`Agent ${displayAgentState}`}</TooltipContent>
                  </Tooltip>
                )}
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
            // Block Radix's own auto-focus; we focus the terminal ourselves once
            // its wrapper has been moved into the popover (see the focus effect).
            event.preventDefault();
          }}
        >
          <div className="relative w-full h-full group">
            <DockPopoverResizeHandle handleProps={handleProps} isResizing={isResizing} />
            {/* Portal target - content is rendered in DockPanelOffscreenContainer and portaled here */}
            <div
              ref={portalContainerRef}
              className="w-full h-full flex flex-col"
              data-dock-portal-target={terminal.id}
            />
          </div>
        </PopoverContent>
      </Popover>
    </DockPopoverChildProvider>
  );
}
