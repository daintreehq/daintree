import {
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { getBrandColorHex } from "@/lib/colorUtils";
import { BrandMark } from "@/components/icons";
import { getAgentConfig, getMergedPresets } from "@/config/agents";
import { useAriaKeyshortcuts, useKeybindingDisplay, useShortcutHintHover } from "@/hooks";
import { createTooltipContent } from "@/lib/tooltipShortcut";
import { useWorktrees } from "@/hooks/useWorktrees";
import { actionService } from "@/services/ActionService";
import {
  ContextMenu,
  ContextMenuActionItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { MenuActionSourceContext, useMenuActionSource } from "@/components/ui/menu-source";
import { Check, ChevronDown, Circle, ExternalLink, PanelBottom } from "lucide-react";
import type { BuiltInAgentId } from "@shared/config/agentIds";
import type { AgentExternalLink } from "@shared/config/agentRegistry";
import type { AgentAvailabilityState, AgentState } from "@shared/types";
import {
  isAgentLaunchable,
  isAgentInstalled,
  isAgentUnauthenticated,
} from "../../../shared/utils/agentAvailability";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";

import { useCcrPresetsStore } from "@/store/ccrPresetsStore";
import { useProjectPresetsStore } from "@/store/projectPresetsStore";
import { usePanelStore } from "@/store/panelStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import { ToolbarContextMenuItems } from "./ToolbarContextMenuItems";
import { unavailableAgentHint } from "@/utils/agentAvailabilityCopy";

import { resolveEffectivePresetId } from "@shared/types";
import {
  getDominantAgentState,
  agentStateDotColor,
} from "@/components/Worktree/AgentStatusIndicator";
import { STATE_LABELS } from "@/components/Worktree/terminalStateConfig";
import { getRuntimeOrBootAgentId } from "@/utils/terminalType";
import { isPtyPanel } from "@shared/types/panel";

type AgentType = BuiltInAgentId;

const ACTIVE_AGENT_STATES: ReadonlySet<AgentState | undefined> = new Set<AgentState | undefined>([
  "idle",
  "working",
  "waiting",
  "directing",
]);

interface AgentButtonProps {
  type: AgentType;
  availability?: AgentAvailabilityState;
  "data-toolbar-item"?: string;
}

const stopPointer = (e: ReactPointerEvent) => {
  e.stopPropagation();
};

// Owns its own leading separator so both ContextMenuContent blocks stay
// symmetrical — agents without links render nothing, including the separator.
function AgentExternalLinkItems({ links }: { links?: AgentExternalLink[] }) {
  if (!links || links.length === 0) return null;
  return (
    <>
      <ContextMenuSeparator />
      {links.map((link) => (
        <ContextMenuActionItem
          key={link.url}
          actionId="system.openExternal"
          args={{ url: link.url }}
        >
          <ExternalLink className="mr-2 h-3.5 w-3.5" />
          {link.label}
        </ContextMenuActionItem>
      ))}
    </>
  );
}

interface WorktreeMenuItemsProps {
  agentType: AgentType;
}

// Flattens the worktree picker from a nested 3-deep submenu (worktree →
// Grid/Dock) into one row per worktree. Row click (and keyboard Enter)
// launches in grid; the inline Dock affordance gives mouse users the
// secondary location without a second submenu hop, mirroring the pin
// button pattern in DockLaunchButton.
//
// Closing-the-menu mechanics: Radix ContextMenu Root has no `open` prop,
// so we can't use a controlled-state shortcut. Instead, the inline Dock
// click is allowed to bubble to the parent ContextMenuItem so Radix's
// normal handleSelect → onClose chain still fires (which is what closes
// the menu). To avoid double-firing the row's grid dispatch on top of
// the dock dispatch, the inline button sets a ref before bubbling; the
// row's onSelect honors the ref and skips the grid dispatch when set.
// pointerDown/pointerUp still stopPropagation to keep Radix from
// treating the icon press as the row's primary selection event.
function WorktreeMenuItems({ agentType }: WorktreeMenuItemsProps) {
  const { worktrees } = useWorktrees();
  const dockClickedRef = useRef(false);
  const source = useMenuActionSource();
  return (
    <>
      {worktrees.map((wt) => {
        const label = wt.isMainWorktree ? wt.name : wt.branch?.trim() || wt.name;
        return (
          <ContextMenuItem
            key={wt.id}
            className="group/wt-row pr-1"
            data-testid={`agent-context-worktree-${wt.id}`}
            onSelect={() => {
              if (dockClickedRef.current) {
                dockClickedRef.current = false;
                return;
              }
              void actionService.dispatch(
                "agent.launch",
                { agentId: agentType, worktreeId: wt.id, location: "grid" },
                { source }
              );
            }}
          >
            <span className="flex-1 truncate">{label}</span>
            <span
              role="presentation"
              aria-hidden="true"
              data-testid={`agent-context-worktree-dock-${wt.id}`}
              title="Launch in dock"
              onPointerDown={stopPointer}
              onPointerUp={stopPointer}
              onClick={() => {
                dockClickedRef.current = true;
                void actionService.dispatch(
                  "agent.launch",
                  { agentId: agentType, worktreeId: wt.id, location: "dock" },
                  { source }
                );
              }}
              className="ml-2 inline-flex h-5 w-5 items-center justify-center rounded-sm text-daintree-text/50 opacity-0 transition-opacity hover:bg-overlay-emphasis hover:text-text-primary group-data-[highlighted]/wt-row:opacity-100"
            >
              <PanelBottom className="h-3 w-3" />
            </span>
          </ContextMenuItem>
        );
      })}
    </>
  );
}

export function AgentButton({
  type,
  availability,
  "data-toolbar-item": dataToolbarItem,
}: AgentButtonProps) {
  const hasWorktrees = useWorktreeStore((s) => s.worktrees.size > 0);
  const displayCombo = useKeybindingDisplay(`agent.${type}`);
  const ariaShortcut = useAriaKeyshortcuts(`agent.${type}`);
  const hover = useShortcutHintHover(`agent.${type}`);
  const agentSettings = useAgentSettingsStore((s) => s.settings);
  const setAgentPinned = useAgentSettingsStore((s) => s.setAgentPinned);
  const ccrPresets = useCcrPresetsStore((s) => s.ccrPresetsByAgent[type]);
  const projectPresets = useProjectPresetsStore((s) => s.presetsByAgent[type]);

  const activeWorktreeId = useWorktreeSelectionStore((s) => s.activeWorktreeId);

  // Radix Tooltip reopens on focus restoration. When the chevron's
  // DropdownMenu or the right-click ContextMenu closes, Radix returns focus to
  // the trigger and the tooltip would reopen on top of the freshly-launched
  // action's surfaces. Gate both halves' tooltips on controlled state and hold
  // suppression open until the next genuine pointer hover. Same pattern as
  // DockLaunchButton.
  const [primaryTooltipOpen, setPrimaryTooltipOpen] = useState(false);
  const [chevronTooltipOpen, setChevronTooltipOpen] = useState(false);
  // The chevron dropdown is controlled so a label-zone click can close it
  // explicitly (see renderPresetRow). A worktree-default click in the gutter
  // zone must keep it open, which Radix's default per-item dismiss can't
  // express — controlled state is the only lever that lets one row both
  // close (launch) and stay open (set default). See issue #10720.
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const isRestoringFocusRef = useRef(false);
  // Set in onPointerDownOutside, read in onCloseAutoFocus. Lets us
  // preventDefault() the focus restoration only for pointer dismissals so the
  // chevron doesn't keep its accent focus-visible ring; keyboard close
  // (Escape/Enter) still gets default focus return for WAI-ARIA.
  const wasPointerCloseRef = useRef(false);

  const handlePrimaryTooltipOpenChange = (open: boolean) => {
    if (open && isRestoringFocusRef.current) return;
    setPrimaryTooltipOpen(open);
  };

  const handleChevronTooltipOpenChange = (open: boolean) => {
    if (open && isRestoringFocusRef.current) return;
    setChevronTooltipOpen(open);
  };

  const suppressTooltipsDuringFocusRestore = () => {
    setPrimaryTooltipOpen(false);
    setChevronTooltipOpen(false);
    isRestoringFocusRef.current = true;
  };

  const clearFocusRestoreSuppression = () => {
    isRestoringFocusRef.current = false;
  };

  // Single useShallow selector — scoped to the active worktree's pre-computed
  // bucket so per-terminal ticks in unrelated worktrees do not re-evaluate this
  // selector body. When `activeWorktreeId` is null, fall back to scanning all
  // panel ids (rare, only during project switch hydration). See issue #7451.
  const activeSession = usePanelStore(
    useShallow((state) => {
      const ids = activeWorktreeId ? state.panelIdsByWorktreeId[activeWorktreeId] : state.panelIds;
      if (!ids || ids.length === 0) return null;
      const states: (AgentState | undefined)[] = [];
      let firstId: string | null = null;
      for (const pid of ids) {
        const p = state.panelsById[pid];
        if (!p || !isPtyPanel(p)) continue;
        if (getRuntimeOrBootAgentId(p) !== type) continue;
        if (p.location === "trash" || p.location === "background" || p.location === "overlay")
          continue;
        if (!ACTIVE_AGENT_STATES.has(p.agentState)) continue;
        if (!firstId) firstId = pid;
        states.push(p.agentState);
      }
      if (!firstId) return null;
      return { id: firstId, dominantState: getDominantAgentState(states) };
    })
  );

  const config = getAgentConfig(type);
  if (!config) return null;

  const isSessionActive = activeSession !== null;
  const dominantState = activeSession?.dominantState ?? null;

  const entry = agentSettings?.agents?.[type] ?? {};
  const presets = getMergedPresets(type, entry.customPresets, ccrPresets, projectPresets);
  // Show the split/chevron UI when there is at least one named preset; the
  // dropdown always renders the implicit "Default" entry alongside it, so one
  // named preset already gives the user two real launch choices.
  const hasPresets = presets.length >= 1;
  // Worktree-scoped pick wins over the agent-level default so switching
  // worktrees doesn't silently surface another worktree's selection.
  const savedPresetId = resolveEffectivePresetId(entry, activeWorktreeId);
  const activePreset = savedPresetId ? presets.find((p) => p.id === savedPresetId) : undefined;
  // CCR presets carry the routing prefix in their stored name; strip it for
  // display so the tooltip and menu surfaces show the same human label.
  const activePresetName = activePreset
    ? (activePreset.displayTitle ?? activePreset.name.replace(/^CCR:\s*/, ""))
    : null;
  // Group by source. Project presets are identified by membership so that a
  // project preset whose id happens to start with "ccr-" still lands in
  // "Project Shared" rather than being stolen by the CCR group. Everything
  // that isn't CCR-prefixed or project-member falls through to the "Custom"
  // bucket — this preserves the historical rendering for user-authored
  // presets regardless of whether they're also in `entry.customPresets`.
  const projectPresetIds = new Set((projectPresets ?? []).map((f) => f.id));
  const projectPresetGroup = presets.filter((f) => projectPresetIds.has(f.id));
  const ccrPresetGroup = presets.filter(
    (f) => !projectPresetIds.has(f.id) && f.id.startsWith("ccr-")
  );
  const customPresetGroup = presets.filter(
    (f) => !projectPresetIds.has(f.id) && !f.id.startsWith("ccr-")
  );
  const presetGroupCount =
    (ccrPresetGroup.length > 0 ? 1 : 0) +
    (projectPresetGroup.length > 0 ? 1 : 0) +
    (customPresetGroup.length > 0 ? 1 : 0);
  const hasMultiplePresetGroups = presetGroupCount > 1;

  const isLoading = availability === undefined;
  const isLaunchable = isAgentLaunchable(availability);
  // `installed` now only fires for WSL-capped binaries (launch not wired
  // through wsl.exe yet); all other binary-on-PATH agents reach `ready`.
  // `needsSetup` dims the button for these genuinely non-launchable cases —
  // presentation only. Clicking still launches; the gate owns recovery (#11760).
  const needsSetup = isAgentInstalled(availability) && !isLaunchable;
  // Surfaced in the tooltip only — launchable agents whose passive auth
  // probe came back empty get a soft cue rather than a disabled look,
  // because the CLI itself will prompt for sign-in on first run.
  const signInUnconfirmed = isAgentUnauthenticated(availability);

  // Same gate the corner dot uses (issue #9823, #5900). When a dot renders,
  // dominantState is one of {waiting, directing} — STATE_LABELS has a human
  // word for every dot-bearing state, so the suffix is always meaningful.
  // Moved above the tooltip/aria ternaries so they can consume it.
  const dotColor = dominantState ? agentStateDotColor(dominantState) : null;
  const visibleStateSuffix = dotColor ? ` — ${STATE_LABELS[dominantState!]}` : "";
  // Suppress the at-rest split-button seam when the chevron is gated — the
  // chevron blocks clicks in these states anyway (issue #8131), so a seam
  // would advertise a control that isn't usable.
  const showSeam = !isLoading && isLaunchable;

  const presetSegment = activePresetName ? ` · ${activePresetName}` : "";
  // The click still launches when the CLI is unavailable — it lands on the
  // recovery panel, not Settings — so both surfaces borrow the dock's hint
  // rather than naming an action this button no longer performs (#11760).
  const unavailableLabel = unavailableAgentHint(config.name, availability);
  const tooltipLabel = isLoading
    ? `Checking ${config.name} CLI…`
    : isLaunchable
      ? signInUnconfirmed
        ? `Start ${config.name}${presetSegment}${visibleStateSuffix} — sign-in not detected`
        : `Start ${config.name}${presetSegment}${visibleStateSuffix}`
      : unavailableLabel;
  const tooltipShortcut = isLaunchable ? displayCombo : undefined;
  const chevronTooltip = isLoading
    ? `Checking ${config.name} CLI availability...`
    : isLaunchable
      ? `Set ${config.name} preset`
      : needsSetup
        ? // The chevron blocks clicks when not launchable, so its copy names
          // the precondition alone — unlike the primary button, it opens
          // nothing, so it must not offer the recovery route.
          `${config.name} needs setup`
        : `${config.name} CLI not found`;
  const isChevronDisabled = isLoading || !isLaunchable;

  const ariaLabel = isLoading
    ? `Checking ${config.name} CLI`
    : isLaunchable
      ? `Start ${config.name}${visibleStateSuffix}`
      : unavailableLabel;

  const handleClick = (e?: ReactMouseEvent<HTMLElement>) => {
    if (isLoading) return;
    // Drop focus on launch so Enter at a CLI prompt can't re-fire this button
    // and spawn a duplicate agent before the input bar claims focus. See #10541.
    // Unconditional: an unavailable agent now opens a recovery panel that can
    // take Enter just as readily, so the blur can't be scoped to the ready path.
    e?.currentTarget?.blur();
    // Every click dispatches the launch, whatever the last probe reported.
    // `useAgentLauncher` re-probes availability and owns the decision to spawn a
    // PTY or a missing-CLI recovery panel, so routing to Settings here would
    // both act on a stale reading and skip the gate entirely (#11760).
    //
    // Defer all preset resolution to useAgentLauncher. Forwarding the
    // resolved savedPresetId explicitly would block the launcher's
    // stale-fallback path: when a worktree-scoped pick references a
    // deleted preset, an explicit presetId bypasses the agent-level
    // default and launches preset-free instead. Omitting presetId lets
    // the launcher run resolveEffectivePresetId + fallback in one place.
    void actionService.dispatch("agent.launch", { agentId: type }, { source: "user" });
  };

  // Per-agent unpin: agent IDs read pin state from agentSettingsStore
  // (tri-state — see isAgentToolbarVisible / #7673), not from
  // pinnedButtons. The wrapper's default toggleButtonVisibility writes
  // to the wrong store, so override it here.
  const handleUnpinFromToolbar = () => {
    void setAgentPinned(type, false);
  };

  // Persist the toolbar pick to the worktree-scoped slot so repeated launches
  // on the same worktree stay stable, while other worktrees keep their own
  // defaults. Pass `undefined` to clear the worktree override (returning the
  // button to the agent-level default). Guard on activeWorktreeId — when no
  // worktree is active we skip persistence entirely rather than polluting the
  // global scope.
  const persistWorktreePick = (presetId: string | undefined) => {
    if (!activeWorktreeId) return;
    void useAgentSettingsStore.getState().updateWorktreePreset(type, activeWorktreeId, presetId);
  };

  // Launch from a dropdown row's label zone. Unlike the primary button, the
  // row names an explicit preset, so we forward it directly rather than
  // deferring to the launcher's resolveEffectivePresetId path. Set
  // wasPointerCloseRef before closing so the controlled dismiss runs the same
  // focus-restore suppression as a Radix pointer dismiss — otherwise the
  // chevron tooltip reopens over the freshly-launched terminal (issue #5171).
  const launchWithPreset = (presetId: string | null) => {
    wasPointerCloseRef.current = true;
    setDropdownOpen(false);
    void actionService.dispatch("agent.launch", { agentId: type, presetId }, { source: "user" });
  };

  // Each preset row carries two click zones. The left gutter (data-zone
  // "gutter") sets the worktree-scoped default without launching and keeps the
  // menu open; the rest of the row (the label) launches immediately with that
  // preset and closes the menu. onSelect is preventDefault'd so Radix never
  // auto-dismisses — the label zone owns closing — and the zones live inside a
  // single menuitem (no nested interactive element) so the row stays
  // ARIA-valid. Keyboard activation lands on the row itself, which launches.
  // See issue #10720.
  const renderPresetRow = (preset: {
    id: string;
    name: string;
    color?: string;
    displayTitle?: string;
  }) => {
    const isDefault = savedPresetId === preset.id;
    const presetColor = preset.color ?? getBrandColorHex(type);
    return (
      <DropdownMenuItem
        key={preset.id}
        className="group/preset-row items-stretch py-0 pr-2.5 pl-0"
        onSelect={(e) => e.preventDefault()}
        onClick={(e) => {
          // Element (not HTMLElement) so a click landing on the gutter's SVG
          // icon — an SVGElement — still resolves; closest() lives on Element.
          if (e.target instanceof Element && e.target.closest('[data-zone="gutter"]')) {
            persistWorktreePick(preset.id);
            return;
          }
          launchWithPreset(preset.id);
        }}
      >
        <span
          data-zone="gutter"
          title={isDefault ? "Current default" : "Set as default"}
          className="flex w-8 shrink-0 items-center justify-center self-stretch rounded-l-[var(--radius-sm)] text-daintree-text/60 transition-colors hover:bg-overlay-raised"
        >
          {isDefault ? (
            <Check className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <Circle
              className="h-2.5 w-2.5 opacity-0 transition-opacity duration-150 group-hover/preset-row:opacity-40"
              aria-hidden="true"
            />
          )}
        </span>
        <span data-zone="label" className="flex min-w-0 flex-1 items-center py-1.5">
          <span className="inline-flex h-4 w-4 items-center justify-center shrink-0 mr-1.5">
            <BrandMark brandColor={presetColor}>
              <config.icon />
            </BrandMark>
          </span>
          {preset.displayTitle ?? preset.name.replace(/^CCR:\s*/, "")}
        </span>
      </DropdownMenuItem>
    );
  };

  const toolbarBrandColor = getBrandColorHex(type);
  const iconElement = (
    <div className="relative">
      <BrandMark brandColor={toolbarBrandColor}>
        <config.icon />
      </BrandMark>
      <span
        className={cn("toolbar-pip toolbar-badge", dotColor)}
        data-visible={!!(isSessionActive && dotColor)}
        aria-hidden="true"
      />
    </div>
  );

  if (!hasPresets) {
    return (
      <ContextMenu
        onOpenChange={(open) => {
          if (open) {
            setPrimaryTooltipOpen(false);
            setChevronTooltipOpen(false);
          }
        }}
      >
        <ContextMenuTrigger asChild>
          {/* Real DOM element as the trigger child: ContextMenuTrigger's
              asChild Slot binds onContextMenu + ref here. Wrapping <Tooltip>
              directly drops both (Tooltip.Root is a non-DOM provider), so
              right-click never opens the menu. Mirrors the presets branch. */}
          <span className="inline-flex">
            <Tooltip open={primaryTooltipOpen} onOpenChange={handlePrimaryTooltipOpenChange}>
              <TooltipTrigger asChild>
                <span className="inline-flex">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={handleClick}
                    aria-disabled={isLoading || undefined}
                    data-toolbar-item={dataToolbarItem}
                    onPointerEnter={(e) => {
                      clearFocusRestoreSuppression();
                      hover.onPointerEnter(e);
                    }}
                    onPointerLeave={hover.onPointerLeave}
                    onPointerDown={hover.onPointerDown}
                    onFocus={hover.onFocus}
                    onBlur={hover.onBlur}
                    className={cn(
                      "toolbar-agent-button text-text-primary relative",
                      needsSetup && "opacity-70",
                      "aria-disabled:opacity-50 aria-disabled:cursor-not-allowed"
                    )}
                    aria-label={ariaLabel}
                    aria-keyshortcuts={ariaShortcut}
                  >
                    {iconElement}
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {createTooltipContent(tooltipLabel, tooltipShortcut)}
              </TooltipContent>
            </Tooltip>
          </span>
        </ContextMenuTrigger>
        <ContextMenuContent
          className="max-h-[var(--radix-context-menu-content-available-height)] overflow-y-auto"
          onPointerDownOutside={() => {
            wasPointerCloseRef.current = true;
          }}
          onCloseAutoFocus={(e) => {
            suppressTooltipsDuringFocusRestore();
            if (wasPointerCloseRef.current) {
              e.preventDefault();
              wasPointerCloseRef.current = false;
            }
          }}
        >
          <ContextMenuActionItem actionId="agent.launch" args={{ agentId: type }}>
            Launch {config.name}
          </ContextMenuActionItem>
          <ContextMenuActionItem actionId="agent.launch" args={{ agentId: type, location: "dock" }}>
            Launch {config.name} in Dock
          </ContextMenuActionItem>
          {hasWorktrees && (
            <ContextMenuSub>
              <ContextMenuSubTrigger>Launch in Worktree</ContextMenuSubTrigger>
              <ContextMenuSubContent className="max-h-[var(--radix-context-menu-content-available-height)] overflow-y-auto">
                <WorktreeMenuItems agentType={type} />
              </ContextMenuSubContent>
            </ContextMenuSub>
          )}
          <ContextMenuSeparator />
          <ToolbarContextMenuItems buttonId={type} side="left" onUnpin={handleUnpinFromToolbar} />
          <ContextMenuActionItem
            actionId="app.settings.openTab"
            args={{ tab: "agents", subtab: type, sectionId: "agents-presets" }}
          >
            Manage {config.name} Presets...
          </ContextMenuActionItem>
          <ContextMenuActionItem
            actionId="app.settings.openTab"
            args={{ tab: "agents", subtab: type }}
          >
            {config.name} Settings...
          </ContextMenuActionItem>
          <AgentExternalLinkItems links={config.externalLinks} />
        </ContextMenuContent>
      </ContextMenu>
    );
  }

  return (
    <ContextMenu
      onOpenChange={(open) => {
        if (open) {
          setPrimaryTooltipOpen(false);
          setChevronTooltipOpen(false);
        }
      }}
    >
      <ContextMenuTrigger asChild>
        <span className="inline-flex group/agent-split">
          <Tooltip open={primaryTooltipOpen} onOpenChange={handlePrimaryTooltipOpenChange}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={handleClick}
                aria-disabled={isLoading || undefined}
                data-toolbar-item={dataToolbarItem}
                onPointerEnter={(e) => {
                  clearFocusRestoreSuppression();
                  hover.onPointerEnter(e);
                }}
                onPointerLeave={hover.onPointerLeave}
                onPointerDown={hover.onPointerDown}
                onFocus={hover.onFocus}
                onBlur={hover.onBlur}
                className={cn(
                  "toolbar-agent-button text-text-primary rounded-r-none border-r border-transparent relative",
                  showSeam && "toolbar-agent-split-seam",
                  needsSetup && "opacity-70",
                  "aria-disabled:opacity-50 aria-disabled:cursor-not-allowed"
                )}
                aria-label={ariaLabel}
                aria-keyshortcuts={ariaShortcut}
              >
                {iconElement}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {createTooltipContent(tooltipLabel, tooltipShortcut)}
            </TooltipContent>
          </Tooltip>
          <DropdownMenu
            open={dropdownOpen}
            onOpenChange={(open) => {
              setDropdownOpen(open);
              if (open) {
                setPrimaryTooltipOpen(false);
                setChevronTooltipOpen(false);
              }
            }}
          >
            <Tooltip open={chevronTooltipOpen} onOpenChange={handleChevronTooltipOpenChange}>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    aria-disabled={isChevronDisabled || undefined}
                    onPointerDown={(e) => {
                      if (isChevronDisabled) e.preventDefault();
                    }}
                    onKeyDown={(e) => {
                      if (
                        isChevronDisabled &&
                        (e.key === "Enter" || e.key === " " || e.key === "ArrowDown")
                      ) {
                        e.preventDefault();
                      }
                    }}
                    onClick={(e) => {
                      if (isChevronDisabled) e.preventDefault();
                    }}
                    data-toolbar-item={dataToolbarItem}
                    onPointerEnter={clearFocusRestoreSuppression}
                    className={cn(
                      "toolbar-agent-button text-text-primary rounded-l-none",
                      "h-8 w-6 p-0 flex items-center justify-center",
                      "aria-disabled:opacity-60 aria-disabled:cursor-not-allowed"
                    )}
                    aria-label={chevronTooltip}
                  >
                    <ChevronDown className="h-3 w-3" />
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="bottom">{chevronTooltip}</TooltipContent>
            </Tooltip>
            <DropdownMenuContent
              align="start"
              sideOffset={4}
              className="min-w-[12rem] max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto"
              onPointerDownOutside={() => {
                wasPointerCloseRef.current = true;
              }}
              onCloseAutoFocus={(e) => {
                suppressTooltipsDuringFocusRestore();
                if (wasPointerCloseRef.current) {
                  e.preventDefault();
                  wasPointerCloseRef.current = false;
                }
              }}
            >
              <DropdownMenuItem
                className="group/preset-row items-stretch py-0 pr-2.5 pl-0"
                onSelect={(e) => e.preventDefault()}
                onClick={(e) => {
                  // Element (not HTMLElement) so a gutter SVG-icon click still
                  // resolves; closest() lives on Element.
                  if (e.target instanceof Element && e.target.closest('[data-zone="gutter"]')) {
                    // The agent-default gutter clears BOTH scopes: the
                    // worktree override and the stale agent-level pick that
                    // resolveEffectivePresetId would otherwise fall back to
                    // (issue #6358).
                    void useAgentSettingsStore.getState().updateAgent(type, {
                      presetId: undefined,
                    });
                    persistWorktreePick(undefined);
                    return;
                  }
                  launchWithPreset(null);
                }}
              >
                <span
                  data-zone="gutter"
                  title={!savedPresetId ? "Current default" : "Set as default"}
                  className="flex w-8 shrink-0 items-center justify-center self-stretch rounded-l-[var(--radius-sm)] text-daintree-text/60 transition-colors hover:bg-overlay-raised"
                >
                  {!savedPresetId ? (
                    <Check className="h-3.5 w-3.5" aria-hidden="true" />
                  ) : (
                    <Circle
                      className="h-2.5 w-2.5 opacity-0 transition-opacity duration-150 group-hover/preset-row:opacity-40"
                      aria-hidden="true"
                    />
                  )}
                </span>
                <span data-zone="label" className="flex min-w-0 flex-1 items-center py-1.5">
                  <span className="inline-flex h-4 w-4 items-center justify-center shrink-0 mr-1.5">
                    <BrandMark brandColor={getBrandColorHex(type)}>
                      <config.icon />
                    </BrandMark>
                  </span>
                  Agent default
                </span>
              </DropdownMenuItem>
              {ccrPresetGroup.length > 0 && (
                <>
                  {hasMultiplePresetGroups && <DropdownMenuSeparator />}
                  {hasMultiplePresetGroups && <DropdownMenuLabel>CCR Routes</DropdownMenuLabel>}
                  {ccrPresetGroup.map((preset) => renderPresetRow(preset))}
                </>
              )}
              {projectPresetGroup.length > 0 && (
                <>
                  {hasMultiplePresetGroups && <DropdownMenuSeparator />}
                  {hasMultiplePresetGroups && <DropdownMenuLabel>Project Shared</DropdownMenuLabel>}
                  {projectPresetGroup.map((preset) => renderPresetRow(preset))}
                </>
              )}
              {customPresetGroup.length > 0 && (
                <>
                  {hasMultiplePresetGroups && <DropdownMenuSeparator />}
                  {hasMultiplePresetGroups && <DropdownMenuLabel>Custom</DropdownMenuLabel>}
                  {customPresetGroup.map((preset) => renderPresetRow(preset))}
                </>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() =>
                  void actionService.dispatch(
                    "app.settings.openTab",
                    { tab: "agents", subtab: type, sectionId: "agents-presets" },
                    { source: "user" }
                  )
                }
              >
                Manage Presets...
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </ContextMenuTrigger>
      <ContextMenuContent
        className="max-h-[var(--radix-context-menu-content-available-height)] overflow-y-auto"
        onPointerDownOutside={() => {
          wasPointerCloseRef.current = true;
        }}
        onCloseAutoFocus={(e) => {
          suppressTooltipsDuringFocusRestore();
          if (wasPointerCloseRef.current) {
            e.preventDefault();
            wasPointerCloseRef.current = false;
          }
        }}
      >
        <ContextMenuActionItem actionId="agent.launch" args={{ agentId: type }}>
          Launch {config.name}
        </ContextMenuActionItem>
        <ContextMenuActionItem actionId="agent.launch" args={{ agentId: type, location: "dock" }}>
          Launch {config.name} in Dock
        </ContextMenuActionItem>
        {hasPresets && (
          <ContextMenuSub>
            <ContextMenuSubTrigger disabled={!isLaunchable}>
              Launch with Preset
            </ContextMenuSubTrigger>
            <ContextMenuSubContent
              data-testid="context-submenu-content"
              className="max-h-[var(--radix-context-menu-content-available-height)] overflow-y-auto"
            >
              <ContextMenuRadioGroup value={savedPresetId ?? ""}>
                <MenuActionSourceContext.Consumer>
                  {(menuSource) => (
                    <ContextMenuRadioItem
                      value=""
                      onSelect={() => {
                        void useAgentSettingsStore.getState().updateAgent(type, {
                          presetId: undefined,
                        });
                        persistWorktreePick(undefined);
                        void actionService.dispatch(
                          "agent.launch",
                          { agentId: type, presetId: null },
                          { source: menuSource ?? "user" }
                        );
                      }}
                    >
                      Agent default
                    </ContextMenuRadioItem>
                  )}
                </MenuActionSourceContext.Consumer>
                <MenuActionSourceContext.Consumer>
                  {(menuSource) => (
                    <>
                      {presets.map((preset) => (
                        <ContextMenuRadioItem
                          key={preset.id}
                          value={preset.id}
                          onSelect={() => {
                            persistWorktreePick(preset.id);
                            void actionService.dispatch(
                              "agent.launch",
                              { agentId: type, presetId: preset.id },
                              { source: menuSource ?? "user" }
                            );
                          }}
                        >
                          {preset.displayTitle ?? preset.name.replace(/^CCR:\s*/, "")}
                        </ContextMenuRadioItem>
                      ))}
                    </>
                  )}
                </MenuActionSourceContext.Consumer>
              </ContextMenuRadioGroup>
            </ContextMenuSubContent>
          </ContextMenuSub>
        )}
        {hasWorktrees && (
          <ContextMenuSub>
            <ContextMenuSubTrigger>Launch in Worktree</ContextMenuSubTrigger>
            <ContextMenuSubContent className="max-h-[var(--radix-context-menu-content-available-height)] overflow-y-auto">
              <WorktreeMenuItems agentType={type} />
            </ContextMenuSubContent>
          </ContextMenuSub>
        )}
        <ContextMenuSeparator />
        <ToolbarContextMenuItems buttonId={type} side="left" onUnpin={handleUnpinFromToolbar} />
        <ContextMenuActionItem
          actionId="app.settings.openTab"
          args={{ tab: "agents", subtab: type, sectionId: "agents-presets" }}
        >
          Manage {config.name} Presets...
        </ContextMenuActionItem>
        <ContextMenuActionItem
          actionId="app.settings.openTab"
          args={{ tab: "agents", subtab: type }}
        >
          {config.name} Settings...
        </ContextMenuActionItem>
        <AgentExternalLinkItems links={config.externalLinks} />
      </ContextMenuContent>
    </ContextMenu>
  );
}
