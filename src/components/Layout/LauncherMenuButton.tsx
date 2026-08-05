import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
  type ComponentType,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  Globe,
  MonitorPlay,
  Pin,
  Plug,
  Settings2,
  SquareMenu,
  SquareTerminal,
  ChevronRight,
  Keyboard,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { ToolbarContextMenuItems } from "./ToolbarContextMenuItems";
import {
  DropdownMenu,
  DropdownMenuActionItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { getBrandColorHex } from "@/lib/colorUtils";
import { BrandMark, FolderTree, Plus } from "@/components/icons";
import {
  getAgentConfig,
  getMergedPresets,
  type AgentIconProps,
  type AgentPreset,
} from "@/config/agents";
import { actionService } from "@/services/ActionService";
import { useActionMruStore } from "@/store/actionMruStore";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import { useCcrPresetsStore } from "@/store/ccrPresetsStore";
import { useProjectPresetsStore } from "@/store/projectPresetsStore";
import { usePanelStore } from "@/store/panelStore";
import { useToolbarPreferencesStore } from "@/store/toolbarPreferencesStore";
import { TOOLBAR_PIN_LABEL, TOOLBAR_UNPIN_LABEL } from "./toolbarMenuStrings";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";

import { useKeybindingDisplay } from "@/hooks";
import {
  useAgentDiscoveryOnboarding,
  NEW_AGENT_TTL_MS,
} from "@/hooks/app/useAgentDiscoveryOnboarding";
import { AgentShortcutCapture } from "@/components/KeyboardShortcuts";
import { notify } from "@/lib/notify";
import { dispatchToolbarVisibility } from "@/lib/toolbarVisibilityDispatch";
import { LAUNCHABLE_AGENT_IDS, type BuiltInAgentId } from "@shared/config/agentIds";
import type { BuiltInActionId } from "@shared/types/actions";
import type { CliAvailability, AgentState } from "@shared/types";
import { resolveEffectivePresetId } from "@shared/types";
// `@shared/...` because this is a value import — the type-only spelling below is
// erased at compile time and never has to resolve at runtime.
import { isPanelButtonOnToolbar } from "@shared/types/toolbar";
import type { LauncherPanelButtonId } from "@shared/types/toolbar";
import { isAgentLaunchable, isAgentInstalled } from "../../../shared/utils/agentAvailability";
import { isAgentButtonOnToolbar, isAgentPinned } from "../../../shared/utils/agentPinned";
import {
  getDominantAgentState,
  agentStateDotColor,
} from "@/components/Worktree/AgentStatusIndicator";
import { cn } from "@/lib/utils";
import { getRuntimeOrBootAgentId } from "@/utils/terminalType";
import { isPtyPanel, type PanelInstance } from "@shared/types/panel";
import { useShallow } from "zustand/react/shallow";

interface LauncherMenuButtonProps {
  agentAvailability?: CliAvailability;
  /** Gates `file-browser`, whose action resolves no folder without one (#11499). */
  hasWorkspace: boolean;
  /** Gates `dev-server`, which has no project to start a server for without one. */
  hasProject: boolean;
  /**
   * The toolbar's own file-browser handler, reused so a refusal surfaces the
   * same retry toast here as it does from the button (Toolbar.tsx).
   */
  onOpenFileBrowser: () => void;
  "data-toolbar-item"?: string;
}

export interface LauncherPanelItem {
  id: LauncherPanelButtonId;
  label: string;
  icon: ComponentType<{ className?: string }>;
  /** Drives the row's shortcut hint and, for every item but the file browser, its activation. */
  actionId: BuiltInActionId;
}

/**
 * The Panels section's inventory: every non-agent panel the launcher can spawn
 * without a target (#11667, extended in #11680).
 *
 * Fixed rather than derived from `panelKindRegistry`, because a launcher row
 * needs three things a panel kind doesn't carry — a toolbar button id to pin, an
 * action to dispatch, and an availability rule. `review`, `file` and `diff` are
 * out for exactly that reason: they have no toolbar button id, and the first
 * needs a resolved worktree while the other two need a file. The "More panels…"
 * footer routes to the palette, which carries the complete dynamic inventory.
 *
 * Order matches `LAUNCHER_PANEL_BUTTON_IDS`, which the store and Settings also
 * read, so no surface can disagree about what the section holds.
 */
export const LAUNCHER_PANEL_ITEMS: readonly LauncherPanelItem[] = [
  { id: "terminal", label: "Terminal", icon: SquareTerminal, actionId: "agent.terminal" },
  {
    id: "file-browser",
    label: "Browse files",
    icon: FolderTree,
    actionId: "worktree.openFileBrowserPanel",
  },
  { id: "browser", label: "Browser", icon: Globe, actionId: "agent.browser" },
  { id: "dev-server", label: "Dev preview", icon: MonitorPlay, actionId: "devServer.start" },
];

// File-local context so DropdownMenuContent can guard onEscapeKeyDown when any
// LaunchRow is in shortcut-capture mode (Radix DismissableLayer otherwise
// closes the dropdown on Escape — see lesson #4588). Exclusivity is enforced
// at the setter so two rows can't both be capturing at once.
type LauncherCapturingContextValue = {
  capturingId: BuiltInAgentId | null;
  setCapturingId: (id: BuiltInAgentId | null) => void;
};

const LauncherCapturingContext = createContext<LauncherCapturingContextValue>({
  capturingId: null,
  setCapturingId: () => {},
});

type AgentRow = {
  id: BuiltInAgentId;
  name: string;
  Icon: ComponentType<AgentIconProps>;
  pinned: boolean;
  dominantState: AgentState | null;
  isNew: boolean;
  presets?: AgentPreset[];
  projectPresetIds: Set<string>;
  savedPresetId?: string;
};

const ACTIVE_AGENT_STATES: ReadonlySet<AgentState | undefined> = new Set<AgentState | undefined>([
  "idle",
  "working",
  "waiting",
  "directing",
]);

// Per-agent dominant state across panels in the active worktree. Runtime
// identity wins so a plain shell that starts Claude/Codex is tracked under the
// same launcher entry; launch intent is only a boot-window fallback before any
// detector result has committed. Designed to run inside a useShallow selector
// (Map values are primitives) so subscribers only re-render on real state
// transitions, not every panelsById spread — see issue #7451.
export function deriveAgentDominantStates(
  panelsById: Record<string, PanelInstance>,
  panelIds: readonly string[],
  activeWorktreeId: string | null
): Map<string, AgentState | null> {
  const statesPerAgent = new Map<string, (AgentState | undefined)[]>();
  for (const pid of panelIds) {
    const p = panelsById[pid];
    if (
      !p ||
      !isPtyPanel(p) ||
      p.location === "trash" ||
      p.location === "background" ||
      p.location === "overlay"
    )
      continue;
    const agentId = getRuntimeOrBootAgentId(p);
    if (!agentId) continue;
    if (activeWorktreeId && p.worktreeId !== activeWorktreeId) continue;
    if (!ACTIVE_AGENT_STATES.has(p.agentState)) continue;
    const arr = statesPerAgent.get(agentId) ?? [];
    arr.push(p.agentState);
    statesPerAgent.set(agentId, arr);
  }
  const result = new Map<string, AgentState | null>();
  for (const [agentId, states] of statesPerAgent) {
    result.set(agentId, getDominantAgentState(states));
  }
  return result;
}

function buildAgentRow(
  id: BuiltInAgentId,
  pinned: boolean,
  dominantState: AgentState | null,
  isNew: boolean,
  customPresets?: AgentPreset[],
  ccrPresets?: AgentPreset[],
  projectPresets?: AgentPreset[],
  savedPresetId?: string
): AgentRow | null {
  const config = getAgentConfig(id);
  if (!config) return null;
  const presets = getMergedPresets(id, customPresets, ccrPresets, projectPresets);
  const hasPresets = presets.length > 0;
  return {
    id,
    name: config.name,
    Icon: config.icon,
    pinned,
    dominantState,
    isNew,
    presets: hasPresets ? presets : undefined,
    projectPresetIds: new Set((projectPresets ?? []).map((f) => f.id)),
    savedPresetId,
  };
}

function RunningDot({ state }: { state: AgentState | null }) {
  const color = state ? agentStateDotColor(state) : null;
  return (
    <span
      className={cn("toolbar-pip toolbar-badge", color)}
      data-visible={!!color}
      aria-hidden="true"
    />
  );
}

/**
 * The one pin affordance every launcher row wears, whatever kind of row it is
 * (#11680). Agents and panels keep their own stores behind it — the affordance
 * is what unifies them, not the storage.
 *
 * Deliberately a non-focusable `<span>`, not a `<button>`: it sits inside a
 * Radix menu item, so a real button would put a second tab stop inside every row
 * and break menu navigation. Keyboard users reach it through the row-level "P"
 * shortcut, announced by the `sr-only` sibling the caller renders.
 */
function LauncherPinAffordance({
  testId,
  onToolbar,
  onToggle,
  stopPointer,
}: {
  testId: string;
  onToolbar: boolean;
  onToggle: () => void;
  stopPointer: (e: ReactPointerEvent) => void;
}) {
  return (
    <span
      role="presentation"
      aria-hidden="true"
      data-testid={testId}
      data-pinned={onToolbar ? "true" : "false"}
      title={onToolbar ? `${TOOLBAR_UNPIN_LABEL} (P)` : `${TOOLBAR_PIN_LABEL} (P)`}
      onPointerDown={stopPointer}
      onPointerUp={stopPointer}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      className={cn(
        "ml-1 inline-flex h-5 w-5 items-center justify-center rounded-sm text-daintree-text/50 transition-opacity hover:bg-overlay-emphasis hover:text-daintree-text",
        onToolbar ? "opacity-100" : "opacity-0 group-data-[highlighted]:opacity-100"
      )}
    >
      <Pin
        className={cn(
          "h-3 w-3",
          // Pinned rows: read as state markers, not active controls. Muted
          // until the row is highlighted (hover/keyboard focus), at which
          // point the icon brightens to signal it is also clickable.
          onToolbar &&
            "fill-current text-daintree-text/40 group-data-[highlighted]:text-daintree-text"
        )}
        strokeWidth={onToolbar ? 2 : 1.75}
      />
    </span>
  );
}

type SplitLaunchItemProps = {
  row: AgentRow;
  onLaunch: (agentId: BuiltInAgentId, presetId?: string | null) => void;
  onTogglePin: (row: AgentRow) => void;
  stopPointer: (e: ReactPointerEvent) => void;
};

function SplitLaunchItem({ row, onLaunch, onTogglePin, stopPointer }: SplitLaunchItemProps) {
  const leftAreaRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = leftAreaRef.current;
    if (!el) return;
    const handler = (e: PointerEvent) => {
      // Prevent Radix from opening the submenu when clicking the main area
      e.stopPropagation();
      e.preventDefault();
      onLaunch(row.id, null);
    };
    el.addEventListener("pointerdown", handler, true);
    return () => el.removeEventListener("pointerdown", handler, true);
  }, [row.id, onLaunch]);

  // Keyboard: Enter/Space on the SubTrigger must launch default (primary action)
  // rather than Radix's default of opening the submenu. ArrowRight still opens
  // the submenu for picking a specific preset. Without this, keyboard users
  // cannot trigger the left-side default launch at all.
  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      onLaunch(row.id, null);
      return;
    }
    // Same "P" contract as every other row. Without it, creating a preset for an
    // agent silently took that agent's pin away — the row switches to this
    // component the moment `getMergedPresets` returns anything (#11680).
    if (e.key === "p" || e.key === "P") {
      e.preventDefault();
      e.stopPropagation();
      onTogglePin(row);
    }
  };

  // Project membership beats the ccr- prefix so a project preset with a
  // ccr-* id still lands under "Project Shared". Everything not-ccr and
  // not-project falls through to "Custom" — preserves historical display
  // for presets whose provenance can't be determined from id alone.
  const projectPresets = (row.presets ?? []).filter((f) => row.projectPresetIds.has(f.id));
  const ccrPresets = (row.presets ?? []).filter(
    (f) => !row.projectPresetIds.has(f.id) && f.id.startsWith("ccr-")
  );
  const customPresets = (row.presets ?? []).filter(
    (f) => !row.projectPresetIds.has(f.id) && !f.id.startsWith("ccr-")
  );
  const groupCount =
    (ccrPresets.length > 0 ? 1 : 0) +
    (projectPresets.length > 0 ? 1 : 0) +
    (customPresets.length > 0 ? 1 : 0);
  const hasMultipleGroups = groupCount > 1;

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger
        className="p-0 [&>svg:last-child]:hidden overflow-hidden"
        data-testid="submenu-trigger"
        onKeyDown={handleKeyDown}
        // The pin hint rides in the label rather than an `sr-only` child: an
        // `aria-label` on the trigger REPLACES its descendant text, so the
        // sibling span the plain rows use would never be announced here.
        aria-label={`${row.name} (press Enter to launch, Right Arrow for presets, P to ${
          row.pinned ? "unpin from" : "pin to"
        } toolbar)`}
      >
        <span ref={leftAreaRef} className="flex flex-1 items-center gap-2 px-2.5 py-1.5">
          <span className="inline-flex h-4 w-4 items-center justify-center shrink-0">
            <BrandMark brandColor={getBrandColorHex(row.id)}>
              <row.Icon brandColor={getBrandColorHex(row.id)} />
            </BrandMark>
          </span>
          <span className="flex-1">{row.name}</span>
          {row.isNew && (
            <>
              <span
                data-testid={`launcher-new-pill-${row.id}`}
                aria-hidden="true"
                className="ml-1 shrink-0 size-1.5 rounded-full bg-status-info ring-1 ring-daintree-sidebar"
              />
              <span className="sr-only">New</span>
            </>
          )}
        </span>
        <LauncherPinAffordance
          testId={`launcher-pin-${row.id}`}
          onToolbar={row.pinned}
          onToggle={() => onTogglePin(row)}
          stopPointer={stopPointer}
        />

        <span
          className="flex items-center px-2 py-1.5 border-l border-daintree-border/50"
          aria-hidden="true"
        >
          <ChevronRight className="h-3.5 w-3.5 text-daintree-text/40" />
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent data-testid="submenu-content">
        <DropdownMenuRadioGroup value={row.savedPresetId ?? ""}>
          <DropdownMenuRadioItem value="" onSelect={() => onLaunch(row.id, null)}>
            <span className="inline-flex h-4 w-4 items-center justify-center shrink-0 mr-1.5">
              <BrandMark brandColor={getBrandColorHex(row.id)}>
                <row.Icon brandColor={getBrandColorHex(row.id)} />
              </BrandMark>
            </span>
            Default
          </DropdownMenuRadioItem>
          {ccrPresets.length > 0 && (
            <>
              {hasMultipleGroups && <DropdownMenuSeparator />}
              {hasMultipleGroups && <DropdownMenuLabel>CCR Routes</DropdownMenuLabel>}
              {ccrPresets.map((preset) => (
                <DropdownMenuRadioItem
                  key={preset.id}
                  value={preset.id}
                  onSelect={() => onLaunch(row.id, preset.id)}
                >
                  <span className="inline-flex h-4 w-4 items-center justify-center shrink-0 mr-1.5">
                    <BrandMark
                      brandColor={preset.color ?? getBrandColorHex(row.id)}
                      userChosen={!!preset.color}
                    >
                      <row.Icon brandColor={preset.color ?? getBrandColorHex(row.id)} />
                    </BrandMark>
                  </span>
                  {preset.displayTitle ?? preset.name.replace(/^CCR:\s*/, "")}
                </DropdownMenuRadioItem>
              ))}
            </>
          )}
          {projectPresets.length > 0 && (
            <>
              {hasMultipleGroups && <DropdownMenuSeparator />}
              {hasMultipleGroups && <DropdownMenuLabel>Project Shared</DropdownMenuLabel>}
              {projectPresets.map((preset) => (
                <DropdownMenuRadioItem
                  key={preset.id}
                  value={preset.id}
                  onSelect={() => onLaunch(row.id, preset.id)}
                >
                  <span className="inline-flex h-4 w-4 items-center justify-center shrink-0 mr-1.5">
                    <BrandMark
                      brandColor={preset.color ?? getBrandColorHex(row.id)}
                      userChosen={!!preset.color}
                    >
                      <row.Icon brandColor={preset.color ?? getBrandColorHex(row.id)} />
                    </BrandMark>
                  </span>
                  {preset.displayTitle ?? preset.name}
                </DropdownMenuRadioItem>
              ))}
            </>
          )}
          {customPresets.length > 0 && (
            <>
              {hasMultipleGroups && <DropdownMenuSeparator />}
              {hasMultipleGroups && <DropdownMenuLabel>Custom</DropdownMenuLabel>}
              {customPresets.map((preset) => (
                <DropdownMenuRadioItem
                  key={preset.id}
                  value={preset.id}
                  onSelect={() => onLaunch(row.id, preset.id)}
                >
                  <span className="inline-flex h-4 w-4 items-center justify-center shrink-0 mr-1.5">
                    <BrandMark
                      brandColor={preset.color ?? getBrandColorHex(row.id)}
                      userChosen={!!preset.color}
                    >
                      <row.Icon brandColor={preset.color ?? getBrandColorHex(row.id)} />
                    </BrandMark>
                  </span>
                  {preset.displayTitle ?? preset.name}
                </DropdownMenuRadioItem>
              ))}
            </>
          )}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

/**
 * One toolbar button collecting everything that opens in a pane — agents and
 * panels alike (#11680).
 *
 * Replaces the separate agent tray (`Plug`) and panel tray (`LayoutPanelTop`),
 * which split one capability across two mental models and two glyphs. A menu
 * button, never a split button: pinned agent buttons already exist beside it, so
 * no single action dominates, and a primary action that mutated to "last used"
 * would break muscle memory. It leads the left group so the row reads
 * verb-then-nouns — launcher, then the things pinned out of it.
 *
 * Every row wears the same `LauncherPinAffordance`. The stores behind it stay
 * separate on purpose: an agent's pin is the IPC-persisted tri-state in
 * `agentSettingsStore` (#7673), a panel's is the array-plus-explicit-`true` in
 * `toolbarPreferencesStore` that survives a cross-view array overwrite (#11667).
 * Both writes go out through one call path each — `dispatchToolbarVisibility`
 * and `setPanelButtonOnToolbar` — which Settings → Toolbar also uses, because
 * the moment two surfaces disagree about which setter to call, the promotion
 * they record stops surviving a sibling view's write.
 */
export function LauncherMenuButton({
  agentAvailability,
  hasWorkspace,
  hasProject,
  onOpenFileBrowser,
  "data-toolbar-item": dataToolbarItem,
}: LauncherMenuButtonProps) {
  const agentSettings = useAgentSettingsStore((s) => s.settings);
  const ccrPresetsByAgent = useCcrPresetsStore((s) => s.ccrPresetsByAgent);
  const projectPresetsByAgent = useProjectPresetsStore((s) => s.presetsByAgent);
  const setAgentPinned = useAgentSettingsStore((s) => s.setAgentPinned);
  const updateWorktreePreset = useAgentSettingsStore((s) => s.updateWorktreePreset);

  const pinnedButtons = useToolbarPreferencesStore((s) => s.layout.pinnedButtons);
  const leftButtons = useToolbarPreferencesStore((s) => s.layout.leftButtons);
  const rightButtons = useToolbarPreferencesStore((s) => s.layout.rightButtons);
  const setPanelButtonOnToolbar = useToolbarPreferencesStore((s) => s.setPanelButtonOnToolbar);
  const positionAgentButton = useToolbarPreferencesStore((s) => s.positionAgentButton);
  const toggleButtonVisibility = useToolbarPreferencesStore((s) => s.toggleButtonVisibility);

  const getSortedActionMruList = useActionMruStore((s) => s.getSortedActionMruList);

  const refreshAvailability = useCliAvailabilityStore((s) => s.refresh);
  const hasRealData = useCliAvailabilityStore((s) => s.hasRealData);

  const {
    loaded: onboardingLoaded,
    seenAgentIds,
    availabilityFirstSeen,
    welcomeCardDismissed,
    markAgentsSeen,
    recordAgentFirstSeen,
  } = useAgentDiscoveryOnboarding();

  const [open, setOpen] = useState(false);
  const [capturingId, setCapturingId] = useState<BuiltInAgentId | null>(null);

  const captureContextValue = useMemo<LauncherCapturingContextValue>(
    () => ({ capturingId, setCapturingId }),
    [capturingId]
  );

  // Reset capture state whenever the dropdown closes so a half-open capture
  // doesn't persist into the next time the user opens the launcher.
  useEffect(() => {
    if (!open) setCapturingId(null);
  }, [open]);

  const activeWorktreeId = useWorktreeSelectionStore((s) => s.activeWorktreeId);
  const agentDominantStates = usePanelStore(
    useShallow((s) => deriveAgentDominantStates(s.panelsById, s.panelIds, activeWorktreeId))
  );

  // Before the first real availability result lands we can't distinguish
  // "all agents missing" from "still detecting", so we show a spinner.
  const isAvailabilityLoading = agentAvailability === undefined || !hasRealData;
  const lastPinActionAt = useRef<Map<string, number>>(new Map());

  // Radix Tooltip reopens whenever the trigger receives focus, including
  // programmatic focus restoration from DropdownMenu's onCloseAutoFocus and
  // from any AppDialog opened via a menu item (Customise Toolbar, Manage
  // Agents, etc.) when that dialog closes much later. Gate the Tooltip via
  // controlled state and hold the suppression open until the next genuine
  // pointer hover on the button — a timer can't bridge an arbitrarily long
  // dialog lifetime. See issue #5153.
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const isRestoringFocusRef = useRef(false);
  // Set in onPointerDownOutside, read in onCloseAutoFocus. Lets us
  // preventDefault() the focus restoration only for pointer dismissals so the
  // launcher button doesn't keep its accent focus-visible ring; keyboard close
  // (Escape/Enter) still gets default focus return for WAI-ARIA.
  const wasPointerCloseRef = useRef(false);

  // Re-probe on view visibility changes (Electron LRU reactivation, tab
  // switches). The window-focus trigger is handled once globally in
  // useAgentLauncher; both paths share the 30s throttle in the store.
  useEffect(() => {
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
  }, [refreshAvailability]);

  const handleTooltipOpenChange = (open: boolean) => {
    if (open && isRestoringFocusRef.current) return;
    setTooltipOpen(open);
  };

  const suppressTooltipDuringFocusRestore = () => {
    setTooltipOpen(false);
    isRestoringFocusRef.current = true;
  };

  const clearFocusRestoreSuppression = () => {
    isRestoringFocusRef.current = false;
  };

  const readyAgentIds = useMemo(() => {
    return LAUNCHABLE_AGENT_IDS.filter((id) => isAgentLaunchable(agentAvailability?.[id]));
  }, [agentAvailability]);

  const isAgentOnToolbar = useCallback(
    (id: BuiltInAgentId) =>
      isAgentButtonOnToolbar(
        agentSettings?.agents?.[id],
        agentAvailability?.[id],
        leftButtons.includes(id) || rightButtons.includes(id)
      ),
    [agentSettings, agentAvailability, leftButtons, rightButtons]
  );

  // Deliberately `isAgentPinned`, not the array-aware `isAgentOnToolbar` the pin
  // affordance reads. This value has to mirror `WelcomeScreen`'s own render
  // predicate exactly, and that one still asks about explicit pins — the two
  // exist to keep the card and the discovery badge from both firing for the same
  // agents, so the moment they disagree a grandfathered profile gets both.
  const hasNoPinnedAgents = useMemo(() => {
    // `false` when settings haven't loaded, matching `WelcomeScreen`'s own
    // `if (!agentSettings) return false` — it declares the card ineligible, so
    // claiming "no pins" here would suppress the badge for a card that is never
    // going to render.
    if (!agentSettings) return false;
    if (!agentSettings.agents) return true;
    return !LAUNCHABLE_AGENT_IDS.some((id) => isAgentPinned(agentSettings.agents?.[id]));
  }, [agentSettings]);

  // While the first-run welcome card is actually being rendered, suppress
  // the launcher discovery badge so the card and badge don't both fire for the
  // same agents. Critically, this is gated on whether the card would render
  // right now — not whether the dismiss flag is false — so a user who pins
  // via the launcher/settings (which leaves `welcomeCardDismissed: false`)
  // still gets Day-N discovery for agents installed later.
  const welcomeCardRenderable =
    onboardingLoaded &&
    hasRealData &&
    !welcomeCardDismissed &&
    readyAgentIds.length > 0 &&
    hasNoPinnedAgents;

  const newAgentIds = useMemo<ReadonlySet<string>>(() => {
    if (!onboardingLoaded || welcomeCardRenderable) return new Set<string>();
    const set = new Set<string>();
    // Snapshot Date.now() once per memo so all agents share a single cutoff
    // for this render. The visibilitychange listener already re-renders on
    // app resume, so a stale `now` can't outlive a session.
    const now = Date.now();
    for (const id of readyAgentIds) {
      if (seenAgentIds.includes(id)) continue;
      const firstSeen = availabilityFirstSeen[id];
      if (firstSeen !== undefined && now - firstSeen >= NEW_AGENT_TTL_MS) continue;
      set.add(id);
    }
    return set;
  }, [onboardingLoaded, welcomeCardRenderable, readyAgentIds, seenAgentIds, availabilityFirstSeen]);

  const showDiscoveryBadge = newAgentIds.size > 0;

  const { launchable, needsSetup, fallbackSetup } = useMemo(() => {
    const launchable: AgentRow[] = [];
    const needsSetup: AgentRow[] = [];
    const fallbackSetup: AgentRow[] = [];

    for (const id of LAUNCHABLE_AGENT_IDS) {
      const pinned = isAgentOnToolbar(id);
      const dominant = agentDominantStates.get(id) ?? null;
      const entry = agentSettings?.agents?.[id];
      const customPresets = entry?.customPresets;
      const ccrPresets = ccrPresetsByAgent[id];
      const projectPresets = projectPresetsByAgent[id];
      const savedPresetId = resolveEffectivePresetId(entry, activeWorktreeId);
      const row = buildAgentRow(
        id,
        pinned,
        dominant,
        newAgentIds.has(id),
        customPresets,
        ccrPresets,
        projectPresets,
        savedPresetId
      );
      if (!row) continue;

      const state = agentAvailability?.[id];
      if (isAgentLaunchable(state)) {
        // Launchable. Passive auth discovery (`authConfirmed: false`) never
        // moves an agent out of Launch — clicking starts the CLI, which
        // prompts for sign-in on first run. The decoupling goal of
        // #5483 requires this path to stay hot.
        launchable.push(row);
      } else if (isAgentInstalled(state)) {
        // Reached for WSL `installed`, blocked agents, and any future
        // non-launchable installed state.
        needsSetup.push(row);
      }
      // Always build a fallback row so we can offer discovery when
      // nothing is installed on this machine.
      fallbackSetup.push(row);
    }

    // Sort Launch by palette frecency (higher score = more recent). Untracked
    // agents keep their natural BUILT_IN_AGENT_IDS order after any tracked
    // ones. Both palette dispatches and launcher launches feed into the same
    // frecency map (the launcher records explicitly in handleLaunch since
    // ActionService.dispatch doesn't auto-record MRU).
    const frecencyEntries = getSortedActionMruList();
    const frecencyScoreMap = new Map<string, number>();
    frecencyEntries.forEach(({ id, score }) => frecencyScoreMap.set(id, score));

    launchable.sort((a, b) => {
      const aScore = frecencyScoreMap.get(`agent.${a.id}`) ?? -Infinity;
      const bScore = frecencyScoreMap.get(`agent.${b.id}`) ?? -Infinity;
      if (aScore === -Infinity && bScore === -Infinity) return 0;
      if (aScore === -Infinity) return 1;
      if (bScore === -Infinity) return -1;
      return bScore - aScore;
    });

    return { launchable, needsSetup, fallbackSetup };
  }, [
    agentAvailability,
    agentSettings,
    agentDominantStates,
    getSortedActionMruList,
    isAgentOnToolbar,
    newAgentIds,
    ccrPresetsByAgent,
    projectPresetsByAgent,
    activeWorktreeId,
  ]);

  const handleLaunch = useCallback(
    (agentId: BuiltInAgentId, presetId?: string | null) => {
      setOpen(false);
      // Clear the NEW signal only for the agent the user actually launched.
      // Opening the dropdown alone used to call markAgentsSeen(readyAgentIds),
      // which burned the discovery cue for every other agent at the same
      // time. Per-launch decay keeps the cue truthful.
      void markAgentsSeen([agentId]);
      // Feed palette frecency from launcher launches too. `ActionService.dispatch`
      // does not auto-record MRU (only `useActionPalette` does), so without
      // this the launcher's MRU-based sort can never reflect launcher usage.
      useActionMruStore.getState().recordActionMru(`agent.${agentId}`);
      // `null` = explicit default — clear both the worktree-scoped override
      // and the agent-level presetId so resolveEffectivePresetId returns
      // undefined and the radio group visually selects "Default".
      if (presetId === null) {
        void useAgentSettingsStore.getState().updateAgent(agentId, { presetId: undefined });
      }
      // Persist the pick to the worktree-scoped slot so a subsequent main-
      // button press on this worktree relaunches the same preset while other
      // worktrees keep their own. `null` clears the scoped override (and
      // dispatches with presetId: null to force a preset-free launch);
      // `undefined` is the plain MRU fall-through and writes nothing.
      if (activeWorktreeId && presetId !== undefined) {
        void updateWorktreePreset(agentId, activeWorktreeId, presetId ?? undefined);
      }
      void actionService.dispatch(
        "agent.launch",
        { agentId, ...(presetId !== undefined ? { presetId } : {}) },
        { source: "user" }
      );
    },
    [activeWorktreeId, markAgentsSeen, updateWorktreePreset]
  );

  const handleSetup = (agentId: BuiltInAgentId) => {
    void actionService.dispatch(
      "app.settings.openTab",
      { tab: "agents", subtab: agentId },
      { source: "user" }
    );
  };

  const handleManageAgents = () => {
    void actionService.dispatch("app.settings.openTab", { tab: "agents" }, { source: "user" });
  };

  const handleOpenAgentSetupWizard = () => {
    window.dispatchEvent(new CustomEvent("daintree:open-agent-setup-wizard"));
  };

  const handleOpenChange = (open: boolean) => {
    setTooltipOpen(false);
    if (!open) return;
    // Fire-and-forget: the store throttle absorbs rapid reopens.
    void refreshAvailability().catch(() => {});
    if (readyAgentIds.length > 0) {
      // Anchor each agent's TTL window on the first time the user could
      // actually see it in the launcher. We deliberately do NOT mark agents
      // seen here — that would burn the NEW dot for everything the user
      // hasn't interacted with. markAgentsSeen now fires per-launch only.
      void recordAgentFirstSeen(readyAgentIds);
    }
  };

  // Keyed per row, not one timestamp for the whole menu: a rapid double-fire on
  // ONE row (pointer + synthesized click, or a held "P") must not toggle twice
  // and land back where it started, but two different rows toggled in quick
  // succession — P, ArrowDown, P, or any assistive input driving the menu — are
  // distinct intents and must both land.
  const guardPinAction = (rowKey: string) => {
    const now = Date.now();
    if (now - (lastPinActionAt.current.get(rowKey) ?? -Infinity) < 50) return false;
    lastPinActionAt.current.set(rowKey, now);
    return true;
  };

  const toggleAgentPin = (row: AgentRow) => {
    if (!guardPinAction(`agent:${row.id}`)) return;
    // Through the shared dispatcher, not `setAgentPinned` directly: it is what
    // also gives a newly-pinned agent a toolbar position, and it is what
    // Settings → Toolbar calls. Two surfaces writing an agent pin two different
    // ways is how a promotion stops surviving a sibling view's write.
    dispatchToolbarVisibility(
      row.id,
      "left",
      {
        agentSettings,
        agentAvailability,
        setAgentPinned,
        toggleButtonVisibility,
        positionAgentButton,
      },
      !row.pinned
    );
  };

  const togglePanelPin = (item: LauncherPanelItem) => {
    if (!guardPinAction(`panel:${item.id}`)) return;
    setPanelButtonOnToolbar(
      item.id,
      !isPanelButtonOnToolbar(item.id, pinnedButtons, leftButtons, rightButtons)
    );
  };

  const stopPointer = (e: ReactPointerEvent) => {
    e.stopPropagation();
  };

  const handleRowKeyDown = (e: KeyboardEvent<HTMLDivElement>, row: AgentRow) => {
    if (e.key === "p" || e.key === "P") {
      e.preventDefault();
      e.stopPropagation();
      toggleAgentPin(row);
    }
  };

  const isPanelDisabled = (id: LauncherPanelButtonId) =>
    (id === "file-browser" && !hasWorkspace) || (id === "dev-server" && !hasProject);

  const panelDisabledReason = (id: LauncherPanelButtonId) => {
    if (id === "file-browser") return "Needs a workspace";
    if (id === "dev-server") return "Needs a project";
    return null;
  };

  const handlePanelSelect = (item: LauncherPanelItem) => {
    if (item.id === "file-browser") {
      onOpenFileBrowser();
      return;
    }
    void actionService.dispatch(item.actionId, undefined, { source: "user" });
  };

  const hasAnyContent = launchable.length > 0 || needsSetup.length > 0;
  // Show every built-in with a Setup badge if nothing is installed — discovery
  // over an unhelpful "No agents available" dead end. Only kicks in once real
  // availability data has landed.
  const showFallback = !isAvailabilityLoading && !hasAnyContent && fallbackSetup.length > 0;

  const renderLaunchItem = (row: AgentRow) => {
    if (row.presets && row.presets.length > 0) {
      return (
        <SplitLaunchItem
          key={`launch-${row.id}`}
          row={row}
          onLaunch={handleLaunch}
          onTogglePin={toggleAgentPin}
          stopPointer={stopPointer}
        />
      );
    }

    return (
      <LaunchRow
        key={`launch-${row.id}`}
        row={row}
        onLaunch={handleLaunch}
        onKeyDown={handleRowKeyDown}
        onTogglePin={toggleAgentPin}
        stopPointer={stopPointer}
      />
    );
  };

  return (
    <LauncherCapturingContext.Provider value={captureContextValue}>
      <DropdownMenu
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          handleOpenChange(o);
        }}
      >
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <Tooltip open={tooltipOpen} onOpenChange={handleTooltipOpenChange}>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    data-toolbar-item={dataToolbarItem}
                    className="toolbar-agent-button text-daintree-text"
                    aria-label={showDiscoveryBadge ? "Launcher — new agents detected" : "Launcher"}
                    onPointerEnter={clearFocusRestoreSuppression}
                  >
                    <span className="relative inline-flex items-center justify-center">
                      <Plus />
                      <span
                        data-testid="launcher-discovery-badge"
                        data-visible={showDiscoveryBadge}
                        className="toolbar-badge absolute top-0 right-0 size-1.5 rounded-full bg-status-info ring-1 ring-daintree-sidebar"
                        aria-hidden="true"
                      />
                    </span>
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="bottom">Launcher</TooltipContent>
            </Tooltip>
          </ContextMenuTrigger>
          <ContextMenuContent className="max-h-[var(--radix-context-menu-content-available-height)] overflow-y-auto">
            <ToolbarContextMenuItems buttonId="launcher" side="left" />
          </ContextMenuContent>
        </ContextMenu>
        <DropdownMenuContent
          align="start"
          sideOffset={4}
          className="min-w-[16rem]"
          onPointerDownOutside={(e) => {
            // Keep the launcher open during shortcut capture so a stray click on
            // the capture row's inner controls doesn't tear down the in-progress
            // recording session.
            if (capturingId !== null) {
              e.preventDefault();
              return;
            }
            wasPointerCloseRef.current = true;
          }}
          onEscapeKeyDown={(e) => {
            // Belt-and-suspenders: SettingsShortcutCapture's window-capture
            // listener already swallows Escape during active recording, but
            // between mounting the capture UI and entering recording state
            // Escape would otherwise reach Radix's DismissableLayer and dismiss
            // the dropdown (lesson #4588). Cancel the capture in-place instead.
            if (capturingId !== null) {
              e.preventDefault();
              setCapturingId(null);
            }
          }}
          onCloseAutoFocus={(e) => {
            suppressTooltipDuringFocusRestore();
            if (wasPointerCloseRef.current) {
              e.preventDefault();
              wasPointerCloseRef.current = false;
            }
          }}
        >
          {isAvailabilityLoading && (
            <div className="px-2.5 py-1.5 text-xs text-daintree-text/60">Checking agents…</div>
          )}

          {launchable.length > 0 && (
            <>
              <DropdownMenuLabel>Launch</DropdownMenuLabel>
              {launchable.map((row) => renderLaunchItem(row))}
            </>
          )}

          {(isAvailabilityLoading || launchable.length > 0) && <DropdownMenuSeparator />}
          <DropdownMenuLabel>Panels</DropdownMenuLabel>
          {LAUNCHER_PANEL_ITEMS.map((item) => (
            <PanelRow
              key={`panel-${item.id}`}
              item={item}
              onToolbar={isPanelButtonOnToolbar(item.id, pinnedButtons, leftButtons, rightButtons)}
              disabled={isPanelDisabled(item.id)}
              disabledReason={panelDisabledReason(item.id)}
              onSelect={handlePanelSelect}
              onTogglePin={togglePanelPin}
              stopPointer={stopPointer}
            />
          ))}

          {needsSetup.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Needs setup</DropdownMenuLabel>
              {needsSetup.map((row) => (
                <DropdownMenuItem
                  key={`setup-${row.id}`}
                  onSelect={() => handleSetup(row.id)}
                  className="group h-7"
                >
                  <span className="mr-2 inline-flex h-4 w-4 items-center justify-center">
                    <row.Icon className="text-text-muted" />
                  </span>
                  <span className="flex-1 text-daintree-text/70">{row.name}</span>
                  <span className="ml-2 shrink-0 rounded border border-daintree-text/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-daintree-text/50">
                    Setup
                  </span>
                </DropdownMenuItem>
              ))}
            </>
          )}

          {showFallback && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Available agents</DropdownMenuLabel>
              {fallbackSetup.map((row) => (
                <DropdownMenuItem
                  key={`fallback-${row.id}`}
                  onSelect={() => handleSetup(row.id)}
                  className="group h-7"
                  data-testid={`launcher-fallback-${row.id}`}
                >
                  <span className="mr-2 inline-flex h-4 w-4 items-center justify-center">
                    <row.Icon className="text-text-muted" />
                  </span>
                  <span className="flex-1 text-daintree-text/70">{row.name}</span>
                  <span className="ml-2 shrink-0 rounded border border-daintree-text/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-daintree-text/50">
                    Setup
                  </span>
                </DropdownMenuItem>
              ))}
              {/*
                Setup belongs to the empty state, not the footer (#11681). It
                only helps when nothing is installed, and as a permanent third
                row it was a second exit competing with `Manage agents` — which
                already reaches the same settings.
              */}
              <DropdownMenuItem onSelect={handleOpenAgentSetupWizard} className="h-7">
                <Plug className="mr-2 h-3.5 w-3.5" />
                Set up agents
              </DropdownMenuItem>
            </>
          )}

          {/*
            `Customize toolbar…` used to sit here too, sharing the `Settings2`
            glyph with `Manage agents` so the two read as the same destination —
            and `ToolbarContextMenuItems` already offers it on this button's
            right click, where a global toolbar control belongs.
          */}
          <DropdownMenuSeparator />
          <DropdownMenuActionItem actionId="panel.palette" className="h-7">
            <SquareMenu className="mr-2 h-3.5 w-3.5 text-text-secondary" />
            More panels…
          </DropdownMenuActionItem>
          <DropdownMenuItem onSelect={handleManageAgents} className="h-7">
            <Settings2 className="mr-2 h-3.5 w-3.5 text-text-secondary" />
            Manage agents
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </LauncherCapturingContext.Provider>
  );
}

function PanelRow({
  item,
  onToolbar,
  disabled,
  disabledReason,
  onSelect,
  onTogglePin,
  stopPointer,
}: {
  item: LauncherPanelItem;
  onToolbar: boolean;
  disabled: boolean;
  disabledReason: string | null;
  onSelect: (item: LauncherPanelItem) => void;
  onTogglePin: (item: LauncherPanelItem) => void;
  stopPointer: (e: ReactPointerEvent) => void;
}) {
  const displayCombo = useKeybindingDisplay(item.actionId);
  const Icon = item.icon;

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "p" || e.key === "P") {
      e.preventDefault();
      e.stopPropagation();
      onTogglePin(item);
    }
  };

  return (
    <DropdownMenuItem
      onSelect={(e) => {
        if (disabled) {
          // Radix does not read `aria-disabled` as its own `disabled` prop, so
          // selection still fires and would close the menu on a row that opens
          // nothing. Guarding the dispatch alone isn't enough — the menu has to
          // stay put too.
          e.preventDefault();
          return;
        }
        onSelect(item);
      }}
      onKeyDown={handleKeyDown}
      // `aria-disabled` rather than `disabled`: a disabled Radix item is skipped
      // by type-ahead and arrow keys, which would also make its pin affordance
      // unreachable from the keyboard — and pinning a panel you haven't opened a
      // project for yet is a reasonable thing to want.
      aria-disabled={disabled || undefined}
      className={cn("group h-7", disabled && "opacity-50")}
      data-testid={`launcher-row-${item.id}`}
    >
      <span className="mr-2 inline-flex h-4 w-4 items-center justify-center">
        <Icon className="h-3.5 w-3.5 text-text-secondary" />
      </span>

      {/*
        The label never changes with state — the reason rides alongside it. A
        command whose visible name mutates re-announces as a different item to a
        screen reader and stops matching its own name under type-ahead. Same
        shape as the `copy-tree` overflow item, which keeps its label and
        surfaces unavailability separately.
      */}
      <span className="flex-1">{item.label}</span>
      {disabled && disabledReason && (
        <span className="ml-2 text-xs text-text-muted">{disabledReason}</span>
      )}

      {displayCombo && <DropdownMenuShortcut>{displayCombo}</DropdownMenuShortcut>}

      <span className="sr-only">Press P to {onToolbar ? "unpin from" : "pin to"} toolbar</span>

      <LauncherPinAffordance
        testId={`launcher-pin-${item.id}`}
        onToolbar={onToolbar}
        onToggle={() => onTogglePin(item)}
        stopPointer={stopPointer}
      />
    </DropdownMenuItem>
  );
}

function LaunchRow({
  row,
  onLaunch,
  onKeyDown,
  onTogglePin,
  stopPointer,
}: {
  row: AgentRow;
  onLaunch: (agentId: BuiltInAgentId, presetId?: string) => void;
  onKeyDown: (e: KeyboardEvent<HTMLDivElement>, row: AgentRow) => void;
  onTogglePin: (row: AgentRow) => void;
  stopPointer: (e: ReactPointerEvent) => void;
}) {
  const displayCombo = useKeybindingDisplay(`agent.${row.id}`);
  const { capturingId, setCapturingId } = useContext(LauncherCapturingContext);
  const isCapturing = capturingId === row.id;

  const handleShortcutSave = useCallback(
    async (combo: string) => {
      const result = await actionService.dispatch(
        "keybinding.setOverride",
        { actionId: `agent.${row.id}`, combo: combo === "" ? [] : [combo] },
        { source: "user" }
      );
      if (!result.ok) {
        // Stay open on failure so the user can retry; surface the failure
        // explicitly since the user otherwise has no visible signal.
        // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
        notify({
          type: "error",
          message: "Couldn't save shortcut",
          duration: 3000,
          priority: "high",
        });
        return;
      }
      setCapturingId(null);
    },
    [row.id, setCapturingId]
  );

  if (isCapturing) {
    return (
      <div
        data-testid={`launcher-capture-${row.id}`}
        // Sidestep DropdownMenuItem semantics during capture — Radix would try
        // to interpret keystrokes inside as menu navigation.
        className="px-2.5 py-2 space-y-2"
        onKeyDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 text-xs text-daintree-text/70">
          <span className="inline-flex h-4 w-4 items-center justify-center shrink-0">
            <BrandMark brandColor={getBrandColorHex(row.id)}>
              <row.Icon brandColor={getBrandColorHex(row.id)} />
            </BrandMark>
          </span>
          <span>Set shortcut for {row.name}</span>
        </div>
        <AgentShortcutCapture
          agentId={row.id}
          onCapture={(combo) => void handleShortcutSave(combo)}
          onCancel={() => setCapturingId(null)}
          compact
        />
      </div>
    );
  }

  return (
    <DropdownMenuItem
      onSelect={() => onLaunch(row.id)}
      onKeyDown={(e) => onKeyDown(e, row)}
      className="group h-7"
      data-testid={`launcher-row-${row.id}`}
    >
      <span className="relative mr-2 inline-flex h-4 w-4 items-center justify-center">
        <BrandMark brandColor={getBrandColorHex(row.id)}>
          <row.Icon brandColor={getBrandColorHex(row.id)} />
        </BrandMark>
        <RunningDot state={row.dominantState} />
      </span>

      <span className="flex-1">{row.name}</span>

      {row.isNew && (
        <>
          <span
            data-testid={`launcher-new-pill-${row.id}`}
            aria-hidden="true"
            className="ml-2 shrink-0 size-1.5 rounded-full bg-status-info ring-1 ring-daintree-sidebar"
          />
          <span className="sr-only">New</span>
        </>
      )}

      {displayCombo && <DropdownMenuShortcut>{displayCombo}</DropdownMenuShortcut>}

      <span className="sr-only">Press P to {row.pinned ? "unpin from" : "pin to"} toolbar</span>

      <span
        role="presentation"
        aria-hidden="true"
        data-testid={`launcher-shortcut-edit-${row.id}`}
        title={displayCombo ? "Change keyboard shortcut" : "Assign keyboard shortcut"}
        onPointerDown={stopPointer}
        onPointerUp={stopPointer}
        onClick={(e) => {
          e.stopPropagation();
          setCapturingId(row.id);
        }}
        className="ml-1 inline-flex h-5 w-5 items-center justify-center rounded-sm text-daintree-text/50 opacity-0 transition-opacity hover:bg-overlay-emphasis hover:text-daintree-text group-data-[highlighted]:opacity-100"
      >
        <Keyboard className="h-3 w-3" />
      </span>

      <LauncherPinAffordance
        testId={`launcher-pin-${row.id}`}
        onToolbar={row.pinned}
        onToggle={() => onTogglePin(row)}
        stopPointer={stopPointer}
      />
    </DropdownMenuItem>
  );
}
