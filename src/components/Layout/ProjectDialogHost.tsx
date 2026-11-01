import { Suspense, lazy, useCallback, useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { lazyWithPreload } from "@/lib/lazyWithPreload";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { useKeepMounted } from "@/hooks/useKeepMounted";
import { useWorktrees } from "@/hooks/useWorktrees";
import { useResolvedForgeProvider } from "@/hooks/useResolvedForgeProvider";
import { useBuiltinView } from "@/registry/builtinRendererRegistry";
import type { ForgeBulkCreateWorktreeDialogProps } from "@/types/forgeSlotProps";
import {
  useProjectSurface,
  useSurfaceSwitchedToStock,
} from "@/components/Plugin/ProjectSurfaceView";
import { ProjectWorktreeCreateDialog } from "./ProjectWorktreeCreateDialog";
import { useProjectStore } from "@/store/projectStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useFleetPickerPaletteStore } from "@/store/fleetPickerPaletteStore";
import { useSchedulesViewStore } from "@/store/schedulesViewStore";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { useRecipeDialogState } from "./useRecipeDialogState";

const LazyNewWorktreeDialog = lazyWithPreload(
  () => import("@/components/Worktree/NewWorktreeDialog"),
  (m) => m.NewWorktreeDialog
);
export const preloadNewWorktreeDialog = LazyNewWorktreeDialog.preload;
const LazyFleetPickerPalette = lazy(() =>
  import("@/components/Fleet/FleetPickerPalette").then((m) => ({
    default: m.FleetPickerPalette,
  }))
);
const LazyRecipeEditor = lazy(() =>
  import("@/components/TerminalRecipe/RecipeEditor").then((m) => ({ default: m.RecipeEditor }))
);
const LazyRecipeManager = lazy(() =>
  import("@/components/TerminalRecipe/RecipeManager").then((m) => ({ default: m.RecipeManager }))
);
const LazySchedulesDialog = lazy(() =>
  import("@/components/Schedules/SchedulesDialog").then((m) => ({ default: m.SchedulesDialog }))
);

/**
 * Dialogs that belong to the project view rather than to any one sidebar view.
 * They open from actions, the palette and keybindings as well as from sidebar
 * buttons, so they must answer whichever sidebar view is showing, while the
 * sidebar is collapsed, and in a workspace with no git worktrees.
 */
function ProjectDialogHost() {
  const projectId = useProjectStore((state) => state.currentProject?.id ?? null);
  const rootPath = useProjectStore((state) => state.currentProject?.path ?? "");
  const {
    createDialog,
    closeCreateDialog,
    showStockCreateDialog,
    closeSurfaceCreateDialog,
    bulkCreateDialog,
    closeBulkCreateDialog,
  } = useWorktreeSelectionStore(
    useShallow((state) => ({
      createDialog: state.createDialog,
      closeCreateDialog: state.closeCreateDialog,
      showStockCreateDialog: state.showStockCreateDialog,
      closeSurfaceCreateDialog: state.closeSurfaceCreateDialog,
      bulkCreateDialog: state.bulkCreateDialog,
      closeBulkCreateDialog: state.closeBulkCreateDialog,
    }))
  );
  // Disabled so the host doesn't re-render on every worktree-map change; only
  // `refresh` is read.
  const { refresh } = useWorktrees({ enabled: false });
  // The plugin's dialog shows only while the claim this opening was handed to
  // still renders and the user hasn't chosen stock; otherwise the same opening
  // falls through to the stock dialog with its prefills intact.
  const worktreeCreateSurface = useProjectSurface("worktreeCreate");
  const worktreeCreateSwitchedToStock = useSurfaceSwitchedToStock("worktreeCreate");
  const openingKindId = createDialog.isOpen ? createDialog.surfacePanelKindId : undefined;
  const pluginCreateConfig =
    openingKindId !== undefined && worktreeCreateSurface?.config.id === openingKindId
      ? worktreeCreateSurface.config
      : null;
  const openingId = createDialog.openingId;
  // The opening whose plugin dialog has been on screen. Only that one has an
  // exit to play; one switched to stock before it ever showed falls straight
  // through like a lost claim.
  const [shownPluginOpening, setShownPluginOpening] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (pluginCreateConfig !== null) setShownPluginOpening(openingId);
  }, [pluginCreateConfig, openingId]);
  // Stock chosen while the plugin dialog is up (its strip's switch, the consent
  // notice, or another window): the dialog closes first and hands the opening
  // over once focus is back on the control that opened it, as "Standard
  // dialog…" does. Opened in the same render, stock would record the plugin
  // dialog's unmounting control as its opener and strand focus when it closes.
  const leavingCreateConfig =
    pluginCreateConfig === null &&
    openingKindId !== undefined &&
    shownPluginOpening === openingId &&
    worktreeCreateSwitchedToStock?.config.id === openingKindId
      ? worktreeCreateSwitchedToStock.config
      : null;
  const pluginDialogConfig = pluginCreateConfig ?? leavingCreateConfig;
  const isStockCreateOpen = createDialog.isOpen && pluginDialogConfig === null;
  // A claim that stops rendering mid-opening hands that opening to stock for
  // good: if the same claim came back, swapping a fresh plugin view in would
  // tear down a stock form the user may already be filling.
  const lostClaim = openingKindId !== undefined && pluginDialogConfig === null;
  useEffect(() => {
    if (lostClaim) showStockCreateDialog();
  }, [lostClaim, showStockCreateDialog]);
  const closePluginCreateDialog = useCallback(
    () => closeSurfaceCreateDialog(openingId),
    [closeSurfaceCreateDialog, openingId]
  );
  const shouldMountNewWorktreeDialog = useKeepMounted(isStockCreateOpen);

  // Resolved reactively from the active provider's slot so the dialog drops
  // out (and back in) live with the owning plugin's enable state instead of
  // holding a stale slot reference. Issue mode lists issues, so it's the
  // issues provider's dialog; PR mode stays with the code forge.
  const resolvedForge = useResolvedForgeProvider(projectId);
  const forgeProviderEntry =
    bulkCreateDialog.mode === "issue" ? resolvedForge.issues.entry : resolvedForge.entry;
  const BulkCreateWorktreeDialog = useBuiltinView<ForgeBulkCreateWorktreeDialogProps>(
    forgeProviderEntry?.contribution.slots?.bulkCreateWorktreeDialog ?? ""
  );

  const {
    isRecipeEditorOpen,
    recipeEditorWorktreeId,
    recipeEditorInitialTerminals,
    recipeEditorLayoutOmissions,
    recipeEditorDefaultScope,
    recipeManagerEdit,
    isRecipeManagerOpen,
    handleCloseRecipeEditor,
    handleCloseRecipeManager,
    handleRecipeManagerEdit,
    handleRecipeManagerCreate,
  } = useRecipeDialogState();
  const shouldMountRecipeEditor = useKeepMounted(isRecipeEditorOpen);
  const shouldMountRecipeManager = useKeepMounted(isRecipeManagerOpen);

  const isFleetPickerOpen = useFleetPickerPaletteStore((state) => state.isOpen);
  const closeFleetPicker = useFleetPickerPaletteStore((state) => state.close);
  const shouldMountFleetPicker = useKeepMounted(isFleetPickerOpen);
  // The open flag outlives the host in its store; a host that unmounts with the
  // workspace must not bring the palette back with the next one.
  useEffect(() => () => useFleetPickerPaletteStore.getState().close(), []);

  const isSchedulesOpen = useSchedulesViewStore((state) => state.isOpen);
  const closeSchedules = useSchedulesViewStore((state) => state.close);
  const shouldMountSchedules = useKeepMounted(isSchedulesOpen);
  useEffect(() => () => useSchedulesViewStore.getState().close(), []);

  return (
    <>
      <ErrorBoundary
        variant="component"
        componentName="RecipeEditor"
        resetKeys={[Number(isRecipeEditorOpen)]}
      >
        {shouldMountRecipeEditor && (
          <Suspense fallback={null}>
            <LazyRecipeEditor
              recipe={recipeManagerEdit}
              worktreeId={recipeEditorWorktreeId}
              initialTerminals={recipeEditorInitialTerminals}
              layoutOmissions={recipeEditorLayoutOmissions}
              defaultScope={recipeEditorDefaultScope}
              isOpen={isRecipeEditorOpen}
              onClose={handleCloseRecipeEditor}
            />
          </Suspense>
        )}
      </ErrorBoundary>

      <ErrorBoundary
        variant="component"
        componentName="RecipeManager"
        resetKeys={[Number(isRecipeManagerOpen)]}
      >
        {shouldMountRecipeManager && (
          <Suspense fallback={null}>
            <LazyRecipeManager
              isOpen={isRecipeManagerOpen}
              onClose={handleCloseRecipeManager}
              onEditRecipe={handleRecipeManagerEdit}
              onCreateRecipe={handleRecipeManagerCreate}
            />
          </Suspense>
        )}
      </ErrorBoundary>

      {rootPath && shouldMountNewWorktreeDialog && (
        <ErrorBoundary
          variant="component"
          componentName="NewWorktreeDialog"
          resetKeys={[Number(isStockCreateOpen)]}
        >
          <Suspense fallback={null}>
            <LazyNewWorktreeDialog
              isOpen={isStockCreateOpen}
              onClose={closeCreateDialog}
              rootPath={rootPath}
              onWorktreeCreated={(worktreeId) => {
                safeFireAndForget(refresh(), { context: "Refreshing worktrees after create" });
                createDialog.onCreated?.(worktreeId);
              }}
              initialIssue={createDialog.initialIssue}
              initialPR={createDialog.initialPR}
              initialRecipeId={createDialog.initialRecipeId}
              initialBranchInput={createDialog.initialBranchInput}
              initialAgentId={createDialog.initialAgentId}
              initialPrompt={createDialog.initialPrompt}
            />
          </Suspense>
        </ErrorBoundary>
      )}

      {pluginDialogConfig !== null && (
        // Keyed by opening, so a hand-off one opening started never carries
        // into the next.
        <ErrorBoundary
          key={openingId}
          variant="component"
          componentName="ProjectWorktreeCreateDialog"
          resetKeys={[pluginDialogConfig.id]}
        >
          <ProjectWorktreeCreateDialog
            config={pluginDialogConfig}
            isOpen
            leavingForStock={leavingCreateConfig !== null}
            onClose={closePluginCreateDialog}
            onUseStock={showStockCreateDialog}
          />
        </ErrorBoundary>
      )}

      <ErrorBoundary
        variant="component"
        componentName="BulkCreateWorktreeDialog"
        resetKeys={[Number(bulkCreateDialog.isOpen)]}
      >
        {bulkCreateDialog.isOpen && BulkCreateWorktreeDialog && (
          <Suspense fallback={null}>
            <BulkCreateWorktreeDialog
              isOpen
              onClose={closeBulkCreateDialog}
              mode={bulkCreateDialog.mode}
              selectedIssues={bulkCreateDialog.selectedIssues}
              selectedPRs={bulkCreateDialog.selectedPRs}
              onComplete={closeBulkCreateDialog}
            />
          </Suspense>
        )}
      </ErrorBoundary>

      <ErrorBoundary
        variant="component"
        componentName="SchedulesDialog"
        resetKeys={[Number(isSchedulesOpen)]}
      >
        {shouldMountSchedules && (
          <Suspense fallback={null}>
            <LazySchedulesDialog isOpen={isSchedulesOpen} onClose={closeSchedules} />
          </Suspense>
        )}
      </ErrorBoundary>

      <ErrorBoundary
        variant="component"
        componentName="FleetPickerPalette"
        resetKeys={[Number(isFleetPickerOpen)]}
      >
        {shouldMountFleetPicker && (
          <Suspense fallback={null}>
            <LazyFleetPickerPalette isOpen={isFleetPickerOpen} onClose={closeFleetPicker} />
          </Suspense>
        )}
      </ErrorBoundary>
    </>
  );
}

export { ProjectDialogHost };
