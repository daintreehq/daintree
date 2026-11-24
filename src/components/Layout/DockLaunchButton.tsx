import { useCallback, useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { AppPalettePopover } from "@/components/ui/AppPalettePopover";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { lazyWithPreload, usePreloadedComponent } from "@/lib/lazyWithPreload";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import type { RecipeContext } from "@/utils/recipeVariables";
import { ToolbarContextMenuItems } from "./ToolbarContextMenuItems";
import { useLauncherDiscovery } from "./useLauncherDiscovery";
import {
  DOCK_LAUNCH_SURFACE_HEADER,
  type ActivateDockLaunchItemContext,
  type DockLaunchAgent,
  type DockLaunchInventoryState,
} from "./dockLaunchItems";
import type { DockLaunchPaletteHandle, DockLaunchPaletteProps } from "./DockLaunchPalette";

// The palette — rows, search, column layout, shortcut capture — is its own
// chunk. Both launchers are drawn on every window, and neither needs any of it
// until it opens (#17034).
const PreloadableDockLaunchPalette = lazyWithPreload(
  () => import("./DockLaunchPalette"),
  (m) => m.DockLaunchPalette
);

/** Loads the palette ahead of an open; a failure is left to the open to report. */
export function preloadDockLaunchPalette(): Promise<void> {
  return PreloadableDockLaunchPalette.preload().then(
    () => {},
    () => {}
  );
}

function warmDockLaunchPalette(): void {
  void preloadDockLaunchPalette();
}

/**
 * Which side of the window the launcher hangs off. The inventory, the rows and
 * every affordance are identical — this decides only how the trigger looks and
 * which way the palette opens (#11691).
 */
export type DockLaunchPlacement = "dock" | "toolbar";

const PLACEMENT_CONFIG = {
  dock: {
    side: "top",
    tooltipSide: "top",
    triggerVariant: "pill",
    triggerSize: "sm",
    // The chips' box, not a 28px circle: the launcher sits in the chip row and
    // shares its height and corner. It rests on the chips' own surface and edge
    // (the pill variant's panel fill paints white on light themes, where white
    // is the dock's open state), and open wears the chips' neutral open lift.
    triggerClassName:
      "h-[var(--dock-item-height)] w-[var(--dock-item-height)] px-0 rounded-[var(--radius-md)] ring-inset bg-[var(--dock-item-bg)] ring-[var(--dock-item-border)] hover:bg-[var(--dock-item-bg-hover)] hover:ring-[var(--dock-item-border)] aria-expanded:bg-[var(--dock-item-bg-active)] aria-expanded:ring-[var(--dock-item-border-active)] aria-expanded:text-text-primary",
    iconClassName: "w-3.5 h-3.5",
    label: "Open launcher",
    surface: "dock",
    // The dock owns its own right-click menu on the rail behind this button, so
    // a second one on the trigger would shadow it.
    hasContextMenu: false,
  },
  toolbar: {
    side: "bottom",
    tooltipSide: "bottom",
    triggerVariant: "ghost",
    triggerSize: "icon",
    // `toolbar-launcher-trigger` gives the one control on the strip that starts
    // anything a resting surface the shortcuts beside it don't have.
    triggerClassName: "toolbar-agent-button toolbar-launcher-trigger text-text-primary",
    iconClassName: undefined,
    label: "Launcher",
    surface: "grid",
    hasContextMenu: true,
  },
} as const;

interface DockLaunchButtonProps {
  agents: ReadonlyArray<DockLaunchAgent>;
  pinnedCount?: number;
  onLaunchAgent: ActivateDockLaunchItemContext["onLaunchAgent"];
  activeWorktreeId: string | null;
  cwd: string;
  recipeContext?: RecipeContext;
  placement?: DockLaunchPlacement;
  agentInventoryState?: DockLaunchInventoryState;
  hasWorkspace?: boolean;
  hasProject?: boolean;
  /** Enrols the trigger in the toolbar's roving tabindex and overflow sweep. */
  "data-toolbar-item"?: string;
}

/**
 * The launcher's trigger: its button, tooltip, menu and discovery pip, and the
 * popover's content shell. The palette inside that shell mounts with the
 * content, so a closed launcher subscribes to nothing it would only need open.
 */
export function DockLaunchButton({
  agents,
  pinnedCount,
  onLaunchAgent,
  activeWorktreeId,
  cwd,
  recipeContext,
  placement = "dock",
  agentInventoryState,
  hasWorkspace,
  hasProject,
  "data-toolbar-item": dataToolbarItem,
}: DockLaunchButtonProps) {
  const config = PLACEMENT_CONFIG[placement];
  const [open, setOpen] = useState(false);
  // Mirror AgentButton.tsx's tooltip-suppression pattern: when the launcher
  // closes, Radix restores focus to the trigger and the tooltip would re-fire
  // on top of newly-launched panels. Hold suppression open until the next
  // genuine pointer hover (cleared via onPointerEnter).
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const isRestoringFocusRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // Armed on the way out of a launch, spent by the shell's close-autofocus.
  // See the palette's activateRow.
  const suppressCloseAutoFocusRef = useRef(false);
  const paletteRef = useRef<DockLaunchPaletteHandle>(null);

  const agentAvailability = useCliAvailabilityStore((s) => s.availability);
  const refreshAvailability = useCliAvailabilityStore((s) => s.refresh);
  const { newAgentIds, showDiscoveryBadge, readyAgentIds, markAgentsSeen, recordAgentFirstSeen } =
    useLauncherDiscovery(agentAvailability);

  // Re-probe on view visibility changes (Electron LRU reactivation, tab
  // switches). The window-focus trigger is handled once globally in
  // useAgentLauncher; both paths share the 30s throttle in the store. Only the
  // toolbar placement installs it — both launchers are mounted at once, and a
  // second listener would double every probe for no extra signal.
  useEffect(() => {
    if (placement !== "toolbar") return;
    if (typeof document === "undefined") return;
    let disposed = false;
    const handleVisibility = () => {
      if (disposed) return;
      if (document.visibilityState !== "visible") return;
      void refreshAvailability().catch(() => {});
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [placement, refreshAvailability]);

  // Single close path. Radix only calls onOpenChange for closes it initiates, so
  // the Enter-to-launch path (which sets `open` directly) would otherwise skip
  // the query reset and reopen still filtered.
  const closeLauncher = useCallback((suppressCloseAutoFocus = false) => {
    // Assigned on every close, never merely armed on the ones that launch.
    // Reopening inside the content's exit animation cancels Radix's unmount
    // outright, so that close never reaches close-autofocus and its answer is
    // left unspent — and the next Escape would spend it, losing the focus
    // return the launcher owes a dismissal that launched nothing.
    suppressCloseAutoFocusRef.current = suppressCloseAutoFocus;
    // Every transient row state resets here rather than in each close path, so
    // a half-open capture or expansion — or a typed query — can't survive into
    // the next open. The body is gone already if the content finished closing.
    paletteRef.current?.resetTransientState();
    setOpen(false);
  }, []);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (nextOpen) {
        setOpen(true);
        setTooltipOpen(false);
        // Fire-and-forget: the store throttle absorbs rapid reopens.
        void refreshAvailability().catch(() => {});
        if (readyAgentIds.length > 0) {
          // Anchor each agent's TTL window on the first time the user could
          // actually see it. Deliberately NOT markAgentsSeen — that would burn
          // the cue for everything the user hasn't touched; it fires per launch.
          void recordAgentFirstSeen(readyAgentIds);
        }
      } else {
        closeLauncher();
      }
    },
    [closeLauncher, readyAgentIds, recordAgentFirstSeen, refreshAvailability]
  );

  const suppressTooltipDuringFocusRestore = useCallback(() => {
    setTooltipOpen(false);
    isRestoringFocusRef.current = true;
  }, []);

  // Read-and-disarm in one step, so a close the shell suppressed for its own
  // reasons still spends the flag rather than leaving it to fire on the next
  // Escape.
  const consumeCloseAutoFocusSuppression = useCallback(() => {
    const suppress = suppressCloseAutoFocusRef.current;
    suppressCloseAutoFocusRef.current = false;
    return suppress;
  }, []);

  const trigger = (
    <Tooltip
      open={tooltipOpen}
      onOpenChange={(nextOpen) => {
        if (nextOpen && isRestoringFocusRef.current) return;
        setTooltipOpen(nextOpen);
      }}
    >
      <TooltipTrigger asChild>
        <AppPalettePopover.Trigger asChild>
          <Button
            type="button"
            variant={config.triggerVariant}
            size={config.triggerSize}
            data-toolbar-item={dataToolbarItem}
            className={config.triggerClassName}
            aria-label={
              placement === "toolbar" && showDiscoveryBadge
                ? "Launcher — new agents detected"
                : config.label
            }
            onPointerEnter={() => {
              isRestoringFocusRef.current = false;
              warmDockLaunchPalette();
            }}
            // Warms only: a focus is not the genuine hover that ends the
            // tooltip's suppression.
            onFocus={warmDockLaunchPalette}
          >
            {placement === "toolbar" ? (
              <span className="relative inline-flex items-center justify-center">
                <Plus />
                <span
                  data-testid="launcher-discovery-badge"
                  data-visible={showDiscoveryBadge && !open}
                  className="toolbar-pip toolbar-badge bg-text-secondary"
                  aria-hidden="true"
                />
              </span>
            ) : (
              <Plus className={config.iconClassName} />
            )}
          </Button>
        </AppPalettePopover.Trigger>
      </TooltipTrigger>
      <TooltipContent side={config.tooltipSide}>
        {/* Says where the rows land before the palette is open, and carries the
            discovery dot's meaning, which is otherwise only in the name. */}
        <span className="flex flex-col gap-0.5">
          <span>{DOCK_LAUNCH_SURFACE_HEADER[config.surface]}</span>
          {placement === "toolbar" && showDiscoveryBadge && (
            <span className="text-text-secondary">New agents detected</span>
          )}
        </span>
      </TooltipContent>
    </Tooltip>
  );

  return (
    <AppPalettePopover
      isOpen={open}
      onOpenChange={handleOpenChange}
      // The DropdownMenu this replaced was modal, and the launcher relies on
      // that: focus stays trapped so Tab cycles input → results instead of
      // escaping to what is behind it, and the first outside click is spent
      // dismissing rather than also activating what it landed on.
      modal={true}
    >
      {config.hasContextMenu ? (
        <ContextMenu>
          {/* Real DOM element as the trigger child: ContextMenuTrigger's asChild
              Slot binds onContextMenu + ref here. Wrapping <Tooltip> directly
              drops both (Tooltip.Root is a non-DOM provider), so right-click
              never opens the menu. Mirrors AgentButton. */}
          <ContextMenuTrigger asChild>
            <span className="inline-flex">{trigger}</span>
          </ContextMenuTrigger>
          <ContextMenuContent className="max-h-[var(--radix-context-menu-content-available-height)] overflow-y-auto">
            <ToolbarContextMenuItems buttonId="launcher" side="left" />
          </ContextMenuContent>
        </ContextMenu>
      ) : (
        trigger
      )}
      <AppPalettePopover.Content
        ariaLabel="Launch"
        tier="anchored"
        inputRef={inputRef}
        onClearQuery={() => paletteRef.current?.clearQuery()}
        onCloseAutoFocus={suppressTooltipDuringFocusRestore}
        consumeCloseAutoFocusSuppression={consumeCloseAutoFocusSuppression}
        side={config.side}
        align="start"
        sideOffset={4}
        // Capture's Escape and outside-click vetoes, and the query, are the
        // body's; it may not have arrived yet, and then there is nothing to veto.
        onEscapeKeyDown={(event) => paletteRef.current?.onEscapeKeyDown(event)}
        onInteractOutside={(event) => paletteRef.current?.onInteractOutside(event)}
        // Wider than the anchored tier on purpose: at 484px the launcher could
        // only be one window-height column with its middle empty. At the
        // overview width the agents and the panels/recipes sit side by side, so
        // every launch category is visible without scrolling. The shell's
        // `max-w-[calc(100vw-2rem)]` still caps it, and below ~560px of content
        // the columns fold back into one.
        className="p-0 w-[672px]"
        // Catch-all behind the input's own handler, for the frame before the
        // shell's refocus lands and for focus legitimately sitting on the
        // results region. Bubble phase, so the input and body still get first
        // refusal.
        onKeyDown={(event) => paletteRef.current?.onNavigationKeyDown(event)}
      >
        <ErrorBoundary variant="component" componentName="DockLaunchPalette" displayName="Launcher">
          <DockLaunchPaletteLoader
            agents={agents}
            pinnedCount={pinnedCount}
            onLaunchAgent={onLaunchAgent}
            activeWorktreeId={activeWorktreeId}
            cwd={cwd}
            recipeContext={recipeContext}
            placement={placement}
            agentInventoryState={agentInventoryState}
            hasWorkspace={hasWorkspace}
            hasProject={hasProject}
            open={open}
            onClose={closeLauncher}
            inputRef={inputRef}
            handleRef={paletteRef}
            agentAvailability={agentAvailability}
            newAgentIds={newAgentIds}
            markAgentsSeen={markAgentsSeen}
          />
        </ErrorBoundary>
      </AppPalettePopover.Content>
    </AppPalettePopover>
  );
}

type DockLaunchPaletteLoaderProps = Omit<DockLaunchPaletteProps, "focusOnMount">;

function DockLaunchPaletteLoader(props: DockLaunchPaletteLoaderProps) {
  // Decided once, as the content mounts: a palette that lands after the
  // content opened has to take focus itself.
  const [arrivedLate] = useState(() => !PreloadableDockLaunchPalette.isLoaded());
  const load = usePreloadedComponent(PreloadableDockLaunchPalette);
  // Thrown for the boundary around this loader, whose Try again remounts it
  // and issues the import again; Escape still closes the launcher meanwhile.
  if (load.status === "failed") {
    throw load.error instanceof Error ? load.error : new Error(String(load.error));
  }
  // A local chunk read, well inside the 400ms gate: the content's box, empty.
  if (load.status === "loading") return <div aria-busy="true" className="h-24" />;
  return <PreloadableDockLaunchPalette {...props} focusOnMount={arrivedLate} />;
}
