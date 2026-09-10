import { isBuiltInAgentId } from "@shared/config/agentIds";
import type { AgentSettings, CliAvailability } from "@shared/types";
import type {
  AnyToolbarButtonId,
  LauncherItemToolbarButtonId,
  LauncherPanelButtonId,
  PluginToolbarButtonId,
  ToolbarPinnedState,
} from "@/../../shared/types/toolbar";
// `@shared/...` because these are value imports — the type-only spelling above
// is erased at compile time and never has to resolve at runtime.
import {
  isLauncherItemOnToolbar,
  isLauncherItemToolbarButtonId,
  isLauncherPanelButtonId,
  isPanelButtonOnToolbar,
} from "@shared/types/toolbar";
import { isAgentButtonOnToolbar, isAgentToolbarVisible } from "../../shared/utils/agentPinned";

export interface ToolbarVisibilityDispatchDeps {
  agentSettings: AgentSettings | null | undefined;
  agentAvailability: CliAvailability | null | undefined;
  setAgentPinned: (agentId: string, pinned: boolean) => void | Promise<void>;
  toggleButtonVisibility: (buttonId: AnyToolbarButtonId, side: "left" | "right") => void;
  /**
   * Gives a newly-pinned agent a toolbar position when it has none (#11680).
   * Optional so callers that only need the pin write — and cannot render a
   * toolbar anyway — keep working unchanged.
   */
  positionAgentButton?: (buttonId: AnyToolbarButtonId) => void;
}

/**
 * Routes a toolbar visibility toggle to the correct store.
 *
 * Agent IDs (entries in `BUILT_IN_AGENT_IDS`) write through `setAgentPinned`
 * so the pin lives in `agentSettingsStore` (the IPC-persisted, tri-state
 * source per #7673). Every other ID — including `launcher` and plugin
 * buttons — writes through `toggleButtonVisibility` on the toolbar store.
 *
 * When `explicitPinned` is omitted the agent branch toggles the *currently
 * derived* visible state, so an `undefined` pin (no explicit user
 * preference) flips to the opposite of the live CLI-availability state
 * rather than to the opposite of raw `pinned`.
 *
 * Pinning an agent also asks for a position. Since #11680 removed the
 * `LAUNCHABLE_AGENT_IDS` spread from `DEFAULT_LEFT_BUTTONS`, a fresh profile's
 * agent ids sit in neither side array, so the pin alone would leave the button
 * with nowhere to render — the same gap `setPanelButtonOnToolbar` closes for
 * `browser`/`dev-server`. Both surfaces that can pin an agent (the launcher and
 * Settings → Toolbar) route through this one function precisely so they cannot
 * disagree about that.
 */
export function dispatchToolbarVisibility(
  buttonId: AnyToolbarButtonId,
  side: "left" | "right",
  deps: ToolbarVisibilityDispatchDeps,
  explicitPinned?: boolean
): void {
  if (isBuiltInAgentId(buttonId)) {
    const nextPinned =
      explicitPinned ??
      !isAgentToolbarVisible(
        deps.agentSettings?.agents?.[buttonId],
        deps.agentAvailability?.[buttonId]
      );
    // Synchronous, deliberately, even though `setAgentPinned` is an async IPC
    // that can roll its optimistic write back. Deferring the position until the
    // write resolves buys nothing: `Toolbar.tsx` materializes a position for any
    // agent reading as explicitly pinned, and it reads the SAME optimistic
    // state, so it would persist the position during the in-flight window
    // regardless. Two mechanisms racing to write the same value is worse than
    // one that always does.
    //
    // The residual is small and self-correcting: if the pin write fails, the
    // rollback leaves an unset pin over a real position, which
    // `isAgentButtonOnToolbar` reads as on — so the button the user asked for
    // appears (and keeps appearing across restarts, since array membership is
    // exactly how a grandfathered agent stays visible) while `setAgentPinned`
    // separately surfaces the failure. Nothing is lost; the intent is recorded
    // in the other of the two stores.
    if (nextPinned) deps.positionAgentButton?.(buttonId);
    void deps.setAgentPinned(buttonId, nextPinned);
    return;
  }
  deps.toggleButtonVisibility(buttonId, side);
}

// Plugin button ids are namespaced `{pluginId}.{buttonId}` by main, so the dot
// is structural — this narrows without an unsafe assertion. It is only a
// discriminator alongside registry membership: a launcher item's id can carry a
// dot too.
export function isPluginToolbarButtonId(id: AnyToolbarButtonId): id is PluginToolbarButtonId {
  return id.includes(".");
}

/** Everything the per-category placement resolvers read. */
export interface ToolbarButtonPlacementState {
  pinnedButtons: ToolbarPinnedState;
  leftButtons: AnyToolbarButtonId[];
  rightButtons: AnyToolbarButtonId[];
  agentSettings: AgentSettings | null | undefined;
  agentAvailability: CliAvailability | null | undefined;
  /**
   * Live plugin registry membership — the discriminator for a contribution,
   * never string-parsing the dotted id (#11304).
   */
  isPluginContribution: (buttonId: AnyToolbarButtonId) => boolean;
}

export interface ToolbarButtonPlacementActions {
  setAgentPinned: ToolbarVisibilityDispatchDeps["setAgentPinned"];
  toggleButtonVisibility: ToolbarVisibilityDispatchDeps["toggleButtonVisibility"];
  positionAgentButton: (buttonId: AnyToolbarButtonId) => void;
  setPluginButtonPromoted: (buttonId: PluginToolbarButtonId, promoted: boolean) => void;
  setPanelButtonOnToolbar: (buttonId: LauncherPanelButtonId, onToolbar: boolean) => void;
  setLauncherItemOnToolbar: (buttonId: LauncherItemToolbarButtonId, onToolbar: boolean) => void;
}

/**
 * Whether a button currently has its own top-level toolbar slot, read through
 * the resolver that owns its category.
 *
 * The array-aware resolvers rather than `isToolbarButtonVisible`: away from the
 * side arrays that predicate's "absent means visible" default reports a fresh
 * profile's `browser` and an installed-but-unpositioned agent as on while
 * neither is anywhere on the toolbar (#11667, #11680). For a positioned id the
 * two agree, which is what lets a surface draw checkmarks from this and still
 * match the toolbar it describes.
 */
export function isToolbarButtonOnToolbar(
  buttonId: AnyToolbarButtonId,
  state: ToolbarButtonPlacementState
): boolean {
  if (state.isPluginContribution(buttonId) && isPluginToolbarButtonId(buttonId)) {
    return state.pinnedButtons[buttonId] === true;
  }
  if (isLauncherItemToolbarButtonId(buttonId)) {
    return isLauncherItemOnToolbar(buttonId, state.pinnedButtons);
  }
  if (isLauncherPanelButtonId(buttonId)) {
    return isPanelButtonOnToolbar(
      buttonId,
      state.pinnedButtons,
      state.leftButtons,
      state.rightButtons
    );
  }
  if (isBuiltInAgentId(buttonId)) {
    return isAgentButtonOnToolbar(
      state.agentSettings?.agents?.[buttonId],
      state.agentAvailability?.[buttonId],
      state.leftButtons.includes(buttonId) || state.rightButtons.includes(buttonId)
    );
  }
  return state.pinnedButtons[buttonId] !== false;
}

/**
 * Give a button its own top-level toolbar slot, or take it away, through the
 * setter that owns its category. Settings → Toolbar and the toolbar's own
 * right-click menu (#12355) both route through here so they cannot disagree.
 *
 * A no-op when the button already reads as requested: `toggleButtonVisibility`
 * can only flip, so a caller holding a stale checkmark would otherwise invert
 * the very state it asked for.
 */
export function setToolbarButtonOnToolbar(
  buttonId: AnyToolbarButtonId,
  side: "left" | "right",
  onToolbar: boolean,
  state: ToolbarButtonPlacementState,
  actions: ToolbarButtonPlacementActions
): void {
  if (isToolbarButtonOnToolbar(buttonId, state) === onToolbar) return;

  // A plugin id can still sit in a persisted side array (the v9 migration
  // deliberately keeps ids a user dragged there). Its switch has to route
  // through the promotion action: the generic toggle only alternates
  // `false`/absent, and under tray-default neither of those is promoted, so
  // the switch could never turn the button on (#11304).
  if (state.isPluginContribution(buttonId) && isPluginToolbarButtonId(buttonId)) {
    actions.setPluginButtonPromoted(buttonId, onToolbar);
    return;
  }
  // Before the plugin check would have been wrong and after the panel check
  // would be unreachable: a launcher item's id can carry a dot (a
  // plugin-contributed recipe is `publisher.name`), and only the registry
  // membership test above keeps that from reading as a plugin button here.
  if (isLauncherItemToolbarButtonId(buttonId)) {
    actions.setLauncherItemOnToolbar(buttonId, onToolbar);
    return;
  }
  // Launcher panel buttons need the same treatment for a different reason
  // (#11667). `browser` and `dev-server` are not defaults, so the generic
  // toggle's "delete the key to show" leaves nothing recording that the user
  // wants them — and a stale sibling view's write, which replaces the position
  // arrays wholesale, would then silently un-promote them with nothing left to
  // rebuild from. `setPanelButtonOnToolbar` writes the explicit `true` that
  // survives, and positions the button if it has no slot yet.
  if (isLauncherPanelButtonId(buttonId)) {
    actions.setPanelButtonOnToolbar(buttonId, onToolbar);
    return;
  }
  // Agents get the explicit next state rather than the dispatcher's own
  // `isAgentToolbarVisible` fallback: since #11680 an installed-but-unpositioned
  // agent reads as visible to that fallback while rendering nothing, so a flip
  // would write `false` on a button the user is trying to turn on. Non-agent ids
  // ignore the argument.
  dispatchToolbarVisibility(
    buttonId,
    side,
    {
      agentSettings: state.agentSettings,
      agentAvailability: state.agentAvailability,
      setAgentPinned: actions.setAgentPinned,
      toggleButtonVisibility: actions.toggleButtonVisibility,
      positionAgentButton: actions.positionAgentButton,
    },
    isBuiltInAgentId(buttonId) ? onToolbar : undefined
  );
}
