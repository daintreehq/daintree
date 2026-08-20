import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import Fuse, { type IFuseOptions } from "fuse.js";
import { Keyboard, Pin, PinOff, Plug, Plus, Settings2, SquareTerminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { ToolbarContextMenuItems } from "./ToolbarContextMenuItems";
import { AppPalettePopover } from "@/components/ui/AppPalettePopover";
import { AppPaletteDialog } from "@/components/ui/AppPaletteDialog";
import { PALETTE_ROW_CLASS, PALETTE_SECTION_LABEL_CLASS } from "@/components/ui/paletteRowStyles";
import { BrandMark, Workflow } from "@/components/icons";
import { PanelKindIcon } from "@/components/PanelPalette/PanelKindIcon";
import { AgentShortcutCapture } from "@/components/KeyboardShortcuts";
import { agentStateDotColor } from "@/components/Worktree/AgentStatusIndicator";
import { cn } from "@/lib/utils";
import { notify } from "@/lib/notify";
import { deriveAgentDominantStates } from "@/lib/agentDominantStates";
import { isAgentLaunchable } from "@shared/utils/agentAvailability";
import { isAgentButtonOnToolbar } from "@shared/utils/agentPinned";
import { isBuiltInAgentId, type BuiltInAgentId } from "@shared/config/agentIds";
import {
  getLauncherPanelButtonIdForKind,
  isPanelButtonOnToolbar,
  type LauncherPanelButtonId,
} from "@shared/types/toolbar";
import { resolveEffectivePresetId } from "@shared/types";
import { getMergedPresets } from "@/config/agents";
import { actionService } from "@/services/ActionService";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { useCcrPresetsStore } from "@/store/ccrPresetsStore";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import { usePanelStore } from "@/store/panelStore";
import { useProjectPresetsStore } from "@/store/projectPresetsStore";
import { useToolbarPreferencesStore } from "@/store/toolbarPreferencesStore";
import { dispatchToolbarVisibility } from "@/lib/toolbarVisibilityDispatch";
import { normalizeKeyForBinding } from "@/services/keybindingUtils";
import { useKeybindingDisplay } from "@/hooks";
import { TOOLBAR_PIN_LABEL, TOOLBAR_UNPIN_LABEL } from "./toolbarMenuStrings";
import { LAUNCHER_PANEL_ITEMS } from "./launcherPanelItems";
import { useSearchablePalette } from "@/hooks/useSearchablePalette";
import { useLauncherDiscovery } from "./useLauncherDiscovery";
import {
  activateDockLaunchCue,
  activateDockLaunchItem,
  buildPresetChoices,
  insertExpandedPresetRows,
  rowHasPresets,
  useDockLaunchModel,
  DOCK_LAUNCH_BAND_LABELS,
  DOCK_LAUNCH_CUE_LABELS,
  type DockLaunchAgent,
  type DockLaunchInventoryState,
  type DockLaunchItem,
  type DockLaunchRow,
} from "./dockLaunchItems";
import { unavailableAgentHint } from "@/utils/agentAvailabilityCopy";
import type { RecipeContext } from "@/utils/recipeVariables";

// Same weighting as the ⌘⇧P panel palette so a name match outranks an alias or
// destination match across all three categories.
const DOCK_LAUNCH_FUSE_OPTIONS: IFuseOptions<DockLaunchItem> = {
  keys: [
    { name: "name", weight: 2 },
    { name: "searchAliases", weight: 1.5 },
    { name: "description", weight: 1 },
  ],
  threshold: 0.4,
  includeScore: true,
};

/** Ranked results are capped; the browse list always renders in full. */
const SEARCH_RESULT_CAP = 30;

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
    triggerClassName: "px-2",
    iconClassName: "w-3.5 h-3.5",
    label: "Open launcher",
    // The dock owns its own right-click menu on the rail behind this button, so
    // a second one on the trigger would shadow it.
    hasContextMenu: false,
  },
  toolbar: {
    side: "bottom",
    tooltipSide: "bottom",
    triggerVariant: "ghost",
    triggerSize: "icon",
    triggerClassName: "toolbar-agent-button text-daintree-text",
    iconClassName: undefined,
    label: "Launcher",
    hasContextMenu: true,
  },
} as const;

/**
 * A row that can be pinned to the toolbar, resolved to the id the write path
 * actually takes. Agents and panels keep separate stores behind the one
 * affordance — `null` means the row has no toolbar representation at all
 * (recipes, cues, plugin panel kinds, non-built-in agents).
 */
type DockLaunchPinTarget =
  | { category: "agent"; id: BuiltInAgentId; name: string; onToolbar: boolean }
  | { category: "panel"; id: LauncherPanelButtonId; name: string; onToolbar: boolean };

interface DockLaunchButtonProps {
  agents: ReadonlyArray<DockLaunchAgent>;
  pinnedCount?: number;
  onLaunchAgent: (agentId: string, presetId?: string | null) => void;
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
  // See activateRow.
  const suppressCloseAutoFocusRef = useRef(false);
  const listboxId = useId();
  const getOptionId = useCallback((rowKey: string) => `${listboxId}-${rowKey}`, [listboxId]);

  // Which agent row has its presets expanded into sibling rows, and which row is
  // recording a shortcut. Both keyed by ROW key, not agent id: an agent listed
  // under both Recently launched and Pinned must expand — and capture — only the
  // copy the user acted on.
  const [expandedPresetParentKey, setExpandedPresetParentKey] = useState<string | null>(null);
  const [capturingRowKey, setCapturingRowKey] = useState<string | null>(null);

  // Subscribed here rather than threaded down from a host: the launcher already
  // owns its own model's store reads, and it serves both the dock and the
  // toolbar — neither of which is positioned to compute rows for it.
  const agentSettings = useAgentSettingsStore((s) => s.settings);
  const setAgentPinned = useAgentSettingsStore((s) => s.setAgentPinned);
  const updateWorktreePreset = useAgentSettingsStore((s) => s.updateWorktreePreset);
  const agentAvailability = useCliAvailabilityStore((s) => s.availability);
  const refreshAvailability = useCliAvailabilityStore((s) => s.refresh);
  const ccrPresetsByAgent = useCcrPresetsStore((s) => s.ccrPresetsByAgent);
  const projectPresetsByAgent = useProjectPresetsStore((s) => s.presetsByAgent);
  const pinnedButtons = useToolbarPreferencesStore(useShallow((s) => s.layout.pinnedButtons));
  const leftButtons = useToolbarPreferencesStore(useShallow((s) => s.layout.leftButtons));
  const rightButtons = useToolbarPreferencesStore(useShallow((s) => s.layout.rightButtons));
  const setPanelButtonOnToolbar = useToolbarPreferencesStore((s) => s.setPanelButtonOnToolbar);
  const positionAgentButton = useToolbarPreferencesStore((s) => s.positionAgentButton);
  const toggleButtonVisibility = useToolbarPreferencesStore((s) => s.toggleButtonVisibility);

  const { newAgentIds, showDiscoveryBadge, readyAgentIds, markAgentsSeen, recordAgentFirstSeen } =
    useLauncherDiscovery(agentAvailability);

  const agentDominantStates = usePanelStore(
    useShallow((s) => deriveAgentDominantStates(s.panelsById, s.panelIds, activeWorktreeId))
  );

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

  // Fold per-agent presentation onto the inventory the host supplied: presets,
  // the running pip and the discovery cue all come from stores this component
  // already subscribes to, so a host would only be relaying them.
  const enrichedAgents = useMemo<DockLaunchAgent[]>(
    () =>
      agents.map((agent) => {
        const entry = agentSettings?.agents?.[agent.id];
        const projectPresets = projectPresetsByAgent[agent.id];
        const presets = getMergedPresets(
          agent.id,
          entry?.customPresets,
          ccrPresetsByAgent[agent.id],
          projectPresets
        );
        const savedPresetId = resolveEffectivePresetId(entry, activeWorktreeId);
        return {
          ...agent,
          presetChoices:
            presets.length > 0
              ? buildPresetChoices(
                  presets,
                  new Set((projectPresets ?? []).map((preset) => preset.id)),
                  savedPresetId
                )
              : undefined,
          dominantState: agentDominantStates.get(agent.id) ?? null,
          isNew: newAgentIds.has(agent.id),
        };
      }),
    [
      activeWorktreeId,
      agentDominantStates,
      agentSettings,
      agents,
      ccrPresetsByAgent,
      newAgentIds,
      projectPresetsByAgent,
    ]
  );

  const model = useDockLaunchModel({
    agents: enrichedAgents,
    pinnedCount,
    activeWorktreeId,
    surface: placement === "toolbar" ? "grid" : "dock",
    agentInventoryState,
    hasWorkspace,
    hasProject,
  });

  const resolvePinTarget = useCallback(
    (row: DockLaunchRow): DockLaunchPinTarget | null => {
      // Preset children pin nothing of their own — the parent agent already
      // carries the one toolbar button, and offering it twice would let two rows
      // disagree about its state.
      if (row.kind !== "item") return null;
      const { item } = row;

      if (item.category === "agent") {
        // Only built-in agents have a toolbar button id to write. A plugin or
        // user-defined agent is launchable here but can never reach the toolbar.
        if (!isBuiltInAgentId(item.agent.id)) return null;
        const id = item.agent.id;
        return {
          category: "agent",
          id,
          name: item.name,
          // The array-aware resolver, not `isAgentToolbarVisible`: an installed
          // agent with no position renders no button, and a pin icon that
          // claimed otherwise would be describing a button that isn't there.
          onToolbar: isAgentButtonOnToolbar(
            agentSettings?.agents?.[id],
            item.agent.availability,
            leftButtons.includes(id) || rightButtons.includes(id)
          ),
        };
      }

      if (item.category === "panel") {
        // Through the kind→button map, never `isLauncherPanelButtonId(kindId)`:
        // the dev preview kind is `dev-preview` and its button is `dev-server`,
        // so the direct test drops that row and nothing tells you it did.
        const id = getLauncherPanelButtonIdForKind(item.kindId);
        if (!id) return null;
        return {
          category: "panel",
          id,
          name: item.name,
          onToolbar: isPanelButtonOnToolbar(id, pinnedButtons, leftButtons, rightButtons),
        };
      }

      return null;
    },
    [agentSettings, leftButtons, pinnedButtons, rightButtons]
  );

  // Deliberately undebounced, unlike the menu launcher's old `guardPinAction`:
  // there is nothing here for a time window to swallow. Only `click` toggles —
  // pointerdown just suppresses focus — and the keyboard path guards itself on
  // `event.repeat`. A window could therefore only ever discard a real second
  // intent, which for a toggle means pin followed immediately by unpin.
  const togglePin = useCallback(
    (target: DockLaunchPinTarget) => {
      if (target.category === "agent") {
        // Through the shared dispatcher, not `setAgentPinned` directly: it is
        // what also gives a newly-pinned agent a toolbar position, and it is
        // what Settings → Toolbar calls. `onToolbar` is passed explicitly
        // because the dispatcher's own fallback derives the flip from
        // `isAgentToolbarVisible` — the predicate this row deliberately isn't
        // using, which would make the first click a no-op for an installed,
        // unpositioned agent.
        dispatchToolbarVisibility(
          target.id,
          "left",
          {
            agentSettings,
            agentAvailability,
            setAgentPinned,
            toggleButtonVisibility,
            positionAgentButton,
          },
          !target.onToolbar
        );
        return;
      }
      setPanelButtonOnToolbar(target.id, !target.onToolbar);
    },
    [
      agentAvailability,
      agentSettings,
      positionAgentButton,
      setAgentPinned,
      setPanelButtonOnToolbar,
      toggleButtonVisibility,
    ]
  );

  const fuse = useMemo(
    () => new Fuse(model.searchItems, DOCK_LAUNCH_FUSE_OPTIONS),
    [model.searchItems]
  );

  // The expansion is spliced into the row list BEFORE the palette hook sees it,
  // not into the rendered output afterwards: the flat array is the navigation
  // space, so a preset row that isn't in it has no index, no
  // `aria-activedescendant` and no way to be reached by an arrow key.
  const browseRows = useMemo(
    () => insertExpandedPresetRows(model.browseRows, expandedPresetParentKey),
    [model.browseRows, expandedPresetParentKey]
  );

  // One flat row list drives selection in both modes: browsing renders the
  // grouped bands, searching renders the ranked matches, and either way
  // `selectedIndex` indexes the same array. Fuse runs over the de-duplicated
  // `searchItems` so a recently-launched agent can't rank twice.
  const filterRows = useCallback(
    (rows: DockLaunchRow[], nextQuery: string): DockLaunchRow[] => {
      const trimmed = nextQuery.trim();
      if (!trimmed) return rows;
      const ranked = fuse
        .search(trimmed)
        .slice(0, SEARCH_RESULT_CAP)
        .map(({ item }) => ({
          kind: "item" as const,
          rowKey: item.key,
          band: "results" as const,
          item,
        }));
      return insertExpandedPresetRows(ranked, expandedPresetParentKey);
    },
    [expandedPresetParentKey, fuse]
  );

  const { query, results, selectedIndex, setQuery, setSelectedIndex, selectPrevious, selectNext } =
    useSearchablePalette<DockLaunchRow>({
      items: browseRows,
      filterFn: filterRows,
      getItemId: (row) => row.rowKey,
      // `filterRows` caps ranked search itself and the browse list must render
      // every row, so the hook's own cap must never truncate either one.
      maxResults: Number.MAX_SAFE_INTEGER,
      // Enter can land in the same tick as the last keystroke here, and a
      // deferred pass would rank it against the previous query — launching a
      // row the user never saw.
      deferFiltering: false,
    });

  const clearQuery = useCallback(() => setQuery(""), [setQuery]);

  // The hook reconciles `selectedIndex` in an effect, so the render right after
  // the results change still holds the old index — which browsing can now leave
  // well past the end of a narrowed list, where the old menu always left it at
  // 0. Fall back to the top row (not the last) so this frame agrees with where
  // that effect settles; unhandled, it highlights nothing and Enter no-ops.
  const activeIndex =
    selectedIndex >= 0 && selectedIndex < results.length
      ? selectedIndex
      : results.length > 0
        ? 0
        : -1;
  const selectedRow = activeIndex >= 0 ? results[activeIndex] : undefined;
  // Capture takes the row out of the listbox entirely, so nothing may claim to
  // be the active option while it is up.
  const activeDescendant =
    selectedRow && !capturingRowKey ? getOptionId(selectedRow.rowKey) : undefined;
  const selectedPinTarget = selectedRow ? resolvePinTarget(selectedRow) : null;

  // Set when ArrowRight expands a row, spent once the preset children actually
  // exist. The selection cannot move in the same handler: `setSelectedIndex`
  // records its follow-anchor from the CURRENT results, which do not contain the
  // rows about to be spliced in.
  const pendingExpandRef = useRef<string | null>(null);
  useEffect(() => {
    const pending = pendingExpandRef.current;
    if (!pending) return;
    const index = results.findIndex((row) => row.kind === "preset" && row.parentRowKey === pending);
    if (index < 0) return;
    pendingExpandRef.current = null;
    setSelectedIndex(index);
  }, [results, setSelectedIndex]);

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

  // Re-anchor the selection each time the launcher opens. Closing only clears
  // the query, so the hook's follow-anchor still points wherever browsing
  // ended, while the reopened popover mounts its scroller at the top and the
  // active row keeps its id — so the scroll effect below never re-runs and
  // Enter launches a row that was never on screen.
  //
  // In an effect rather than the open handler: the Recently launched band is
  // rebuilt from MRU that can change while the launcher is closed without
  // re-rendering it, so the handler's closure would anchor a row the opening
  // render is about to displace. Gated on the transition because
  // `setSelectedIndex` takes a new identity every render (the hook's results
  // memo keys on an inline `getItemId`), and resetting on each of those would
  // undo the deliberate follow-the-selection behaviour while typing.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (open && !wasOpenRef.current) setSelectedIndex(0);
    wasOpenRef.current = open;
  }, [open, setSelectedIndex]);

  // Keep the active option in view as the selection moves. `getElementById`
  // rather than a `#id` query: both `useId()` and the item keys contain colons,
  // which are illegal in a CSS id selector.
  useEffect(() => {
    if (!activeDescendant) return;
    document.getElementById(activeDescendant)?.scrollIntoView({ block: "nearest" });
  }, [activeDescendant]);

  // Single close path. Radix only calls onOpenChange for closes it initiates, so
  // the Enter-to-launch path (which sets `open` directly) would otherwise skip
  // the query reset and reopen still filtered.
  const closeLauncher = useCallback(
    (suppressCloseAutoFocus = false) => {
      // Assigned on every close, never merely armed on the ones that launch.
      // Reopening inside the content's exit animation cancels Radix's unmount
      // outright, so that close never reaches close-autofocus and its answer is
      // left unspent — and the next Escape would spend it, losing the focus
      // return the launcher owes a dismissal that launched nothing.
      suppressCloseAutoFocusRef.current = suppressCloseAutoFocus;
      // Local state, not paletteId-backed — reset it ourselves so the next open
      // starts unfiltered on the Recently launched / Pinned bands.
      clearQuery();
      // Every transient row state resets here rather than in each close path, so
      // a half-open capture or expansion can't survive into the next open.
      setExpandedPresetParentKey(null);
      setCapturingRowKey(null);
      pendingExpandRef.current = null;
      setOpen(false);
    },
    [clearQuery]
  );

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

  const launchAgent = useCallback(
    (agentId: string, presetId?: string | null) => {
      // Clear the NEW signal only for the agent actually launched — opening the
      // launcher alone must not burn the cue for every other one.
      void markAgentsSeen([agentId]);
      // `null` = explicit default: clear the agent-level preset so
      // `resolveEffectivePresetId` returns undefined and Default reads as the
      // selection next time.
      if (presetId === null) {
        void useAgentSettingsStore.getState().updateAgent(agentId, { presetId: undefined });
      }
      // Persist the pick to the worktree-scoped slot so a later press on this
      // worktree relaunches the same preset while other worktrees keep theirs.
      // `undefined` is the plain fall-through and writes nothing.
      if (activeWorktreeId && presetId !== undefined) {
        void updateWorktreePreset(agentId, activeWorktreeId, presetId ?? undefined);
      }
      onLaunchAgent(agentId, presetId);
    },
    [activeWorktreeId, markAgentsSeen, onLaunchAgent, updateWorktreePreset]
  );

  const activateRow = useCallback(
    (row: DockLaunchRow) => {
      if (row.kind === "cue") {
        closeLauncher();
        activateDockLaunchCue(row.cue, activeWorktreeId, "menu");
        return;
      }

      const { item } = row;
      // A row whose precondition is unmet opens nothing — and must not close the
      // launcher either, or the press reads as a launch that silently failed.
      if (item.disabled) return;

      // Everything closes through `closeLauncher`, so Radix cannot tell a
      // launch from an Escape and restores focus to the trigger either way —
      // landing a beat after the new panel took it, once the content's exit
      // animation ends (#11664). Every non-disabled item row now launches:
      // an unavailable agent opens a recovery panel rather than navigating to
      // settings (#11760), and that panel claims focus exactly like a terminal,
      // so the return has to be cancelled for it too. Cue rows keep the return —
      // they navigate into surfaces that manage their own focus.
      //
      // Decided on intent, not outcome: every launch below is fire-and-forget,
      // so whether a panel actually appears is not knowable here.
      closeLauncher(true);
      activateDockLaunchItem(
        item,
        { cwd, activeWorktreeId, recipeContext, onLaunchAgent: launchAgent, source: "menu" },
        // A preset child always launches its own preset. What a PARENT row means
        // is the one thing placement decides, because the two hosts disagreed
        // before one component served both:
        //
        //   toolbar — explicit Default (`null`), which also clears the saved
        //     preset. That is what the split trigger's left half did, and the
        //     behaviour #11691 named as having to come across.
        //   dock — inherit the saved preset (`undefined`). The dock never
        //     offered presets at all, so its rows launched whatever was saved,
        //     and making a plain click silently reset that would be a
        //     regression nobody asked for.
        //
        // Explicit Default stays one keystroke away in the dock — it is the
        // first row of the expansion.
        row.kind === "preset"
          ? row.preset.presetId
          : placement === "toolbar" && rowHasPresets(row)
            ? null
            : undefined
      );
    },
    [activeWorktreeId, closeLauncher, cwd, launchAgent, placement, recipeContext]
  );

  const collapsePresets = useCallback(
    (row: DockLaunchRow) => {
      const parentKey = row.kind === "preset" ? row.parentRowKey : row.rowKey;
      setExpandedPresetParentKey(null);
      const parentIndex = results.findIndex((candidate) => candidate.rowKey === parentKey);
      if (parentIndex >= 0) setSelectedIndex(parentIndex);
    },
    [results, setSelectedIndex]
  );

  // Shared by the input and the results region, so navigation keeps working
  // after Tab moves focus onto the scroll container.
  const handleNavigationKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      // Let an IME candidate window own the keystroke. Chromium can emit
      // keyCode 229 before `isComposing` flips true, so both are checked —
      // the same pair guarded across the other palettes and terminal input.
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;

      // Escape is handled on the content's `onEscapeKeyDown`: Radix dismisses
      // from a document-level capture listener that runs before this one, so
      // clearing here would be too late to also veto the close.
      if (event.key === "Escape") return;

      // A recording row owns every key until it resolves. It stops propagation
      // itself, so this only covers keys arriving from the input.
      if (capturingRowKey !== null) return;

      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        if (event.key === "ArrowDown") selectNext();
        else selectPrevious();
        return;
      }
      if (event.key === "Home") {
        event.preventDefault();
        event.stopPropagation();
        setSelectedIndex(0);
        return;
      }
      if (event.key === "End") {
        event.preventDefault();
        event.stopPropagation();
        setSelectedIndex(Math.max(0, results.length - 1));
        return;
      }
      // ArrowRight opens an agent's presets as sibling rows, ArrowLeft closes
      // them again — the flat-list equivalent of the submenu this replaced.
      //
      // The caret only gets a say when the keystroke actually landed in the
      // search box: this handler also serves the results region, where the
      // input's caret is wherever typing left it and would otherwise veto the
      // arrows for no visible reason. A non-empty selection is a text range the
      // arrow should collapse, so it never counts as being at either edge.
      const input = inputRef.current;
      const caretOwnsEvent = input !== null && event.target === input;
      const hasTextSelection = caretOwnsEvent && input.selectionStart !== input.selectionEnd;
      const caretAtEnd =
        !caretOwnsEvent || (!hasTextSelection && input.selectionStart === input.value.length);
      const caretAtStart = !caretOwnsEvent || (!hasTextSelection && input.selectionStart === 0);

      if (event.key === "ArrowRight" && selectedRow && rowHasPresets(selectedRow) && caretAtEnd) {
        event.preventDefault();
        event.stopPropagation();
        pendingExpandRef.current = selectedRow.rowKey;
        setExpandedPresetParentKey(selectedRow.rowKey);
        return;
      }
      if (event.key === "ArrowLeft" && selectedRow && expandedPresetParentKey && caretAtStart) {
        const isInExpansion =
          selectedRow.rowKey === expandedPresetParentKey ||
          (selectedRow.kind === "preset" && selectedRow.parentRowKey === expandedPresetParentKey);
        if (isInExpansion) {
          event.preventDefault();
          event.stopPropagation();
          collapsePresets(selectedRow);
          return;
        }
      }
      if (event.key === "Enter") {
        // No rows at all: swallow the key rather than letting it escape to
        // whatever is behind the launcher.
        event.preventDefault();
        event.stopPropagation();
        if (selectedRow) activateRow(selectedRow);
        return;
      }

      if (event.key === "Tab") return;

      // Alt+P pins the selected row. It has to be modified: this is a type-ahead
      // search box, so a bare "P" is the second letter of "python". Exactly Alt
      // — Cmd+P, Cmd+Shift+P and Cmd+Alt+P are all taken in
      // `defaultKeybindings.ts`, and requiring Alt alone leaves every one of
      // them reaching its own binding. `normalizeKeyForBinding` because macOS
      // reports Option+P as "π"; the AltGraph test because Windows/Linux AltGr
      // synthesizes ctrl+alt and must keep producing international characters.
      const isPinShortcut =
        event.altKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.shiftKey &&
        !event.nativeEvent.getModifierState?.("AltGraph") &&
        normalizeKeyForBinding(event.nativeEvent).toLowerCase() === "p";
      if (isPinShortcut && selectedPinTarget) {
        event.preventDefault();
        event.stopPropagation();
        // Held keys repeat; a pin that flips on every repeat lands wherever the
        // user happened to let go.
        if (!event.repeat) togglePin(selectedPinTarget);
        return;
      }

      // Leave shortcuts alone — swallowing modified keys here would break app
      // keybindings while the launcher is open. Plain typing is still stopped
      // so a letter can't reach the dock's own key handling behind the popover;
      // propagation only, so the input still receives the key natively.
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      event.stopPropagation();
    },
    [
      activateRow,
      capturingRowKey,
      collapsePresets,
      expandedPresetParentKey,
      results.length,
      selectedPinTarget,
      selectedRow,
      selectNext,
      selectPrevious,
      setSelectedIndex,
      togglePin,
    ]
  );

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
            }}
          >
            {placement === "toolbar" ? (
              <span className="relative inline-flex items-center justify-center">
                <Plus />
                <span
                  data-testid="launcher-discovery-badge"
                  data-visible={showDiscoveryBadge}
                  className="toolbar-badge absolute top-0 right-0 size-1.5 rounded-full bg-status-info ring-1 ring-daintree-sidebar"
                  aria-hidden="true"
                />
              </span>
            ) : (
              <Plus className={config.iconClassName} />
            )}
          </Button>
        </AppPalettePopover.Trigger>
      </TooltipTrigger>
      <TooltipContent side={config.tooltipSide}>{config.label}</TooltipContent>
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
        onClearQuery={clearQuery}
        onCloseAutoFocus={suppressTooltipDuringFocusRestore}
        consumeCloseAutoFocusSuppression={consumeCloseAutoFocusSuppression}
        side={config.side}
        align="start"
        sideOffset={4}
        // The shell runs the consumer veto ahead of its own "first Escape clears
        // the query" rule, which is exactly the precedence a recording row
        // needs: cancel the capture in place and spend the press there, leaving
        // the query — and the launcher — untouched.
        onEscapeKeyDown={(event) => {
          if (capturingRowKey === null) return;
          event.preventDefault();
          setCapturingRowKey(null);
        }}
        // Keep the launcher open during capture so a stray click on the capture
        // row's own controls doesn't tear down an in-progress recording. The
        // shell disarms its pointer-close flag when it sees the veto.
        onInteractOutside={(event) => {
          if (capturingRowKey !== null) event.preventDefault();
        }}
        // Width comes from the shell's anchored tier, so the launcher can't
        // drift away from the other menus it sits next to in the same keyboard
        // reflex — and doesn't wear a command palette's box for a list of
        // agents and panels.
        className="p-0"
        // Catch-all behind the input's own handler, for the frame before the
        // shell's refocus lands and for focus legitimately sitting on the
        // results region. Bubble phase, so the input and body still get first
        // refusal.
        onKeyDown={handleNavigationKeyDown}
      >
        <AppPaletteDialog.Header label="Launch">
          <AppPaletteDialog.Input
            inputRef={inputRef}
            value={query}
            // Deliberately NOT resetting the selection here: the palette hook's
            // own effect reconciles it, and calling its setter with the
            // pre-query results would stamp the old list's first row as the item
            // to follow — after which the effect chases that row into the new
            // results instead of settling on the top match. `activeIndex` above
            // covers the frame before it lands.
            onChange={(e) => {
              setQuery(e.target.value);
              // An expansion belongs to the row it was opened on; once the list
              // is re-ranked that row may not even be in it.
              setExpandedPresetParentKey(null);
            }}
            onKeyDownCapture={handleNavigationKeyDown}
            placeholder="Search agents, panels, and recipes"
            role="combobox"
            // The listbox only exists when something matched, so claiming it
            // is expanded — or pointing aria-controls at an unrendered id —
            // would leave the combobox describing a popup that isn't there.
            aria-expanded={results.length > 0}
            aria-haspopup="listbox"
            aria-label="Search agents, panels, and recipes"
            aria-controls={results.length > 0 ? listboxId : undefined}
            aria-activedescendant={activeDescendant}
            autoComplete="off"
            spellCheck={false}
          />
        </AppPaletteDialog.Header>

        <AppPaletteDialog.Body
          ariaLabel="Launcher results"
          activeDescendant={activeDescendant}
          onNavigationKeyDown={handleNavigationKeyDown}
        >
          {agentInventoryState === "loading" && (
            // Before the first real availability result, "no agents installed"
            // and "still detecting" are indistinguishable — say which it is
            // rather than letting the list read as an empty agent inventory.
            <div
              data-testid="dock-launcher-loading"
              className="px-2.5 py-1.5 text-xs text-daintree-text/60"
            >
              Checking agents…
            </div>
          )}
          {results.length === 0 ? (
            <AppPaletteDialog.Empty query={query} emptyMessage="Nothing to launch" />
          ) : (
            <div id={listboxId} role="listbox" aria-label="Launcher results">
              {results.map((row, index) =>
                capturingRowKey === row.rowKey ? (
                  <DockLaunchCaptureRow
                    key={row.rowKey}
                    row={row}
                    onDone={() => setCapturingRowKey(null)}
                  />
                ) : (
                  <DockLaunchOption
                    key={row.rowKey}
                    row={row}
                    index={index}
                    isSelected={index === activeIndex}
                    showBandLabel={row.band !== results[index - 1]?.band}
                    optionId={getOptionId(row.rowKey)}
                    pinTarget={resolvePinTarget(row)}
                    isExpanded={expandedPresetParentKey === row.rowKey}
                    onHover={setSelectedIndex}
                    onActivate={activateRow}
                    onTogglePin={togglePin}
                    onStartCapture={setCapturingRowKey}
                  />
                )
              )}
            </div>
          )}
        </AppPaletteDialog.Body>
      </AppPalettePopover.Content>
    </AppPalettePopover>
  );
}

/**
 * The in-place shortcut recorder.
 *
 * Rendered instead of the row's option, never inside it: `role="option"`
 * children are presentational, so the recorder's own controls would be
 * unreachable, and Radix would read its keystrokes as list navigation. The
 * wrapper stops propagation for the same reason the menu version did — a
 * keystroke meant for the recorder must not reach the palette behind it.
 */
function DockLaunchCaptureRow({ row, onDone }: { row: DockLaunchRow; onDone: () => void }) {
  const item = row.kind === "item" ? row.item : undefined;
  const agent = item?.category === "agent" ? item.agent : undefined;

  const handleShortcutSave = useCallback(
    async (combo: string) => {
      if (!agent) return;
      const result = await actionService.dispatch(
        "keybinding.setOverride",
        { actionId: `agent.${agent.id}`, combo: combo === "" ? [] : [combo] },
        { source: "user" }
      );
      if (!result.ok) {
        // Stay open on failure so the user can retry; surface it explicitly
        // since there is otherwise no visible signal.
        // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
        notify({
          type: "error",
          message: "Couldn't save shortcut",
          duration: 3000,
          priority: "high",
        });
        return;
      }
      onDone();
    },
    [agent, onDone]
  );

  // Only a built-in agent has an `agent.<id>` action to bind, which is also the
  // only row that offers the recorder in the first place.
  if (!agent || !isBuiltInAgentId(agent.id)) return null;
  const agentId = agent.id;

  return (
    <div
      role="presentation"
      data-testid={`launcher-capture-${agentId}`}
      className="px-2.5 py-2 space-y-2"
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div className="flex items-center gap-2 text-xs text-daintree-text/70">
        <span className="inline-flex h-4 w-4 items-center justify-center shrink-0">
          {agent.icon ? (
            <BrandMark brandColor={agent.brandColor}>
              <agent.icon />
            </BrandMark>
          ) : (
            <SquareTerminal className="h-3.5 w-3.5" />
          )}
        </span>
        <span>Set shortcut for {agent.name}</span>
      </div>
      <AgentShortcutCapture
        agentId={agentId}
        onCapture={(combo) => void handleShortcutSave(combo)}
        onCancel={onDone}
        compact
      />
    </div>
  );
}

function RunningDot({ state }: { state: NonNullable<DockLaunchAgent["dominantState"]> | null }) {
  const color = state ? agentStateDotColor(state) : null;
  return (
    <span
      className={cn("toolbar-pip toolbar-badge", color)}
      data-visible={!!color}
      aria-hidden="true"
    />
  );
}

interface DockLaunchOptionProps {
  row: DockLaunchRow;
  index: number;
  isSelected: boolean;
  showBandLabel: boolean;
  optionId: string;
  /** Null for rows with no toolbar button to pin — the slot is still reserved. */
  pinTarget: DockLaunchPinTarget | null;
  isExpanded: boolean;
  onHover: (index: number) => void;
  onActivate: (row: DockLaunchRow) => void;
  onTogglePin: (target: DockLaunchPinTarget) => void;
  onStartCapture: (rowKey: string) => void;
}

function DockLaunchOption({
  row,
  index,
  isSelected,
  showBandLabel,
  optionId,
  pinTarget,
  isExpanded,
  onHover,
  onActivate,
  onTogglePin,
  onStartCapture,
}: DockLaunchOptionProps) {
  const item = row.kind === "cue" ? undefined : row.item;
  const agent = item?.category === "agent" ? item.agent : undefined;
  // Only a built-in agent's own row: presets share the agent's binding, and a
  // plugin agent has no `agent.<id>` action to bind at all.
  const shortcutAgentId =
    row.kind === "item" && agent && isBuiltInAgentId(agent.id) ? agent.id : null;
  // Panels have bindings too, and the old menu showed them. Resolved through the
  // kind→button map and the fixed panel list, which is where that action id
  // lives — a launcher row is keyed by panel KIND, and the binding is on the
  // action behind the button.
  const panelActionId =
    row.kind === "item" && item?.category === "panel"
      ? (LAUNCHER_PANEL_ITEMS.find((p) => p.id === getLauncherPanelButtonIdForKind(item.kindId))
          ?.actionId ?? "")
      : "";
  const displayCombo = useKeybindingDisplay(
    shortcutAgentId ? `agent.${shortcutAgentId}` : panelActionId
  );

  // A filtered row must carry the same warnings as its unfiltered twin: an
  // agent that lands on the recovery panel instead of a session, or a shadowed
  // recipe that resolves to a different winner, is worse when the row looks
  // ordinary.
  const unavailableAgent = agent && !isAgentLaunchable(agent.availability) ? agent : null;
  const disabledReason = item?.disabled?.reason;
  const isDimmed =
    unavailableAgent !== null ||
    disabledReason !== undefined ||
    (item?.category === "recipe" && item.isShadowed);
  const title = unavailableAgent
    ? unavailableAgentHint(unavailableAgent.name, unavailableAgent.availability)
    : undefined;

  const displayName =
    row.kind === "cue"
      ? DOCK_LAUNCH_CUE_LABELS[row.cue]
      : row.kind === "preset"
        ? row.preset.label
        : item!.name;

  // Where the row lands, or which recipe wins — rendered as the trailing label
  // and reused as the option's accessible name below.
  const qualifier =
    row.kind === "cue"
      ? undefined
      : row.kind === "preset"
        ? [row.groupLabel, row.preset.isSelected ? "Current" : undefined]
            .filter(Boolean)
            .join(" · ") || undefined
        : disabledReason !== undefined
          ? disabledReason
          : item!.category === "panel"
            ? item!.location === "dock"
              ? "Dock"
              : "Grid"
            : item!.category === "recipe"
              ? item!.isShadowed
                ? `${item!.scopeLabel} · Overridden by Team`
                : item!.scopeLabel
              : item!.agentBand !== "launch"
                ? "Setup"
                : "Agent";

  // What the row conveys visually, in one string — the option is what
  // `aria-activedescendant` points at, and its children (the trailing qualifier,
  // the pin's own state, the New cue) stop being announced with it once the name
  // is stated explicitly. The pin verb rides here because children of
  // `role="option"` are presentational, so the pin button's own label never
  // reaches a screen reader — the phrase states both what Alt+P does and,
  // through the verb, whether the row is already pinned. `aria-keyshortcuts`
  // stays alongside it as the machine-readable half. The warning is deliberately
  // NOT folded in: `title` alongside an `aria-label` computes as the
  // description, so repeating it here would announce it twice.
  const optionLabel = [
    qualifier ? `${displayName}, ${qualifier}` : displayName,
    agent?.isNew ? "New" : undefined,
    // Stated only where it applies, so the phrase never advertises a key that
    // would do nothing on this row.
    row.kind === "item" && rowHasPresets(row)
      ? `Press Right Arrow ${isExpanded ? "to close" : "for"} presets`
      : undefined,
    pinTarget
      ? `Press Alt+P to ${pinTarget.onToolbar ? "unpin from" : "pin to"} toolbar`
      : undefined,
  ]
    .filter(Boolean)
    .join(". ");

  return (
    <>
      {showBandLabel && (
        <div
          // Decorative inside the listbox — the band is conveyed by the row's
          // own trailing label, and an extra child would break option counting.
          aria-hidden="true"
          data-testid="dock-launcher-band"
          className={cn(PALETTE_SECTION_LABEL_CLASS, "px-2 pt-2 pb-1 first:pt-0")}
        >
          {DOCK_LAUNCH_BAND_LABELS[row.band]}
        </div>
      )}
      {row.kind === "preset" && row.groupLabel && (
        <div
          // Same rule as the band heading above: decorative, because the row's
          // own accessible name already states which group it belongs to.
          aria-hidden="true"
          data-testid="dock-launcher-preset-group"
          className={cn(PALETTE_SECTION_LABEL_CLASS, "px-2 pt-2 pb-1 pl-7")}
        >
          {row.groupLabel}
        </div>
      )}
      {/* A div, not a button: the pin control is a real button and one cannot
          nest inside another. Activation stays on the option itself rather than
          moving to an inner button — the row owns its padding and the reserved
          pin column, and an inner button would only cover its own content box,
          leaving the rest of a row that highlights as one thing inert. */}
      <div
        id={optionId}
        role="option"
        // Which kind of row this is, for tests that need to tell a preset child
        // from the agent it belongs to without depending on either one's label.
        data-row-kind={row.kind}
        aria-selected={isSelected}
        // `aria-disabled`, never the real thing: the row stays in the navigation
        // space so its pin affordance is still reachable, and pinning a panel
        // you haven't opened a project for yet is a reasonable thing to want.
        aria-disabled={disabledReason !== undefined || undefined}
        // Stated, not computed from content: the pin button is a child, so a
        // content-derived name would end every pinnable row with "Pin to
        // toolbar: X". `title` stays a sibling attribute rather than part of the
        // name — with an `aria-label` present it computes as the description, so
        // the warning is announced once and still shows as the mouse tooltip.
        aria-label={optionLabel}
        aria-keyshortcuts={pinTarget ? "Alt+P" : undefined}
        aria-expanded={row.kind === "item" && rowHasPresets(row) ? isExpanded : undefined}
        title={title}
        // Keeps DOM focus on the search box when a row is clicked or hovered,
        // so typing never lands anywhere else. preventDefault only — stopping
        // propagation here would hide the pointerdown from Radix's
        // DismissableLayer, which needs to see it to classify the next outside
        // click as a dismissal.
        onPointerDown={(event) => event.preventDefault()}
        onPointerEnter={() => onHover(index)}
        onClick={() => onActivate(row)}
        className={cn(
          PALETTE_ROW_CLASS,
          "group relative w-full flex items-center px-2 py-1.5 rounded-[var(--radius-md)] text-left text-sm",
          "hover:bg-overlay-subtle",
          // Preset children are indented so the expansion reads as belonging to
          // the agent above it rather than as another top-level row.
          row.kind === "preset" && "pl-7",
          isDimmed && "opacity-70"
        )}
      >
        <DockLaunchOptionIcon row={row} />
        <span className="truncate">{displayName}</span>
        {agent?.isNew && (
          <>
            <span
              data-testid={`launcher-new-pill-${agent.id}`}
              aria-hidden="true"
              className="ml-2 shrink-0 size-1.5 rounded-full bg-status-info ring-1 ring-daintree-sidebar"
            />
          </>
        )}
        {qualifier && (
          <span className="ml-auto pl-2 text-[11px] text-text-muted shrink-0">{qualifier}</span>
        )}
        {displayCombo && (
          <span className="ml-2 shrink-0 text-[11px] text-text-muted tabular-nums">
            {displayCombo}
          </span>
        )}

        {/* Reserved on every row, not just the ones that use it. Opacity hides
            the controls without releasing their box, so a recipe and an agent
            end their trailing labels on the same edge. */}
        <span className="ml-1 w-5 shrink-0" data-launcher-slot="shortcut">
          {shortcutAgentId && (
            <button
              type="button"
              tabIndex={-1}
              aria-hidden="true"
              data-testid={`launcher-shortcut-edit-${shortcutAgentId}`}
              title={displayCombo ? "Change keyboard shortcut" : "Assign keyboard shortcut"}
              onPointerDown={(event) => event.preventDefault()}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onStartCapture(row.rowKey);
              }}
              className={cn(
                "inline-flex h-5 w-5 items-center justify-center rounded-[var(--radius-sm)] bg-transparent border-0",
                "text-daintree-text/40 opacity-0 transition-[opacity,color,background-color]",
                "hover:bg-overlay-soft hover:text-daintree-text",
                "group-hover:opacity-100 group-aria-selected:opacity-100"
              )}
            >
              <Keyboard className="h-3 w-3" aria-hidden />
            </button>
          )}
        </span>

        <span className="ml-1 w-5 shrink-0" data-launcher-slot="pin">
          {pinTarget && (
            <button
              type="button"
              tabIndex={-1}
              aria-label={`${pinTarget.onToolbar ? TOOLBAR_UNPIN_LABEL : TOOLBAR_PIN_LABEL}: ${pinTarget.name}`}
              aria-pressed={pinTarget.onToolbar}
              aria-keyshortcuts="Alt+P"
              title={`${pinTarget.onToolbar ? TOOLBAR_UNPIN_LABEL : TOOLBAR_PIN_LABEL} (Alt+P)`}
              // preventDefault keeps focus on the search box. stopPropagation
              // belongs on the click below and nowhere else: the row's own
              // onClick is an ancestor of this one, so the pin must stop the
              // click — but stopping the POINTERDOWN would hide it from Radix's
              // DismissableLayer, which needs to see it to classify the next
              // outside click as a dismissal.
              onPointerDown={(event) => event.preventDefault()}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onTogglePin(pinTarget);
              }}
              className={cn(
                "inline-flex h-5 w-5 items-center justify-center rounded-[var(--radius-sm)] bg-transparent border-0",
                "transition-[opacity,color,background-color] hover:bg-overlay-soft hover:text-daintree-text",
                // Pinned rows read as state markers and stay visible; unpinned
                // ones are controls that only appear once the row is under the
                // pointer or the selection.
                pinTarget.onToolbar
                  ? "text-daintree-text/70 opacity-100"
                  : "text-daintree-text/40 opacity-0 group-hover:opacity-100 group-aria-selected:opacity-100"
              )}
            >
              {pinTarget.onToolbar ? (
                <PinOff className="h-3 w-3" aria-hidden />
              ) : (
                <Pin className="h-3 w-3" aria-hidden />
              )}
            </button>
          )}
        </span>
      </div>
    </>
  );
}

function DockLaunchOptionIcon({ row }: { row: DockLaunchRow }) {
  if (row.kind === "cue") {
    return row.cue === "setup-agents" ? (
      <Plug className="w-3.5 h-3.5 mr-2 shrink-0" />
    ) : row.cue === "manage-agents" ? (
      <Settings2 className="w-3.5 h-3.5 mr-2 shrink-0" />
    ) : (
      <Workflow className="w-3.5 h-3.5 mr-2 shrink-0" />
    );
  }

  const { item } = row;
  if (item.category === "recipe") {
    return <Workflow className="w-3.5 h-3.5 mr-2 shrink-0" />;
  }
  if (item.category === "panel") {
    return <PanelKindIcon iconId={item.iconId} color={item.color} size={14} className="mr-2" />;
  }

  const { agent } = item;
  // A preset child wears its own colour when it has one, so the expansion reads
  // as variants of the agent above rather than a repeat of it.
  const brandColor =
    row.kind === "preset" ? (row.preset.color ?? agent.brandColor) : agent.brandColor;
  return (
    <span className="relative mr-2 inline-flex h-3.5 w-3.5 items-center justify-center shrink-0">
      {agent.icon ? (
        <BrandMark brandColor={brandColor} className="h-3.5 w-3.5">
          <agent.icon />
        </BrandMark>
      ) : (
        <SquareTerminal className="w-3.5 h-3.5 shrink-0" />
      )}
      {row.kind === "item" && <RunningDot state={agent.dominantState ?? null} />}
    </span>
  );
}
