import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDndMonitor } from "@dnd-kit/core";
import type { DraggableSyntheticListeners } from "@dnd-kit/core";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useDragHandle } from "@/components/DragDrop/DragHandleContext";
import { cn } from "@/lib/utils";
import { useTerminalInputStore, usePanelStore, useFocusStore } from "@/store";
import { selectHomeFocusTarget } from "@/store/terminalInputStore";
import type { PtyPanelData } from "@shared/types/panel";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { useCcrPresetsStore } from "@/store/ccrPresetsStore";
import { useProjectPresetsStore } from "@/store/projectPresetsStore";
import { getMergedPresets } from "@/config/agents";
import { TerminalContextMenu } from "@/components/Terminal/TerminalContextMenu";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import { getTerminalFocusTarget } from "@/components/Terminal/terminalFocus";
import {
  paneSurfaceHoldingFocus,
  requestedPaneSurface,
} from "@/components/Terminal/paneFocusRequest";
import { deriveTerminalChrome } from "@/utils/terminalChrome";
import { getTerminalAgentDisplayState } from "@/utils/terminalAgentDisplayState";
import {
  getEffectiveStateLabel,
  SESSION_COLORS,
  SESSION_ICONS,
  SESSION_LABELS,
} from "@/components/Worktree/terminalStateConfig";
import { useRunSessionPresentation } from "@/hooks/useRunSessionPresentation";
import { TerminalRefreshTier } from "@/types";
import {
  peek as peekTerminalService,
  with as withTerminalService,
} from "@/services/terminal/terminalInstanceServiceAccessor";
import { DockActivityCue } from "./DockActivityCue";
import {
  PluginPanelActivityDockCue,
  pluginPanelActivityLabelSuffix,
  usePluginPanelActivity,
} from "@/components/Panel/PluginPanelActivity";
import { DockChipBadge, useDockChipBadge } from "./DockChipBadge";
import { dockChipBadgeLabelSuffix } from "./dockChipBadgeModel";
import { useDockPanelPortal } from "./dockPanelPortalContext";
import {
  DOCK_CHIP_CLASS,
  DOCK_CHIP_OPEN_CLASS,
  DOCK_CHIP_WAITING_CLASS,
  DOCK_CHIP_RULE_CLASS,
  DOCK_STATE_GLYPH_CLASS,
} from "./dockChipStyles";
import { useDockPopoverResize } from "./useDockPopoverResize";
import { DockPopoverResizeHandle } from "./DockPopoverResizeHandle";
import {
  getDockDisplayAgentState,
  isDockAgentStateDeprioritized,
  useDockBlockedState,
} from "./useDockBlockedState";
import { getDockDisplayActivityState, useTransientDockFinishedCue } from "./useDockActivityState";
import {
  handleDockInteractOutside,
  handleDockEscapeKeyDown,
  handleDockFocusOutside,
} from "./dockPopoverGuard";
import { usePreferencesStore } from "@/store";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useDismissableTooltip } from "@/hooks/useDismissableTooltip";
import { DockPopoverChildProvider } from "@/components/ui/DockPopoverChildContext";
import { animatePanelMove } from "@/components/Panel/animatePanelMove";
import { isScratchpadElement } from "@/lib/terminalScratchpad";
import { getTerminalDisplayTitle } from "@/utils/terminalTitleDisplay";
import { DockChipLabel } from "./DockChipLabel";

import { useRevealDockChipOnOpen } from "./useRevealDockChipOnOpen";
interface DockedTerminalItemProps {
  terminal: PtyPanelData;
  /** When this session started, given only when another chip shares its title. */
  sessionTag?: string;
}

export function DockedTerminalItem({ terminal, sessionTag }: DockedTerminalItemProps) {
  // Forward only the pointer/touch drag listeners SortableDockItem publishes via
  // DragHandleProvider, so the chip becomes a real drag source (reorder/eject)
  // instead of just grab-cursor styling. The KeyboardSensor's onKeyDown is
  // dropped on purpose: the chip is its own preview trigger, and dnd-kit's
  // Space/Enter handler calls preventDefault() to start a keyboard drag, which
  // would suppress this native <button>'s activation click — the sole keyboard
  // path to the chip's primary action. (Grid PanelHeader has no such conflict:
  // its drag surface is a non-interactive <div>.) The keyboard reorders chips
  // through `terminal.moveLeft`/`moveRight` instead (#14972).
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
  const titleTip = useDismissableTooltip();
  const dismissTips = () => {
    commandTip.dismiss();
    stateTip.dismiss();
    titleTip.dismiss();
  };

  const openDockTerminal = usePanelStore((s) => s.openDockTerminal);
  const closeDockTerminal = usePanelStore((s) => s.closeDockTerminal);
  const moveTerminalToGrid = usePanelStore((s) => s.moveTerminalToGrid);
  const backendStatus = usePanelStore((s) => s.backendStatus);
  const hybridInputEnabled = useTerminalInputStore((s) => s.hybridInputEnabled);

  // A boolean, not the raw id: opening or closing another chip's popover must
  // not re-render this one.
  const isOpen = usePanelStore((s) => s.activeDockTerminalId === terminal.id);
  const chipRef = useRevealDockChipOnOpen(isOpen);

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
        withTerminalService(
          (service) => service.applyRendererPolicy(terminal.id, TerminalRefreshTier.BACKGROUND),
          terminal.id
        );
      } catch (error) {
        console.warn(`Failed to apply dock state for terminal ${terminal.id}:`, error);
      }
      return;
    }

    if (!portalContainer) return;

    const rafId = requestAnimationFrame(() => {
      try {
        const dims = peekTerminalService()?.fit(terminal.id);
        if (!dims) return;
        peekTerminalService()?.applyRendererPolicy(terminal.id, TerminalRefreshTier.VISIBLE);
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
        if (isOpen) closeDockTerminal(terminal.id);
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
        closeDockTerminal(terminal.id);
      }
    },
    [terminal.id, openDockTerminal, closeDockTerminal]
  );

  // Move this terminal out of the dock and into the grid. Mirrors the
  // double-click backstop: only close the dock popover if the move succeeded
  // (the store wrapper clears activeDockTerminalId — see #4997).
  const handleMoveToGrid = useCallback(() => {
    animatePanelMove(terminal.id, "restore", () => {
      const moved = moveTerminalToGrid(terminal.id);
      if (moved) closeDockTerminal(terminal.id);
      return moved;
    });
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

  // Focus the terminal once the popover is open and its wrapper has been moved
  // in. The move effect above runs first (effects fire in declaration order),
  // so by the time this runs the terminal host is a live descendant of
  // PopoverContent. Honors the focus-preserve and hybrid-input skips (see #6959).
  useEffect(() => {
    if (!isOpen || !portalContainer) return;
    if (terminal.focusPolicy === "preserve") return;
    // Re-runs on agent chrome changes while open; never while the user is
    // writing in the pane's Scratchpad (#12835).
    if (isScratchpadElement(document.activeElement, terminal.id)) return;
    // Nor while its input bar holds the keyboard: what the user does inside
    // the pane stays inside it.
    if (paneSurfaceHoldingFocus(terminal.id) === "hybridInput") return;

    // Opening the popover is an arrival, so it lands on home; a drop or
    // type-anywhere that asked this pane for its hybrid input gets it. Home is
    // read rather than subscribed to: changing the setting isn't an arrival.
    const focusTarget = getTerminalFocusTarget({
      preferredTarget:
        requestedPaneSurface(terminal.id) ??
        selectHomeFocusTarget(useTerminalInputStore.getState()),
      hasHybridInputSurface: chrome.isAgent,
      isInputDisabled: backendStatus === "disconnected" || backendStatus === "recovering",
      hybridInputEnabled,
    });
    if (focusTarget === "hybridInput") return;

    peekTerminalService()?.focus(terminal.id);
  }, [
    isOpen,
    portalContainer,
    terminal.id,
    terminal.focusPolicy,
    chrome.isAgent,
    backendStatus,
    hybridInputEnabled,
  ]);

  const agentState = getDockDisplayAgentState(terminal);
  // Indicator stays visible for the lifetime of the agent chrome — idle/missing
  // state coerces to waiting so it never disappears mid-flight.
  const displayAgentState = getTerminalAgentDisplayState(chrome, agentState);
  // The run's fleet band decides the glyph, as on the pane's own chip: only an
  // unread Canopy ask is a wait, takes the amber ring and edges the chip.
  const shownAgentState = useRunSessionPresentation(terminal.id, displayAgentState);
  const isReinterpreted = shownAgentState !== displayAgentState;
  const isWorking = agentState === "working";
  const isWaiting = shownAgentState === "waiting";
  const isActive = isWorking || isWaiting;
  const commandText = terminal.activityHeadline || terminal.lastCommand;
  const blockedState = useDockBlockedState(isWaiting ? "waiting" : undefined);
  // Plain (non-agent) terminals surface their own running/finished affordance —
  // the agent path above returns undefined for them by design.
  const plainActivityState = getDockDisplayActivityState(terminal);
  const showFinishedCue = useTransientDockFinishedCue(plainActivityState, terminal.id);
  const plainWorking = plainActivityState === "working";
  // A PTY-backed plugin panel's own report, in the plain cue's slot: only where
  // no agent glyph is drawn, and never folded into the agent state (#13820).
  const reportedActivity = usePluginPanelActivity(terminal.id);
  const pluginActivity = displayAgentState ? null : reportedActivity;
  const badge = useDockChipBadge(terminal.id);
  const showDockAgentHighlights = usePreferencesStore((s) => s.showDockAgentHighlights);
  const showAgentTaskTitles = usePreferencesStore((s) => s.showAgentTaskTitles);
  // Four "Claude" chips are told apart by what each is doing, so the chip shows
  // the task alone, as the grid's tab strips do; the kind icon carries identity.
  // The full "Claude: task" goes to the tooltip and the accessible name.
  const displayTitle = getTerminalDisplayTitle(terminal, "compact", {
    showTask: showAgentTaskTitles,
  });
  const titleOnly = getTerminalDisplayTitle(terminal, "full", { showTask: showAgentTaskTitles });
  const fullTitle = sessionTag ? `${titleOnly}, started ${sessionTag}` : titleOnly;

  // A chip showing its task keeps the live command for the tooltip: inline,
  // the two squeeze each other to nothing. A plain terminal titled by its own
  // command ("npm run dev") doesn't repeat it either.
  const showsTask = titleOnly !== displayTitle;
  const showInlineCommand = !!commandText && !showsTask && commandText !== displayTitle;
  const titleTooltip =
    showsTask && commandText && (isActive || plainWorking)
      ? `${fullTitle} — ${commandText}`
      : fullTitle;
  const showTitleTip = titleTooltip !== displayTitle || displayTitle.length > 18;
  // The glyph is smoothed (idle/missing shows as waiting); the words are not.
  // Name and tooltip say what was observed, and nothing when nothing was.
  const observedStateLabel = agentState ? getEffectiveStateLabel(agentState) : undefined;
  // A state the band redrew is named for what it is drawn as; the observation
  // rides along.
  const stateLabel =
    isReinterpreted && shownAgentState ? SESSION_LABELS[shownAgentState] : observedStateLabel;
  const StateIcon = shownAgentState ? SESSION_ICONS[shownAgentState] : null;
  const pluginActive = pluginActivity?.shown === "working" || pluginActivity?.shown === "waiting";
  const isDeprioritized = !isOpen && !pluginActive && isDockAgentStateDeprioritized(agentState);

  // Re-fit the terminal once a resize gesture settles on a new popover height.
  const {
    height: popoverHeight,
    isResizing,
    handleProps,
  } = useDockPopoverResize(() => {
    requestAnimationFrame(() => {
      try {
        peekTerminalService()?.fit(terminal.id);
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
                ref={chipRef}
                // Keyboard arrival shows the full title the label may truncate,
                // as hovering it does; the name itself is in the aria-label.
                onFocus={(e) => {
                  if (showTitleTip && e.currentTarget.matches(":focus-visible")) {
                    titleTip.onOpenChange(true);
                  }
                }}
                onBlur={() => titleTip.onOpenChange(false)}
                {...dragPointerListeners}
                data-dock-item=""
                className={cn(
                  DOCK_CHIP_CLASS,
                  isOpen && DOCK_CHIP_OPEN_CLASS,
                  !isOpen &&
                    showDockAgentHighlights &&
                    (blockedState === "waiting" || pluginActivity?.shown === "waiting") &&
                    DOCK_CHIP_WAITING_CLASS,
                  isDeprioritized && "border-transparent"
                )}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  dismissTips();
                  if (e.detail >= 2) return;
                  if (isOpen) {
                    closeDockTerminal(terminal.id);
                  } else {
                    openDockTerminal(terminal.id);
                  }
                }}
                onDoubleClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  handleMoveToGrid();
                }}
                aria-label={`${fullTitle}${displayAgentState ? (stateLabel ? ` — agent ${stateLabel}` : "") : pluginActivity ? pluginPanelActivityLabelSuffix(pluginActivity) : plainWorking ? " — command running" : ""}${dockChipBadgeLabelSuffix(badge)} - Click to preview, double-click to move to grid, drag to reorder`}
              >
                <div className="flex items-center justify-center shrink-0">
                  <TerminalIcon kind={terminal.kind} chrome={chrome} className="w-3.5 h-3.5" />
                </div>
                {showTitleTip ? (
                  <Tooltip open={titleTip.open} onOpenChange={titleTip.onOpenChange}>
                    <TooltipTrigger asChild onPointerEnter={titleTip.onPointerEnter}>
                      <DockChipLabel title={displayTitle} />
                    </TooltipTrigger>
                    <TooltipContent side="top">{titleTooltip}</TooltipContent>
                  </Tooltip>
                ) : (
                  <DockChipLabel title={displayTitle} />
                )}
                {sessionTag && (
                  <span className="shrink-0 text-2xs text-text-secondary tabular-nums">
                    {sessionTag}
                  </span>
                )}
                <DockChipBadge model={badge} />

                {(isActive || plainWorking) && showInlineCommand && (
                  <>
                    <div className={DOCK_CHIP_RULE_CLASS} aria-hidden="true" />
                    <Tooltip open={commandTip.open} onOpenChange={commandTip.onOpenChange}>
                      <TooltipTrigger asChild onPointerEnter={commandTip.onPointerEnter}>
                        <span className="truncate flex-1 min-w-0 text-2xs text-text-secondary font-mono">
                          {commandText}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">{commandText}</TooltipContent>
                    </Tooltip>
                  </>
                )}

                {pluginActivity ? (
                  <PluginPanelActivityDockCue activity={pluginActivity} />
                ) : (
                  !displayAgentState &&
                  (plainWorking || showFinishedCue) && (
                    <DockActivityCue state={plainWorking ? "working" : "finished"} />
                  )
                )}

                {/* State icon (compact spacing from title) */}
                {shownAgentState && StateIcon && (
                  <Tooltip open={stateTip.open} onOpenChange={stateTip.onOpenChange}>
                    <TooltipTrigger asChild onPointerEnter={stateTip.onPointerEnter}>
                      <div
                        className={cn(
                          "ml-1.5 flex items-center shrink-0 transition-[color] duration-150 ease-out",
                          SESSION_COLORS[shownAgentState]
                        )}
                      >
                        <StateIcon
                          className={cn(
                            DOCK_STATE_GLYPH_CLASS,
                            shownAgentState === "working" && "animate-spin-slow",
                            "motion-reduce:animate-none"
                          )}
                          aria-hidden="true"
                        />
                      </div>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      {stateLabel
                        ? isReinterpreted
                          ? `Agent ${stateLabel} · Observed: ${observedStateLabel}`
                          : `Agent ${stateLabel}`
                        : "No agent state observed"}
                    </TooltipContent>
                  </Tooltip>
                )}
              </button>
            </PopoverTrigger>
          </TerminalContextMenu>
        </div>

        <PopoverContent
          aria-label={`Preview: ${fullTitle}`}
          className="w-[700px] max-w-[90vw] max-h-[80vh] p-0 bg-daintree-bg/95 backdrop-blur-sm border border-[var(--border-dock-popup)] shadow-[var(--shadow-dock-panel-popover)] rounded-[var(--radius-lg)] overflow-hidden"
          style={{ height: popoverHeight }}
          side="top"
          align="start"
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
