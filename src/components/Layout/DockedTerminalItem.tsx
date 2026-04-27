import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useDndMonitor } from "@dnd-kit/core";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn, getBaseTitle } from "@/lib/utils";
import {
  useTerminalInputStore,
  usePanelStore,
  usePortalStore,
  useFocusStore,
  type TerminalInstance,
} from "@/store";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { useCcrPresetsStore } from "@/store/ccrPresetsStore";
import { useProjectPresetsStore } from "@/store/projectPresetsStore";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { getMergedPresets } from "@/config/agents";
import { TerminalContextMenu } from "@/components/Terminal/TerminalContextMenu";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import { getTerminalFocusTarget } from "@/components/Terminal/terminalFocus";
import { deriveTerminalChrome } from "@/utils/terminalChrome";
import {
  getEffectiveStateIcon,
  getEffectiveStateColor,
} from "@/components/Worktree/terminalStateConfig";
import { TerminalRefreshTier } from "@/types";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { useDockPanelPortal } from "./DockPanelOffscreenContainer";
import { getDockDisplayAgentState, useDockBlockedState } from "./useDockBlockedState";
import { handleDockInteractOutside, handleDockEscapeKeyDown } from "./dockPopoverGuard";
import { usePreferencesStore } from "@/store";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface DockedTerminalItemProps {
  terminal: TerminalInstance;
}

export function DockedTerminalItem({ terminal }: DockedTerminalItemProps) {
  const activeDockTerminalId = usePanelStore((s) => s.activeDockTerminalId);
  const openDockTerminal = usePanelStore((s) => s.openDockTerminal);
  const closeDockTerminal = usePanelStore((s) => s.closeDockTerminal);
  const moveTerminalToGrid = usePanelStore((s) => s.moveTerminalToGrid);
  const backendStatus = usePanelStore((s) => s.backendStatus);
  const hybridInputEnabled = useTerminalInputStore((s) => s.hybridInputEnabled);
  const hybridInputAutoFocus = useTerminalInputStore((s) => s.hybridInputAutoFocus);
  const isFleetHybridInputMember = useFleetArmingStore(
    (s) => s.armedIds.has(terminal.id) && s.armedIds.size >= 2
  );

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

  const { isOpen: portalOpen, width: portalWidth } = usePortalStore(
    useShallow((s) => ({ isOpen: s.isOpen, width: s.width }))
  );

  const isFocusMode = useFocusStore((s) => s.isFocusMode);

  const collisionPadding = useMemo(() => {
    const basePadding = 32;
    return {
      top: basePadding,
      left: isFocusMode ? 8 : basePadding,
      bottom: basePadding,
      right: portalOpen ? portalWidth + basePadding : basePadding,
    };
  }, [isFocusMode, portalOpen, portalWidth]);

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
  const [portalContainer, setPortalContainer] = useState<HTMLDivElement | null>(null);

  // Use callback ref to capture the DOM element when it mounts
  const portalContainerRef = useCallback((node: HTMLDivElement | null) => {
    setPortalContainer(node);
  }, []);

  // Register/unregister portal target when popover opens and container is available
  useEffect(() => {
    if (isOpen && portalContainer) {
      portalTarget(terminal.id, portalContainer);
    } else {
      portalTarget(terminal.id, null);
    }

    return () => {
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
  const brandColor = useMemo(() => {
    const fallbackColor = baseChrome.color;
    if (!terminal.agentPresetId || !terminal.launchAgentId) return fallbackColor;
    const preset = getMergedPresets(
      terminal.launchAgentId,
      presetCustomPresets,
      presetCcrPresets,
      presetProjectPresets
    ).find((f) => f.id === terminal.agentPresetId);
    return preset?.color ?? terminal.agentPresetColor ?? fallbackColor;
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

  const agentState = chrome.isAgent ? getDockDisplayAgentState(terminal) : undefined;
  const isWorking = agentState === "working";
  const isWaiting = agentState === "waiting";
  const isActive = isWorking || isWaiting;
  const commandText = terminal.activityHeadline || terminal.lastCommand;
  const blockedState = useDockBlockedState(agentState);
  const showDockAgentHighlights = usePreferencesStore((s) => s.showDockAgentHighlights);
  // Use shortened title without command summary for dock items
  const displayTitle = getBaseTitle(terminal.title);
  // Only show icon for non-idle, non-completed states (reduce noise)
  const showStateIcon =
    agentState && agentState !== "idle" && agentState !== "completed" && agentState !== "exited";
  const StateIcon = showStateIcon
    ? getEffectiveStateIcon(agentState, terminal.waitingReason)
    : null;
  const isDeprioritized =
    !isOpen &&
    (!agentState || agentState === "idle" || agentState === "completed" || agentState === "exited");

  return (
    <Popover open={isOpen} onOpenChange={handleOpenChange}>
      <TerminalContextMenu terminalId={terminal.id} forceLocation="dock">
        <PopoverTrigger asChild>
          <button
            className={cn(
              "flex items-center gap-1.5 px-3 h-[var(--dock-item-height)] rounded-[var(--radius-md)] text-xs border transition duration-150 max-w-[280px]",
              "bg-[var(--dock-item-bg)] border-[var(--dock-item-border)] text-daintree-text/70",
              "hover:text-daintree-text hover:bg-[var(--dock-item-bg-hover)]",
              "focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2",
              "cursor-grab active:cursor-grabbing",
              isOpen &&
                "bg-[var(--dock-item-bg-active)] text-daintree-text border-[var(--dock-item-border-active)] ring-1 ring-inset ring-daintree-accent/30",
              !isOpen &&
                showDockAgentHighlights &&
                blockedState === "waiting" &&
                "bg-[var(--dock-item-bg-waiting)] border-[var(--dock-item-border-waiting)]",
              isDeprioritized && "opacity-50"
            )}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
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
              const moved = moveTerminalToGrid(terminal.id);
              if (moved) closeDockTerminal();
            }}
            aria-label={`${terminal.title} - Click to preview, double-click to move to grid, drag to reorder`}
          >
            <div className="flex items-center justify-center shrink-0">
              <TerminalIcon kind={terminal.kind} chrome={chrome} className="w-3.5 h-3.5" />
            </div>
            <span className="truncate min-w-[48px] max-w-[140px] font-sans font-medium">
              {displayTitle}
            </span>

            {isActive && commandText && (
              <>
                <div className="h-3 w-px bg-border-subtle shrink-0" aria-hidden="true" />
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="truncate flex-1 min-w-0 text-[11px] text-daintree-text/50 font-mono">
                      {commandText}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">{commandText}</TooltipContent>
                </Tooltip>
              </>
            )}

            {/* State icon (compact spacing from title) */}
            {showStateIcon && StateIcon && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <div
                    className={cn(
                      "flex items-center shrink-0",
                      getEffectiveStateColor(agentState, terminal.waitingReason)
                    )}
                  >
                    <StateIcon
                      className={cn(
                        "w-3.5 h-3.5",
                        agentState === "working" && "animate-spin-slow",
                        "motion-reduce:animate-none"
                      )}
                      aria-hidden="true"
                    />
                  </div>
                </TooltipTrigger>
                <TooltipContent side="bottom">{`Agent ${agentState}`}</TooltipContent>
              </Tooltip>
            )}
          </button>
        </PopoverTrigger>
      </TerminalContextMenu>

      <PopoverContent
        className="w-[700px] max-w-[90vw] h-[500px] max-h-[80vh] p-0 bg-daintree-bg/95 backdrop-blur-sm border border-[var(--border-dock-popup)] shadow-[var(--shadow-dock-panel-popover)] rounded-[var(--radius-lg)] overflow-hidden"
        side="top"
        align="start"
        sideOffset={10}
        collisionPadding={collisionPadding}
        onInteractOutside={(e) => handleDockInteractOutside(e, portalContainer)}
        onEscapeKeyDown={(e) => handleDockEscapeKeyDown(e, portalContainer)}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          const focusTarget = getTerminalFocusTarget({
            hasHybridInputSurface: chrome.isAgent || isFleetHybridInputMember,
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
