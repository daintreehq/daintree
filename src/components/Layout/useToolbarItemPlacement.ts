import { useCallback, useEffect, useMemo } from "react";
import type { AgentToolbarPins, CliAvailability } from "@shared/types";
import { agentToolbarPin } from "@shared/types/ipc/agentToolbarPins";
import type { AnyToolbarButtonId } from "@shared/types/toolbar";
import type { PluginToolbarButtonState } from "@/hooks/usePluginToolbarButtons";
import { BUILT_IN_AGENT_IDS } from "@shared/config/agentIds";
import { PRESENTATION_FEATURE_BY_TOOLBAR_BUTTON } from "@shared/config/presentationProfile";
import type { PresentationLevels } from "@shared/config/presentationProfile";
import { isPluginToolbarButtonIdShape } from "@shared/types/toolbar";
import type { ToolbarButtonConfig } from "@shared/config/toolbarButtonRegistry";
import { isAgentPinned } from "../../../shared/utils/agentPinned";
import { getToolbarButtonGroup, isToolbarButtonVisible } from "./toolbarButtonMetadata";
import { orderToolbarButtonsByGroup } from "./toolbarButtonGrouping";
import type { LauncherToolbarCatalog } from "./launcherToolbarCatalog";
import type { useResolvedPresentation } from "@/hooks/useResolvedPresentation";
import type { useToolbarPreferencesStore } from "@/store";

// These controls are project-only visually, but their no-drag rectangles must
// exist on first paint so secondary windows don't cache them as titlebar drag.
const PROJECT_SCOPED_TOOLBAR_IDS = new Set<AnyToolbarButtonId>(["dev-server", "forge-stats"]);

// Hardware-privacy indicators stay out of the overflow dropdown while their
// signal is active — collapsing them under `…` would hide the only visual
// cue that the host is recording. Voice recording joins this set only when
// the user is actively recording (see `pinnedRightIds` derivation below);
// future mic/camera/screen-share indicators that follow the same principle
// should be added here.
const VOICE_RECORDING_PINNED: ReadonlySet<AnyToolbarButtonId> = new Set(["voice-recording"]);
const NO_PINNED_IDS: ReadonlySet<AnyToolbarButtonId> = new Set();

// Buttons this project's presentation profile demotes (#13771). Stable so the
// overflow hook's recalculate callback doesn't re-fire on every render.
const NO_DEMOTED_IDS: ReadonlySet<AnyToolbarButtonId> = new Set();

export interface ToolbarItemPlacementInput {
  toolbarLayout: ReturnType<typeof useToolbarPreferencesStore.getState>["layout"];
  positionAgentButton: ReturnType<
    typeof useToolbarPreferencesStore.getState
  >["positionAgentButton"];
  projectToolbarMode: boolean;
  profileLevels: PresentationLevels;
  promotedPluginButtons: readonly string[];
  presentation: ReturnType<typeof useResolvedPresentation>;
  hasProject: boolean;
  devPreviewPlaced: boolean;
  devPreviewHidden: boolean;
  forgeStatsHidden: boolean;
  /** This machine's toolbar agent pins (#14702). */
  agentPins: Readonly<AgentToolbarPins>;
  agentAvailability: CliAvailability | undefined;
  launcherCatalog: LauncherToolbarCatalog;
  pluginButtonIds: PluginToolbarButtonState["buttonIds"];
  pluginConfigs: ReadonlyMap<string, ToolbarButtonConfig>;
  buttonRegistry: Record<string, { isAvailable: boolean }>;
  hasActiveVoiceRecording: boolean;
}

// Which buttons hold a slot on each side, which of those are drawn, and which
// the width budget measures. The overflow hook itself stays with the toolbar,
// which owns the measured rows.
export function useToolbarItemPlacement({
  toolbarLayout,
  positionAgentButton,
  projectToolbarMode,
  profileLevels,
  promotedPluginButtons,
  presentation,
  hasProject,
  devPreviewPlaced,
  devPreviewHidden,
  forgeStatsHidden,
  agentPins,
  agentAvailability,
  launcherCatalog,
  pluginButtonIds,
  pluginConfigs,
  buttonRegistry,
  hasActiveVoiceRecording,
}: ToolbarItemPlacementInput) {
  const appPinnedButtons = toolbarLayout.pinnedButtons;
  // The app-wide pins with this project's toolbar laid over them. Only ever
  // read: every write still goes to the app-wide store or the profile.
  const pinnedButtons = useMemo(() => {
    if (!projectToolbarMode) {
      return devPreviewPlaced ? { ...appPinnedButtons, "dev-server": true } : appPinnedButtons;
    }
    const next = { ...appPinnedButtons };
    for (const [buttonId, feature] of PRESENTATION_FEATURE_BY_TOOLBAR_BUTTON) {
      // Demoted counts too: the button has to stay mounted to be folded into
      // `…`, even where it is off app-wide.
      const level = profileLevels[feature];
      if (level === "shown" || level === "demoted") next[buttonId] = true;
    }
    if (devPreviewPlaced) next["dev-server"] = true;
    for (const id of promotedPluginButtons) {
      // Plugin button ids are `{instanceKey}.{id}`; main only stores those.
      if (isPluginToolbarButtonIdShape(id)) next[id] = true;
    }
    return next;
  }, [
    projectToolbarMode,
    appPinnedButtons,
    profileLevels,
    promotedPluginButtons,
    devPreviewPlaced,
  ]);

  // An agent the user explicitly pinned but that sits in neither side array
  // still has to render (#11680). Two ways to get here, and neither can be
  // repaired in the store's `merge()` — the pin lives in
  // `agentToolbarPinsStore`, which loads asynchronously over IPC and isn't
  // readable at toolbar-store hydration:
  //   - a genuinely fresh profile, where main's first CLI check pins the first
  //     few installed agents (`seedAgentToolbarPinsIfUnset`) before the user
  //     has ever touched the toolbar;
  //   - a stale sibling project view overwriting the orderings, which reconcile
  //     last-writer-wins and so drop a position another view just wrote (the
  //     same window `restorePromotedPanelButtons` covers for panels).
  // `isAgentPinned`, not `isAgentToolbarVisible`: only an explicit `true` earns
  // a slot here. Reading the tri-state's installed-means-visible fall-through
  // would put every installed CLI back on the toolbar, which is the crowding
  // this issue removed.
  const unpositionedAgentPins = useMemo(() => {
    const onEitherSide = new Set([...toolbarLayout.leftButtons, ...toolbarLayout.rightButtons]);
    return BUILT_IN_AGENT_IDS.filter(
      (id) => !onEitherSide.has(id) && isAgentPinned(agentToolbarPin(agentPins, id))
    );
  }, [toolbarLayout.leftButtons, toolbarLayout.rightButtons, agentPins]);

  // Materialize those positions once they're knowable, so the repair is a
  // one-frame bridge rather than a permanent ghost. A rendered-but-unpositioned
  // button is absent from Settings → Toolbar's sortable columns and inert to
  // `moveButton`, which reads the arrays — the first-run seeding above would
  // otherwise leave up to five agents that can never be reordered. The action
  // no-ops when the id already holds a position, writes nothing to
  // `pinnedButtons`, and converges under a concurrent sibling view. One batched
  // call, not a call per id: every insert lands at the same index, so repairing
  // the first-run seeding one agent at a time would persist them reversed
  // against the order they just rendered in.
  useEffect(() => {
    if (unpositionedAgentPins.length > 0) positionAgentButton(unpositionedAgentPins);
  }, [unpositionedAgentPins, positionAgentButton]);

  // Whichever side the launcher is on — that is where the things pinned out of
  // it belong. Splicing unconditionally into the left would strand them away
  // from a launcher the user moved right.
  const launcherOnRight =
    toolbarLayout.rightButtons.includes("launcher") &&
    !toolbarLayout.leftButtons.includes("launcher");

  // The same repair as `unpositionedAgentPins`, for the same window, over the
  // ids a launcher item pins under (#12217). Only entries in the live catalog:
  // a pin whose recipe belongs to another project has nothing to position, and
  // giving it a slot here would put a dead id in the arrays every project
  // switch.
  const unpositionedLauncherItemPins = useMemo(() => {
    const onEitherSide = new Set([...toolbarLayout.leftButtons, ...toolbarLayout.rightButtons]);
    return [...launcherCatalog.keys()].filter(
      (id) => !onEitherSide.has(id) && pinnedButtons[id] === true
    );
  }, [toolbarLayout.leftButtons, toolbarLayout.rightButtons, launcherCatalog, pinnedButtons]);

  // Materialized for the same reason the agent repair above is: a
  // rendered-but-unpositioned button is inert to `moveButton`, which reads the
  // arrays, so leaving it as a render-time ghost would make a pinned recipe
  // permanently un-reorderable. `positionAgentButton` is generic over button
  // ids despite its name — it no-ops on an id that already holds a position and
  // writes nothing to `pinnedButtons`.
  useEffect(() => {
    if (unpositionedLauncherItemPins.length > 0) {
      positionAgentButton(unpositionedLauncherItemPins);
    }
  }, [unpositionedLauncherItemPins, positionAgentButton]);

  // A slot for the dev preview's button in a project that shows it explicitly
  // but whose app-wide layout holds none (#14069). Render-only, like the
  // pins above: never positioned, so the layout stays what the user made it.
  const unpositionedDevPreview = useMemo<AnyToolbarButtonId[]>(
    () =>
      devPreviewPlaced &&
      !toolbarLayout.leftButtons.includes("dev-server") &&
      !toolbarLayout.rightButtons.includes("dev-server")
        ? ["dev-server"]
        : [],
    [devPreviewPlaced, toolbarLayout.leftButtons, toolbarLayout.rightButtons]
  );

  // Declared group per button, resolved against the live plugin registry so a
  // contribution is classified by membership rather than by parsing its id.
  const resolveToolbarGroup = useCallback(
    (id: AnyToolbarButtonId) => getToolbarButtonGroup(id, pluginConfigs.has(id)),
    [pluginConfigs]
  );

  // Every button holding a slot on each side, hidden or not. The toolbar draws
  // the visible subset; its empty-space menu (#12355) lists the whole set, since
  // hiding never takes a button's position away.
  const positionedLeftButtons = useMemo(() => {
    // Dedupe defensively so a persisted list holding a repeated id never
    // renders duplicate pills (#10937) — the store also heals this, this is
    // belt-and-suspenders at the render boundary.
    const positioned = Array.from(new Set(toolbarLayout.leftButtons));

    const unpositionedLeftPins = launcherOnRight
      ? []
      : [...unpositionedAgentPins, ...unpositionedLauncherItemPins, ...unpositionedDevPreview];
    if (unpositionedLeftPins.length > 0) {
      // Right after the launcher they were pinned out of, so they lead the
      // agent run in registry order rather than trailing the positioned ones.
      // Grouping below is what keeps the brand marks contiguous; this only
      // decides their order within that group.
      const launcherIndex = positioned.indexOf("launcher");
      positioned.splice(
        launcherIndex === -1 ? positioned.length : launcherIndex + 1,
        0,
        ...unpositionedLeftPins
      );
    }

    // Grouped, not persisted order (#11681): the divider marks a group
    // boundary, so the groups have to actually be contiguous. Ordering here
    // rather than at the render loop means overflow, keyboard roving, and the
    // DOM all see the same canonical sequence.
    return orderToolbarButtonsByGroup(positioned, resolveToolbarGroup);
  }, [
    toolbarLayout.leftButtons,
    launcherOnRight,
    unpositionedAgentPins,
    unpositionedLauncherItemPins,
    unpositionedDevPreview,
    resolveToolbarGroup,
  ]);

  const isButtonShownOnToolbar = useCallback(
    (id: AnyToolbarButtonId) =>
      // A profile overlay, applied here at the render boundary and never
      // written into the app-wide layout (#10938): the pin survives, so
      // showing the pill again puts it back where it was.
      !(forgeStatsHidden && id === "forge-stats") &&
      !(devPreviewHidden && id === "dev-server") &&
      isToolbarButtonVisible(
        id,
        pinnedButtons,
        agentPins,
        agentAvailability,
        pluginConfigs.has(id)
      ),
    [forgeStatsHidden, devPreviewHidden, pinnedButtons, agentPins, agentAvailability, pluginConfigs]
  );

  // Filtering the grouped list yields the same sequence as grouping the filtered
  // one — grouping is a stable partition.
  const effectiveLeftButtons = useMemo(
    () => positionedLeftButtons.filter(isButtonShownOnToolbar),
    [positionedLeftButtons, isButtonShownOnToolbar]
  );

  const positionedRightButtons = useMemo(() => {
    // Dedupe the persisted base before appending plugin extras, so duplicate
    // ids (e.g. repeated `forge-stats`, #10937) can't render twice.
    const base = Array.from(new Set(toolbarLayout.rightButtons));
    if (
      launcherOnRight &&
      (unpositionedAgentPins.length > 0 ||
        unpositionedLauncherItemPins.length > 0 ||
        unpositionedDevPreview.length > 0)
    ) {
      const launcherIndex = base.indexOf("launcher");
      base.splice(
        launcherIndex === -1 ? base.length : launcherIndex + 1,
        0,
        ...unpositionedAgentPins,
        ...unpositionedLauncherItemPins,
        ...unpositionedDevPreview
      );
    }
    const positioned = new Set([...base, ...toolbarLayout.leftButtons]);
    // Only *promoted* contributions append — plugin buttons reach the user
    // through the tray by default now (#11304), so the pre-tray behavior of
    // appending every registered id would resurrect the crowding this
    // replaced. Buttons the user already dragged into a side list keep that
    // position and are filtered on promotion below like any other id.
    const extra = pluginButtonIds.filter((id) => !positioned.has(id) && pinnedButtons[id] === true);
    // Grouped like the left (#11681): the default right set is all utilities,
    // so this changes nothing until a user moves a panel or agent across the
    // centre — at which point the divider rules have to mean the same thing
    // on both sides.
    return orderToolbarButtonsByGroup([...base, ...extra], resolveToolbarGroup);
  }, [
    toolbarLayout.rightButtons,
    toolbarLayout.leftButtons,
    launcherOnRight,
    unpositionedAgentPins,
    unpositionedLauncherItemPins,
    unpositionedDevPreview,
    pluginButtonIds,
    pinnedButtons,
    resolveToolbarGroup,
  ]);

  const effectiveRightButtons = useMemo(
    () => positionedRightButtons.filter(isButtonShownOnToolbar),
    [positionedRightButtons, isButtonShownOnToolbar]
  );

  const availableLeftIds = useMemo(
    () =>
      effectiveLeftButtons.filter(
        (id) => buttonRegistry[id]?.isAvailable || PROJECT_SCOPED_TOOLBAR_IDS.has(id)
      ),
    [effectiveLeftButtons, buttonRegistry]
  );

  const availableRightIds = useMemo(
    () =>
      effectiveRightButtons.filter(
        (id) => buttonRegistry[id]?.isAvailable || PROJECT_SCOPED_TOOLBAR_IDS.has(id)
      ),
    [effectiveRightButtons, buttonRegistry]
  );

  // Pin the voice-recording indicator out of overflow while a recording is
  // active so the user never loses sight of the live mic signal. Applies to
  // whichever side the user has placed the button — overflow honors the
  // pin regardless of left/right placement. The set reference is stabilized
  // so the overflow hook's recalculate callback doesn't re-fire on every
  // render.
  const pinnedIds = hasActiveVoiceRecording ? VOICE_RECORDING_PINNED : NO_PINNED_IDS;

  // Demoted by this project's profile: kept out of the width budget, so the
  // row sizes as if the button weren't there, and always in the `…` menu. It
  // stays mounted like any evicted button — the menu's forge rows open the
  // pill's dropdowns through its ref.
  // Keyed on a string so the set only changes when what is demoted does.
  const demotedKey = !hasProject
    ? ""
    : [...PRESENTATION_FEATURE_BY_TOOLBAR_BUTTON]
        .filter(([, feature]) => presentation[feature] === "demoted")
        .map(([buttonId]) => buttonId)
        .join(" ");
  const demotedIds = useMemo<ReadonlySet<AnyToolbarButtonId>>(() => {
    if (demotedKey === "") return NO_DEMOTED_IDS;
    const demoted = new Set(demotedKey.split(" "));
    return new Set(
      [...PRESENTATION_FEATURE_BY_TOOLBAR_BUTTON.keys()].filter((id) => demoted.has(id))
    );
  }, [demotedKey]);
  const measuredLeftIds = useMemo(
    () => availableLeftIds.filter((id) => !demotedIds.has(id)),
    [availableLeftIds, demotedIds]
  );
  const measuredRightIds = useMemo(
    () => availableRightIds.filter((id) => !demotedIds.has(id)),
    [availableRightIds, demotedIds]
  );

  return {
    appPinnedButtons,
    pinnedButtons,
    resolveToolbarGroup,
    positionedLeftButtons,
    positionedRightButtons,
    effectiveLeftButtons,
    effectiveRightButtons,
    availableLeftIds,
    availableRightIds,
    pinnedIds,
    demotedIds,
    measuredLeftIds,
    measuredRightIds,
  };
}

export { PROJECT_SCOPED_TOOLBAR_IDS };
