import { useCallback, useMemo } from "react";
import type { AgentSettings, CliAvailability } from "@shared/types";
import type { AnyToolbarButtonId } from "@shared/types/toolbar";
import type { PluginToolbarButtonState } from "@/hooks/usePluginToolbarButtons";
import type { ToolbarButtonConfig } from "@shared/config/toolbarButtonRegistry";
import {
  MAX_PROMOTED_PLUGIN_BUTTONS,
  presentationFeatureForToolbarButton,
  type PresentationLevel,
} from "@shared/config/presentationProfile";
import { projectIdFromPluginInstanceKey } from "@shared/types/plugin";
import {
  isToolbarButtonOnToolbar,
  setToolbarButtonOnToolbar,
  type ToolbarButtonPlacementState,
} from "@/lib/toolbarVisibilityDispatch";
import type {
  ProjectToolbarOverlay,
  useResolvedPresentation,
} from "@/hooks/useResolvedPresentation";
import { useToolbarPreferencesStore } from "@/store";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { useProjectPresentationStore } from "@/store/projectPresentationStore";
import { TOOLBAR_BUTTON_METADATA } from "./toolbarButtonMetadata";
import type { ProjectToolbarMenuState } from "./ToolbarButtonsContextMenu";
import {
  buildToolbarVisibilityMenuRows,
  canListToolbarButton,
  resolveToolbarButtonMetadata,
  type ToolbarSide,
  type ToolbarVisibilityMenuRow,
} from "./toolbarVisibilityMenu";
import { saveProjectToolbar } from "./saveProjectToolbar";
import { PROJECT_SCOPED_TOOLBAR_IDS } from "./useToolbarItemPlacement";

type ToolbarPreferencesState = ReturnType<typeof useToolbarPreferencesStore.getState>;

export interface ToolbarCustomizationInput {
  hasProject: boolean;
  projectToolbarMode: boolean;
  toolbarOverlay: ProjectToolbarOverlay;
  presentation: ReturnType<typeof useResolvedPresentation>;
  explicitDevPreviewLevel: PresentationLevel | undefined;
  appPinnedButtons: ToolbarPreferencesState["layout"]["pinnedButtons"];
  pinnedButtons: ToolbarPreferencesState["layout"]["pinnedButtons"];
  toolbarLayout: ToolbarPreferencesState["layout"];
  positionAgentButton: ToolbarPreferencesState["positionAgentButton"];
  effectiveAgentSettings: AgentSettings | null | undefined;
  agentAvailability: CliAvailability | undefined;
  pluginButtonIds: PluginToolbarButtonState["buttonIds"];
  pluginConfigs: ReadonlyMap<string, ToolbarButtonConfig>;
  positionedLeftButtons: AnyToolbarButtonId[];
  positionedRightButtons: AnyToolbarButtonId[];
  dynamicOverflowMeta: Parameters<typeof resolveToolbarButtonMetadata>[2];
  buttonRegistry: Record<string, { isAvailable: boolean }>;
}

// The empty-space menu (#12355): its rows, where a toggle is written, and the
// project-toolbar switch it carries while a profile can lay one over the app's.
export function useToolbarCustomization({
  hasProject,
  projectToolbarMode,
  toolbarOverlay,
  presentation,
  explicitDevPreviewLevel,
  appPinnedButtons,
  pinnedButtons,
  toolbarLayout,
  positionAgentButton,
  effectiveAgentSettings,
  agentAvailability,
  pluginButtonIds,
  pluginConfigs,
  positionedLeftButtons,
  positionedRightButtons,
  dynamicOverflowMeta,
  buttonRegistry,
}: ToolbarCustomizationInput) {
  const setPresentationLevel = useProjectPresentationStore((s) => s.setLevel);
  const setProjectToolbarEnabled = useProjectPresentationStore((s) => s.setToolbarEnabled);
  const setProjectPluginButtonPromoted = useProjectPresentationStore(
    (s) => s.setPluginButtonPromoted
  );
  const toggleButtonVisibility = useToolbarPreferencesStore(
    (state) => state.toggleButtonVisibility
  );
  const setPluginButtonPromoted = useToolbarPreferencesStore(
    (state) => state.setPluginButtonPromoted
  );
  const setPanelButtonOnToolbar = useToolbarPreferencesStore(
    (state) => state.setPanelButtonOnToolbar
  );
  const setLauncherItemOnToolbar = useToolbarPreferencesStore(
    (state) => state.setLauncherItemOnToolbar
  );
  const setAgentPinned = useAgentSettingsStore((s) => s.setAgentPinned);

  // The same bundle Settings → Toolbar hands the placement resolvers, so the
  // empty-space menu's checkmarks and toggles route exactly as that page does.
  const toolbarPlacementState = useMemo<ToolbarButtonPlacementState>(
    () => ({
      pinnedButtons,
      leftButtons: toolbarLayout.leftButtons,
      rightButtons: toolbarLayout.rightButtons,
      agentSettings: effectiveAgentSettings,
      agentAvailability,
      isPluginContribution: (id) => pluginConfigs.has(id),
    }),
    [
      pinnedButtons,
      toolbarLayout.leftButtons,
      toolbarLayout.rightButtons,
      effectiveAgentSettings,
      agentAvailability,
      pluginConfigs,
    ]
  );

  // This project's own plugin buttons (#13783). Installed plugins have no say
  // over placement (#11304), so only these can be promoted by the profile.
  const overlayProjectId = toolbarOverlay.projectId;
  const ownProjectPluginButtonIds = useMemo(
    () =>
      overlayProjectId === null
        ? []
        : pluginButtonIds.filter(
            (id) =>
              projectIdFromPluginInstanceKey(pluginConfigs.get(id)?.pluginId ?? "") ===
              overlayProjectId
          ),
    [overlayProjectId, pluginButtonIds, pluginConfigs]
  );

  // In project mode the menu also offers this project's own plugin buttons
  // that are only in the tray, so one can be promoted from here.
  const menuRightButtons = useMemo(() => {
    if (!projectToolbarMode) return positionedRightButtons;
    const listed = new Set<AnyToolbarButtonId>([
      ...positionedLeftButtons,
      ...positionedRightButtons,
    ]);
    const trayOnly = ownProjectPluginButtonIds.filter((id) => !listed.has(id));
    return trayOnly.length === 0
      ? positionedRightButtons
      : [...positionedRightButtons, ...trayOnly];
  }, [
    projectToolbarMode,
    positionedLeftButtons,
    positionedRightButtons,
    ownProjectPluginButtonIds,
  ]);

  // Rows for the empty-space menu (#12355), built from the side lists before
  // the visibility filter so a hidden button still has one.
  const appToolbarMenuRows = useMemo(
    () =>
      buildToolbarVisibilityMenuRows(positionedLeftButtons, menuRightButtons, {
        resolveMetadata: (id) =>
          resolveToolbarButtonMetadata(id, TOOLBAR_BUTTON_METADATA, dynamicOverflowMeta),
        canList: (id) =>
          canListToolbarButton(
            id,
            buttonRegistry,
            PROJECT_SCOPED_TOOLBAR_IDS,
            effectiveAgentSettings,
            agentAvailability
          ),
        isOnToolbar: (id) => isToolbarButtonOnToolbar(id, toolbarPlacementState),
      }),
    [
      positionedLeftButtons,
      menuRightButtons,
      dynamicOverflowMeta,
      buttonRegistry,
      effectiveAgentSettings,
      agentAvailability,
      toolbarPlacementState,
    ]
  );

  const projectPromotedCount = toolbarOverlay.promotedPluginButtons.length;
  // In project mode a row is the profile's to change only for the closed list
  // of demotable built-ins and this project's own plugin buttons. Every other
  // row stays listed with its app-wide state, but can't be changed from here:
  // this menu writes nothing app-wide while the project's toolbar is in use.
  const toolbarMenuRows = useMemo(() => {
    // The dev preview's row follows this project's level whichever toolbar is
    // in use (#14069): hidden or demoted here it isn't on the toolbar, and
    // shown explicitly it is, slot or no slot in the app-wide layout.
    const toDevPreviewRow = (row: ToolbarVisibilityMenuRow): ToolbarVisibilityMenuRow => {
      if (row.id !== "dev-server" || !hasProject) return row;
      const shown = presentation.devServer === "shown";
      return {
        ...row,
        checked: explicitDevPreviewLevel !== undefined ? shown : row.checked && shown,
      };
    };
    if (!projectToolbarMode) {
      return {
        left: appToolbarMenuRows.left.map(toDevPreviewRow),
        right: appToolbarMenuRows.right.map(toDevPreviewRow),
      };
    }
    const ownPlugins = new Set<string>(ownProjectPluginButtonIds);
    const promoted = new Set(toolbarOverlay.promotedPluginButtons);
    const toProjectRow = (row: ToolbarVisibilityMenuRow): ToolbarVisibilityMenuRow => {
      if (row.id === "dev-server") return toDevPreviewRow(row);
      const feature = presentationFeatureForToolbarButton(row.id);
      if (feature !== undefined) {
        const level = presentation[feature];
        return { ...row, checked: row.checked && level !== "demoted" && level !== "hidden" };
      }
      if (ownPlugins.has(row.id)) {
        // An app-wide pin isn't the profile's to take away.
        const appPinned = appPinnedButtons[row.id] === true;
        const atCap = !promoted.has(row.id) && projectPromotedCount >= MAX_PROMOTED_PLUGIN_BUTTONS;
        return { ...row, disabled: appPinned || (atCap && !row.checked) };
      }
      return { ...row, disabled: true };
    };
    return {
      left: appToolbarMenuRows.left.map(toProjectRow),
      right: appToolbarMenuRows.right.map(toProjectRow),
    };
  }, [
    hasProject,
    explicitDevPreviewLevel,
    projectToolbarMode,
    appToolbarMenuRows,
    ownProjectPluginButtonIds,
    toolbarOverlay.promotedPluginButtons,
    projectPromotedCount,
    presentation,
    appPinnedButtons,
  ]);

  const handleToolbarMenuToggle = useCallback(
    (buttonId: AnyToolbarButtonId, side: ToolbarSide, onToolbar: boolean) => {
      // A level this project set for the dev preview stays its to change: an
      // app-wide write would land in every other project and change nothing here.
      // So does showing one this project hides by default (#14069): the layout
      // may already hold its slot, and only the project's level can draw it.
      if (
        buttonId === "dev-server" &&
        hasProject &&
        (explicitDevPreviewLevel !== undefined ||
          (onToolbar && presentation.devServer === "hidden"))
      ) {
        saveProjectToolbar(() =>
          setPresentationLevel("devServer", onToolbar ? "shown" : "demoted")
        );
        return;
      }
      if (projectToolbarMode) {
        // Never falls through to an app-wide setter below.
        const feature = presentationFeatureForToolbarButton(buttonId);
        if (feature !== undefined) {
          // An explicit "shown" keeps the button on this project's toolbar
          // even where it is off app-wide.
          saveProjectToolbar(() => setPresentationLevel(feature, onToolbar ? "shown" : "demoted"));
        } else if ((ownProjectPluginButtonIds as readonly string[]).includes(buttonId)) {
          saveProjectToolbar(() => setProjectPluginButtonPromoted(buttonId, onToolbar));
        }
        return;
      }
      setToolbarButtonOnToolbar(buttonId, side, onToolbar, toolbarPlacementState, {
        setAgentPinned,
        toggleButtonVisibility,
        positionAgentButton,
        setPluginButtonPromoted,
        setPanelButtonOnToolbar,
        setLauncherItemOnToolbar,
      });
    },
    [
      hasProject,
      explicitDevPreviewLevel,
      presentation.devServer,
      projectToolbarMode,
      setPresentationLevel,
      ownProjectPluginButtonIds,
      setProjectPluginButtonPromoted,
      toolbarPlacementState,
      setAgentPinned,
      toggleButtonVisibility,
      positionAgentButton,
      setPluginButtonPromoted,
      setPanelButtonOnToolbar,
      setLauncherItemOnToolbar,
    ]
  );

  const projectToolbarMenu: ProjectToolbarMenuState | null =
    toolbarOverlay.available && hasProject
      ? {
          active: toolbarOverlay.active,
          onToggle: (active) => saveProjectToolbar(() => setProjectToolbarEnabled(active)),
          branchChip:
            toolbarOverlay.active && presentation.branchChip !== "hidden"
              ? {
                  checked: presentation.branchChip === "shown",
                  onToggle: (shown) =>
                    saveProjectToolbar(() =>
                      setPresentationLevel("branchChip", shown ? "shown" : "demoted")
                    ),
                }
              : null,
        }
      : null;
  return { toolbarMenuRows, handleToolbarMenuToggle, projectToolbarMenu };
}
