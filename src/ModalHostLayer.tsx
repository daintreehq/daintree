import { Suspense } from "react";
import type { WorktreeState, Project } from "@shared/types";
import type { AgentSessionRecord } from "@shared/types/ipc/agentSessionHistory";
import type { UseQuickSwitcherReturn } from "./hooks/useQuickSwitcher";
import { useSendToAgentPalette } from "./hooks/useSendToAgentPalette";
import type { UseNewTerminalPaletteReturn } from "./hooks/useNewTerminalPalette";
import { MORE_AGENTS_PANEL_ID, type UsePanelPaletteReturn } from "./hooks/usePanelPalette";
import type { UseProjectSwitcherPaletteReturn } from "./hooks/useProjectSwitcherPalette";
import type { UseActionPaletteReturn } from "./hooks/useActionPalette";
import type { UseWorktreePaletteReturn } from "./hooks/useWorktreePalette";
import type { UseQuickCreatePaletteReturn } from "./hooks/useQuickCreatePalette";
import type { WorktreeActions } from "./hooks/useWorktreeActions";
import type { GettingStartedChecklistState } from "./hooks/app/useGettingStartedChecklist";
import type { ReEntrySummaryState } from "./hooks/useReEntrySummary";
import type { UseAgentLauncherReturn } from "./hooks/useAgentLauncher";
import type { PluginDeepLinkState } from "./hooks/app";
import type { SettingsTab } from "./components/Settings";
import type { BuiltInPanelKind } from "./types";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ConfirmDialog } from "./components/ui/ConfirmDialog";
import { Toaster } from "./components/ui/toaster";
import { ShortcutHint } from "./components/ui/ShortcutHint";
import { ReEntrySummary } from "./components/ui/ReEntrySummary";
import { TerminalInfoDialogHost } from "./components/Terminal/TerminalInfoDialogHost";
import { PostHydrationListeners } from "./components/PostHydrationListeners";
import { PanelTransitionOverlay } from "./components/Panel";
import { usePanelStore, usePluginManagerStore } from "./store";
import { actionService } from "./services/ActionService";
import {
  LazyQuickSwitcher,
  LazySendToAgentPalette,
  LazyNewTerminalPalette,
  LazyWorktreePalette,
  LazyQuickCreatePalette,
  LazyPanelPalette,
  LazyProjectSwitcherPalette,
  LazyThemePalette,
  LazyResumeSessionsPalette,
  LazyLogLevelPalette,
  LazyActionPalette,
  LazyWorktreeOverviewModal,
  LazyCrossWorktreeDiff,
  LazySettingsDialog,
  LazyShortcutReferenceDialog,
  LazyPluginManagerView,
  LazyMcpConfirmDialog,
  LazyPluginConfirmDialog,
  LazyPluginArchiveInstallConfirmDialog,
  LazyPluginMcpConfirmDialog,
  LazyPluginQuickPickDialog,
  LazyPluginInputBoxDialog,
  LazyPluginConfirmPromptDialog,
  LazyPluginCapabilityConfirmDialog,
  LazyPanelDialogHost,
  LazyGitInitDialog,
  LazyCreateProjectFolderDialog,
  LazyCloneRepoDialog,
  LazyPanelLimitConfirmDialog,
  LazyDiagnosticsReviewDialogHost,
  LazyGitPushConfirmDialog,
  LazyGitPullRebaseConfirmDialog,
  LazyRecipeConflictDialog,
  LazyOnboardingFlow,
  LazyGettingStartedChecklist,
  LazyCelebrationConfetti,
} from "./lazyPanels";

interface ModalHostLayerProps {
  quickSwitcher: UseQuickSwitcherReturn;
  shouldMountQuickSwitcher: boolean;
  sendToAgentPalette: ReturnType<typeof useSendToAgentPalette>;
  shouldMountSendToAgentPalette: boolean;
  newTerminalPalette: UseNewTerminalPaletteReturn;
  shouldMountNewTerminalPalette: boolean;
  worktreePalette: UseWorktreePaletteReturn;
  shouldMountWorktreePalette: boolean;
  quickCreatePalette: UseQuickCreatePaletteReturn;
  shouldMountQuickCreatePalette: boolean;
  panelPalette: UsePanelPaletteReturn;
  shouldMountPanelPalette: boolean;
  resumeSession: (session: AgentSessionRecord) => Promise<void>;
  handleLaunchAgent: (type: string) => void | Promise<void>;
  addPanel: ReturnType<typeof usePanelStore.getState>["addPanel"];
  defaultTerminalCwd: string | undefined;
  activeWorktreeId: string | null;
  isProjectSwitcherModalOpen: boolean;
  projectSwitcherPalette: UseProjectSwitcherPaletteReturn;
  isThemePaletteOpen: boolean;
  shouldMountThemePalette: boolean;
  closeThemePalette: () => void;
  isResumeSessionsPaletteOpen: boolean;
  shouldMountResumeSessionsPalette: boolean;
  isLogLevelPaletteOpen: boolean;
  shouldMountLogLevelPalette: boolean;
  closeLogLevelPalette: () => void;
  actionPalette: UseActionPaletteReturn;
  shouldMountActionPalette: boolean;
  isWorktreeOverviewOpen: boolean;
  closeWorktreeOverview: () => void;
  worktrees: WorktreeState[];
  isLoading: boolean;
  focusedWorktreeId: string | null;
  selectWorktree: (id: string, options?: { source?: "user" | "focus" }) => void;
  overviewWorktreeActions: WorktreeActions;
  availability: UseAgentLauncherReturn["availability"];
  agentSettings: UseAgentLauncherReturn["agentSettings"];
  homeDir: string | undefined;
  crossDiffDialog: { isOpen: boolean; initialWorktreeId: string | null };
  shouldMountCrossDiffDialog: boolean;
  closeCrossWorktreeDiff: () => void;
  isSettingsOpen: boolean;
  shouldMountSettings: boolean;
  setIsSettingsOpen: (open: boolean) => void;
  settingsTab: SettingsTab | undefined;
  settingsSubtab: string | undefined;
  settingsSectionId: string | undefined;
  refreshSettings: () => Promise<void>;
  currentProject: Project | null;
  isShortcutsOpen: boolean;
  shouldMountShortcutsDialog: boolean;
  setIsShortcutsOpen: (open: boolean) => void;
  isPluginManagerOpen: boolean;
  shouldMountPluginManager: boolean;
  pluginDeepLink: PluginDeepLinkState;
  terminalInfoResetKey: number;
  isStateLoaded: boolean;
  mcpConfirmResetKey: string;
  pluginConfirmResetKey: string;
  pluginMcpConfirmResetKey: string;
  pluginCapabilityConfirmResetKey: string;
  pluginArchiveInstallResetKey: string;
  panelLimitResetKey: number;
  diagnosticsReviewResetKey: number;
  gitPushResetKey: number;
  gitPullRebaseResetKey: number;
  recipeConflictResetKey: number;
  gitInitDialogOpen: boolean;
  shouldMountGitInitDialog: boolean;
  effectiveGitInitPath: string | null;
  handleGitInitSuccess: () => Promise<void>;
  closeGitInitDialog: () => void;
  createFolderDialogOpen: boolean;
  shouldMountCreateFolderDialog: boolean;
  closeCreateFolderDialog: () => void;
  cloneRepoDialogOpen: boolean;
  shouldMountCloneRepoDialog: boolean;
  handleCloneSuccess: (clonedPath: string) => Promise<void>;
  closeCloneRepoDialog: () => void;
  reEntrySummary: ReEntrySummaryState;
  gettingStarted: GettingStartedChecklistState;
}

/**
 * Every always-mounted or conditionally-lazy palette, dialog, and overlay
 * host in the app shell — one `ErrorBoundary` + `Suspense` pair per lazy
 * child, matching the original inline structure 1:1 so each host's fault
 * isolation and reset-key behavior is unchanged by the move out of AppInner.
 */
export function ModalHostLayer({
  quickSwitcher,
  shouldMountQuickSwitcher,
  sendToAgentPalette,
  shouldMountSendToAgentPalette,
  newTerminalPalette,
  shouldMountNewTerminalPalette,
  worktreePalette,
  shouldMountWorktreePalette,
  quickCreatePalette,
  shouldMountQuickCreatePalette,
  panelPalette,
  shouldMountPanelPalette,
  resumeSession,
  handleLaunchAgent,
  addPanel,
  defaultTerminalCwd,
  activeWorktreeId,
  isProjectSwitcherModalOpen,
  projectSwitcherPalette,
  isThemePaletteOpen,
  shouldMountThemePalette,
  closeThemePalette,
  isResumeSessionsPaletteOpen,
  shouldMountResumeSessionsPalette,
  isLogLevelPaletteOpen,
  shouldMountLogLevelPalette,
  closeLogLevelPalette,
  actionPalette,
  shouldMountActionPalette,
  isWorktreeOverviewOpen,
  closeWorktreeOverview,
  worktrees,
  isLoading,
  focusedWorktreeId,
  selectWorktree,
  overviewWorktreeActions,
  availability,
  agentSettings,
  homeDir,
  crossDiffDialog,
  shouldMountCrossDiffDialog,
  closeCrossWorktreeDiff,
  isSettingsOpen,
  shouldMountSettings,
  setIsSettingsOpen,
  settingsTab,
  settingsSubtab,
  settingsSectionId,
  refreshSettings,
  currentProject,
  isShortcutsOpen,
  shouldMountShortcutsDialog,
  setIsShortcutsOpen,
  isPluginManagerOpen,
  shouldMountPluginManager,
  pluginDeepLink,
  terminalInfoResetKey,
  isStateLoaded,
  mcpConfirmResetKey,
  pluginConfirmResetKey,
  pluginMcpConfirmResetKey,
  pluginCapabilityConfirmResetKey,
  pluginArchiveInstallResetKey,
  panelLimitResetKey,
  diagnosticsReviewResetKey,
  gitPushResetKey,
  gitPullRebaseResetKey,
  recipeConflictResetKey,
  gitInitDialogOpen,
  shouldMountGitInitDialog,
  effectiveGitInitPath,
  handleGitInitSuccess,
  closeGitInitDialog,
  createFolderDialogOpen,
  shouldMountCreateFolderDialog,
  closeCreateFolderDialog,
  cloneRepoDialogOpen,
  shouldMountCloneRepoDialog,
  handleCloneSuccess,
  closeCloneRepoDialog,
  reEntrySummary,
  gettingStarted,
}: ModalHostLayerProps) {
  return (
    <>
      <ErrorBoundary
        variant="component"
        componentName="QuickSwitcher"
        resetKeys={[Number(quickSwitcher.isOpen)]}
      >
        {shouldMountQuickSwitcher && (
          <Suspense fallback={null}>
            <LazyQuickSwitcher
              isOpen={quickSwitcher.isOpen}
              query={quickSwitcher.query}
              results={quickSwitcher.results}
              totalResults={quickSwitcher.totalResults}
              selectedIndex={quickSwitcher.selectedIndex}
              isLoading={quickSwitcher.isLoading}
              close={quickSwitcher.close}
              setQuery={quickSwitcher.setQuery}
              setSelectedIndex={quickSwitcher.setSelectedIndex}
              selectPrevious={quickSwitcher.selectPrevious}
              selectNext={quickSwitcher.selectNext}
              selectItem={quickSwitcher.selectItem}
              confirmSelection={quickSwitcher.confirmSelection}
            />
          </Suspense>
        )}
      </ErrorBoundary>
      <ErrorBoundary
        variant="component"
        componentName="SendToAgentPalette"
        resetKeys={[Number(sendToAgentPalette.isOpen)]}
      >
        {shouldMountSendToAgentPalette && (
          <Suspense fallback={null}>
            <LazySendToAgentPalette
              isOpen={sendToAgentPalette.isOpen}
              query={sendToAgentPalette.query}
              results={sendToAgentPalette.results}
              totalResults={sendToAgentPalette.totalResults}
              selectedIndex={sendToAgentPalette.selectedIndex}
              close={sendToAgentPalette.close}
              setQuery={sendToAgentPalette.setQuery}
              selectPrevious={sendToAgentPalette.selectPrevious}
              selectNext={sendToAgentPalette.selectNext}
              selectItem={sendToAgentPalette.selectItem}
              confirmSelection={sendToAgentPalette.confirmSelection}
            />
          </Suspense>
        )}
      </ErrorBoundary>
      <ErrorBoundary
        variant="component"
        componentName="NewTerminalPalette"
        resetKeys={[Number(newTerminalPalette.isOpen)]}
      >
        {shouldMountNewTerminalPalette && (
          <Suspense fallback={null}>
            <LazyNewTerminalPalette
              isOpen={newTerminalPalette.isOpen}
              query={newTerminalPalette.query}
              results={newTerminalPalette.results}
              selectedIndex={newTerminalPalette.selectedIndex}
              onQueryChange={newTerminalPalette.setQuery}
              onSelectPrevious={newTerminalPalette.selectPrevious}
              onSelectNext={newTerminalPalette.selectNext}
              onSelect={newTerminalPalette.handleSelect}
              onConfirm={newTerminalPalette.confirmSelection}
              onClose={newTerminalPalette.close}
              onHoverIndex={newTerminalPalette.setSelectedIndex}
            />
          </Suspense>
        )}
      </ErrorBoundary>
      <ErrorBoundary
        variant="component"
        componentName="WorktreePalette"
        resetKeys={[Number(worktreePalette.isOpen)]}
      >
        {shouldMountWorktreePalette && (
          <Suspense fallback={null}>
            <LazyWorktreePalette
              isOpen={worktreePalette.isOpen}
              query={worktreePalette.query}
              results={worktreePalette.results}
              totalResults={worktreePalette.totalResults}
              activeWorktreeId={worktreePalette.activeWorktreeId}
              selectedIndex={worktreePalette.selectedIndex}
              isStale={worktreePalette.isStale}
              onQueryChange={worktreePalette.setQuery}
              onSelectPrevious={worktreePalette.selectPrevious}
              onSelectNext={worktreePalette.selectNext}
              onSelect={worktreePalette.selectWorktree}
              onConfirm={worktreePalette.confirmSelection}
              onClose={worktreePalette.close}
            />
          </Suspense>
        )}
      </ErrorBoundary>
      <ErrorBoundary
        variant="component"
        componentName="QuickCreatePalette"
        resetKeys={[Number(quickCreatePalette.isOpen)]}
      >
        {shouldMountQuickCreatePalette && (
          <Suspense fallback={null}>
            <LazyQuickCreatePalette palette={quickCreatePalette} />
          </Suspense>
        )}
      </ErrorBoundary>
      <ErrorBoundary
        variant="component"
        componentName="PanelPalette"
        resetKeys={[Number(panelPalette.isOpen)]}
      >
        {shouldMountPanelPalette && (
          <Suspense fallback={null}>
            <LazyPanelPalette
              isOpen={panelPalette.isOpen}
              query={panelPalette.query}
              results={panelPalette.results}
              totalResults={panelPalette.totalResults}
              selectedIndex={panelPalette.selectedIndex}
              matchesById={panelPalette.matchesById}
              onQueryChange={panelPalette.setQuery}
              onSelectPrevious={panelPalette.selectPrevious}
              onSelectNext={panelPalette.selectNext}
              onSelect={(kind) => {
                const result = panelPalette.handleSelect(kind);
                if (!result) return;
                if (result.resumeSession) {
                  void resumeSession(result.resumeSession);
                } else if (result.id.startsWith("agent:")) {
                  const agentId = result.id.slice("agent:".length);
                  if (agentId) {
                    void handleLaunchAgent(agentId);
                  }
                } else {
                  addPanel({
                    kind: result.id as BuiltInPanelKind,
                    cwd: defaultTerminalCwd,
                    worktreeId: activeWorktreeId ?? undefined,
                    location: "grid",
                  });
                }
              }}
              onConfirm={() => {
                const selected = panelPalette.confirmSelection();
                if (!selected) return;
                if (selected.id === MORE_AGENTS_PANEL_ID) return;
                if (selected.resumeSession) {
                  void resumeSession(selected.resumeSession);
                } else if (selected.id.startsWith("agent:")) {
                  const agentId = selected.id.slice("agent:".length);
                  if (agentId) {
                    void handleLaunchAgent(agentId);
                  }
                } else {
                  addPanel({
                    kind: selected.id as BuiltInPanelKind,
                    cwd: defaultTerminalCwd,
                    worktreeId: activeWorktreeId ?? undefined,
                    location: "grid",
                  });
                }
              }}
              onClose={panelPalette.close}
            />
          </Suspense>
        )}
      </ErrorBoundary>
      <ErrorBoundary
        variant="component"
        componentName="ProjectSwitcherPalette"
        resetKeys={[Number(isProjectSwitcherModalOpen)]}
      >
        {isProjectSwitcherModalOpen && (
          <Suspense fallback={null}>
            <LazyProjectSwitcherPalette
              isOpen={isProjectSwitcherModalOpen}
              query={projectSwitcherPalette.query}
              results={projectSwitcherPalette.results}
              selectedIndex={projectSwitcherPalette.selectedIndex}
              onQueryChange={projectSwitcherPalette.setQuery}
              onSelectPrevious={projectSwitcherPalette.selectPrevious}
              onSelectNext={projectSwitcherPalette.selectNext}
              onSelect={projectSwitcherPalette.selectProject}
              onHoverProject={projectSwitcherPalette.onHoverProject}
              onHoverProjectEnd={projectSwitcherPalette.onHoverProjectEnd}
              onClose={projectSwitcherPalette.close}
              onStopProject={(projectId) => void projectSwitcherPalette.stopProject(projectId)}
              onCloseProject={(projectId) => void projectSwitcherPalette.removeProject(projectId)}
              onFreeMemoryProject={(projectId) =>
                void projectSwitcherPalette.freeMemoryProject(projectId)
              }
              onLocateProject={(projectId) => void projectSwitcherPalette.locateProject(projectId)}
              onTogglePinProject={(projectId) =>
                void projectSwitcherPalette.togglePinProject(projectId)
              }
              onCopyPath={projectSwitcherPalette.copyPath}
              removeConfirmProject={projectSwitcherPalette.removeConfirmProject}
              onRemoveConfirmClose={() => projectSwitcherPalette.setRemoveConfirmProject(null)}
              onConfirmRemove={projectSwitcherPalette.confirmRemoveProject}
              isRemovingProject={projectSwitcherPalette.isRemovingProject}
              freeMemoryConfirmProject={projectSwitcherPalette.freeMemoryConfirmProject}
              onFreeMemoryConfirmClose={() =>
                projectSwitcherPalette.setFreeMemoryConfirmProject(null)
              }
              onConfirmFreeMemory={projectSwitcherPalette.confirmFreeMemory}
              isFreeingMemory={projectSwitcherPalette.isFreeingMemory}
              onSelectNewWindow={(project) => {
                projectSwitcherPalette.close();
                void actionService.dispatch(
                  "app.newWindow",
                  { projectPath: project.path },
                  { source: "user" }
                );
              }}
              scratchResults={projectSwitcherPalette.scratchResults}
              onCreateScratch={(name) => void projectSwitcherPalette.createScratch(name)}
              onSelectScratch={(scratch) => void projectSwitcherPalette.selectScratch(scratch)}
              onRemoveScratch={(scratchId) =>
                void projectSwitcherPalette.removeScratchAction(scratchId)
              }
              onRequestDeleteAllScratches={projectSwitcherPalette.requestDeleteAllScratches}
              deleteAllScratchesConfirm={projectSwitcherPalette.deleteAllScratchesConfirm}
              onDismissDeleteAllScratchesConfirm={
                projectSwitcherPalette.dismissDeleteAllScratchesConfirm
              }
              onConfirmDeleteAllScratches={() =>
                void projectSwitcherPalette.confirmDeleteAllScratches()
              }
              isDeletingAllScratches={projectSwitcherPalette.isDeletingAllScratches}
              onRenameScratch={(scratchId, name) =>
                void projectSwitcherPalette.renameScratch(scratchId, name)
              }
              onSaveAsProject={(scratchId) => void projectSwitcherPalette.saveAsProject(scratchId)}
              saveAsProjectConfirm={projectSwitcherPalette.saveAsProjectConfirm}
              onDismissSaveAsProjectConfirm={projectSwitcherPalette.dismissSaveAsProjectConfirm}
              onConfirmDeleteOriginalScratch={() =>
                void projectSwitcherPalette.confirmDeleteOriginalScratch()
              }
              isDeletingOriginalScratch={projectSwitcherPalette.isDeletingOriginalScratch}
            />
          </Suspense>
        )}
      </ErrorBoundary>
      <ConfirmDialog
        isOpen={projectSwitcherPalette.stopConfirmProjectId != null}
        onClose={() => {
          if (projectSwitcherPalette.isStoppingProject) return;
          projectSwitcherPalette.setStopConfirmProjectId(null);
        }}
        title={`Stop project?`}
        description="This will terminate all running sessions in this project. This can't be undone."
        confirmLabel="Stop project"
        cancelLabel="Cancel"
        onConfirm={projectSwitcherPalette.confirmStopProject}
        isConfirmLoading={projectSwitcherPalette.isStoppingProject}
        variant="destructive"
      />

      <ErrorBoundary
        variant="component"
        componentName="ThemePalette"
        resetKeys={[Number(isThemePaletteOpen)]}
      >
        {shouldMountThemePalette && (
          <Suspense fallback={null}>
            <LazyThemePalette isOpen={isThemePaletteOpen} onClose={closeThemePalette} />
          </Suspense>
        )}
      </ErrorBoundary>

      <ErrorBoundary
        variant="component"
        componentName="ResumeSessionsPalette"
        resetKeys={[Number(isResumeSessionsPaletteOpen)]}
      >
        {shouldMountResumeSessionsPalette && (
          <Suspense fallback={null}>
            <LazyResumeSessionsPalette />
          </Suspense>
        )}
      </ErrorBoundary>

      <ErrorBoundary
        variant="component"
        componentName="LogLevelPalette"
        resetKeys={[Number(isLogLevelPaletteOpen)]}
      >
        {shouldMountLogLevelPalette && (
          <Suspense fallback={null}>
            <LazyLogLevelPalette isOpen={isLogLevelPaletteOpen} onClose={closeLogLevelPalette} />
          </Suspense>
        )}
      </ErrorBoundary>

      <ErrorBoundary
        variant="component"
        componentName="ActionPalette"
        resetKeys={[Number(actionPalette.isOpen)]}
      >
        {shouldMountActionPalette && (
          <Suspense fallback={null}>
            <LazyActionPalette
              isOpen={actionPalette.isOpen}
              query={actionPalette.query}
              results={actionPalette.results}
              totalResults={actionPalette.totalResults}
              selectedIndex={actionPalette.selectedIndex}
              isStale={actionPalette.isStale}
              pinnedCount={actionPalette.pinnedCount}
              close={actionPalette.close}
              setQuery={actionPalette.setQuery}
              setSelectedIndex={actionPalette.setSelectedIndex}
              selectPrevious={actionPalette.selectPrevious}
              selectNext={actionPalette.selectNext}
              executeAction={actionPalette.executeAction}
              confirmSelection={actionPalette.confirmSelection}
              pinAction={actionPalette.pinAction}
              unpinAction={actionPalette.unpinAction}
              hideAction={actionPalette.hideAction}
            />
          </Suspense>
        )}
      </ErrorBoundary>

      <ErrorBoundary
        variant="component"
        componentName="WorktreeOverviewModal"
        resetKeys={[Number(isWorktreeOverviewOpen)]}
      >
        {isWorktreeOverviewOpen && (
          <Suspense fallback={null}>
            <LazyWorktreeOverviewModal
              isOpen={isWorktreeOverviewOpen}
              onClose={closeWorktreeOverview}
              worktrees={worktrees}
              isLoading={isLoading}
              activeWorktreeId={activeWorktreeId}
              focusedWorktreeId={focusedWorktreeId}
              onSelectWorktree={selectWorktree}
              onCopyTree={overviewWorktreeActions.handleCopyTree}
              onOpenEditor={overviewWorktreeActions.handleOpenEditor}
              onSaveLayout={undefined}
              onLaunchAgent={overviewWorktreeActions.handleLaunchAgent}
              agentAvailability={availability}
              agentSettings={agentSettings}
              homeDir={homeDir}
            />
          </Suspense>
        )}
      </ErrorBoundary>

      <ErrorBoundary
        variant="component"
        componentName="CrossWorktreeDiff"
        resetKeys={[Number(crossDiffDialog.isOpen)]}
      >
        {shouldMountCrossDiffDialog && (
          <Suspense fallback={null}>
            <LazyCrossWorktreeDiff
              isOpen={crossDiffDialog.isOpen}
              onClose={closeCrossWorktreeDiff}
              initialWorktreeId={crossDiffDialog.initialWorktreeId}
            />
          </Suspense>
        )}
      </ErrorBoundary>

      <ErrorBoundary
        variant="component"
        componentName="SettingsDialog"
        resetKeys={[Number(isSettingsOpen)]}
      >
        {shouldMountSettings && (
          <Suspense fallback={null}>
            <LazySettingsDialog
              isOpen={isSettingsOpen}
              onClose={() => setIsSettingsOpen(false)}
              defaultTab={settingsTab}
              defaultSubtab={settingsSubtab}
              defaultSectionId={settingsSectionId}
              onSettingsChange={refreshSettings}
              projectId={currentProject?.id ?? null}
            />
          </Suspense>
        )}
      </ErrorBoundary>

      <ErrorBoundary
        variant="component"
        componentName="ShortcutReferenceDialog"
        resetKeys={[Number(isShortcutsOpen)]}
      >
        {shouldMountShortcutsDialog && (
          <Suspense fallback={null}>
            <LazyShortcutReferenceDialog
              isOpen={isShortcutsOpen}
              onClose={() => setIsShortcutsOpen(false)}
            />
          </Suspense>
        )}
      </ErrorBoundary>

      <ErrorBoundary
        variant="component"
        componentName="PluginManagerView"
        resetKeys={[Number(isPluginManagerOpen)]}
        onError={() => usePluginManagerStore.getState().close()}
      >
        {shouldMountPluginManager && (
          <Suspense fallback={null}>
            <LazyPluginManagerView
              deepLinkIntent={pluginDeepLink.intent}
              onDeepLinkConsumed={pluginDeepLink.clear}
            />
          </Suspense>
        )}
      </ErrorBoundary>

      <ErrorBoundary
        variant="component"
        componentName="TerminalInfoDialogHost"
        resetKeys={[terminalInfoResetKey]}
      >
        <TerminalInfoDialogHost />
      </ErrorBoundary>
      {isStateLoaded && (
        <ErrorBoundary
          variant="component"
          componentName="McpConfirmDialog"
          resetKeys={[mcpConfirmResetKey]}
        >
          <Suspense fallback={null}>
            <LazyMcpConfirmDialog />
          </Suspense>
        </ErrorBoundary>
      )}
      {isStateLoaded && (
        <ErrorBoundary
          variant="component"
          componentName="PluginConfirmDialog"
          resetKeys={[pluginConfirmResetKey]}
        >
          <Suspense fallback={null}>
            <LazyPluginConfirmDialog />
          </Suspense>
        </ErrorBoundary>
      )}
      {isStateLoaded && (
        <ErrorBoundary
          variant="component"
          componentName="PluginMcpConfirmDialog"
          resetKeys={[pluginMcpConfirmResetKey]}
        >
          <Suspense fallback={null}>
            <LazyPluginMcpConfirmDialog />
          </Suspense>
        </ErrorBoundary>
      )}
      {isStateLoaded && (
        <ErrorBoundary
          variant="component"
          componentName="PluginArchiveInstallConfirmDialog"
          resetKeys={[pluginArchiveInstallResetKey]}
        >
          <Suspense fallback={null}>
            <LazyPluginArchiveInstallConfirmDialog />
          </Suspense>
        </ErrorBoundary>
      )}
      {isStateLoaded && (
        <ErrorBoundary variant="component" componentName="PluginQuickPickDialog">
          <Suspense fallback={null}>
            <LazyPluginQuickPickDialog />
          </Suspense>
        </ErrorBoundary>
      )}
      {isStateLoaded && (
        <ErrorBoundary variant="component" componentName="PluginInputBoxDialog">
          <Suspense fallback={null}>
            <LazyPluginInputBoxDialog />
          </Suspense>
        </ErrorBoundary>
      )}
      {isStateLoaded && (
        <ErrorBoundary variant="component" componentName="PluginConfirmPromptDialog">
          <Suspense fallback={null}>
            <LazyPluginConfirmPromptDialog />
          </Suspense>
        </ErrorBoundary>
      )}
      {isStateLoaded && (
        <ErrorBoundary
          variant="component"
          componentName="PluginCapabilityConfirmDialog"
          resetKeys={[pluginCapabilityConfirmResetKey]}
        >
          <Suspense fallback={null}>
            <LazyPluginCapabilityConfirmDialog />
          </Suspense>
        </ErrorBoundary>
      )}
      {isStateLoaded && (
        <ErrorBoundary variant="component" componentName="PanelDialogHost">
          <Suspense fallback={null}>
            <LazyPanelDialogHost />
          </Suspense>
        </ErrorBoundary>
      )}

      <ErrorBoundary
        variant="component"
        componentName="GitInitDialog"
        resetKeys={[Number(gitInitDialogOpen)]}
      >
        {shouldMountGitInitDialog && effectiveGitInitPath && (
          <Suspense fallback={null}>
            <LazyGitInitDialog
              isOpen={gitInitDialogOpen}
              directoryPath={effectiveGitInitPath}
              onSuccess={handleGitInitSuccess}
              onCancel={closeGitInitDialog}
            />
          </Suspense>
        )}
      </ErrorBoundary>

      <ErrorBoundary
        variant="component"
        componentName="CreateProjectFolderDialog"
        resetKeys={[Number(createFolderDialogOpen)]}
      >
        {shouldMountCreateFolderDialog && (
          <Suspense fallback={null}>
            <LazyCreateProjectFolderDialog
              isOpen={createFolderDialogOpen}
              onClose={closeCreateFolderDialog}
            />
          </Suspense>
        )}
      </ErrorBoundary>

      <ErrorBoundary
        variant="component"
        componentName="CloneRepoDialog"
        resetKeys={[Number(cloneRepoDialogOpen)]}
      >
        {shouldMountCloneRepoDialog && (
          <Suspense fallback={null}>
            <LazyCloneRepoDialog
              isOpen={cloneRepoDialogOpen}
              onSuccess={handleCloneSuccess}
              onCancel={closeCloneRepoDialog}
            />
          </Suspense>
        )}
      </ErrorBoundary>

      <PanelTransitionOverlay />
      {isStateLoaded && (
        <ErrorBoundary
          variant="component"
          componentName="PanelLimitConfirmDialog"
          resetKeys={[panelLimitResetKey]}
        >
          <Suspense fallback={null}>
            <LazyPanelLimitConfirmDialog />
          </Suspense>
        </ErrorBoundary>
      )}

      {isStateLoaded && (
        <ErrorBoundary
          variant="component"
          componentName="DiagnosticsReviewDialogHost"
          resetKeys={[diagnosticsReviewResetKey]}
        >
          <Suspense fallback={null}>
            <LazyDiagnosticsReviewDialogHost />
          </Suspense>
        </ErrorBoundary>
      )}

      {isStateLoaded && (
        <ErrorBoundary
          variant="component"
          componentName="GitPushConfirmDialog"
          resetKeys={[gitPushResetKey]}
        >
          <Suspense fallback={null}>
            <LazyGitPushConfirmDialog />
          </Suspense>
        </ErrorBoundary>
      )}

      {isStateLoaded && (
        <ErrorBoundary
          variant="component"
          componentName="GitPullRebaseConfirmDialog"
          resetKeys={[gitPullRebaseResetKey]}
        >
          <Suspense fallback={null}>
            <LazyGitPullRebaseConfirmDialog />
          </Suspense>
        </ErrorBoundary>
      )}

      {isStateLoaded && (
        <ErrorBoundary
          variant="component"
          componentName="RecipeConflictDialog"
          resetKeys={[recipeConflictResetKey]}
        >
          <Suspense fallback={null}>
            <LazyRecipeConflictDialog />
          </Suspense>
        </ErrorBoundary>
      )}

      <Toaster />
      <ShortcutHint />
      <ReEntrySummary state={reEntrySummary} />
      {/* Listener hooks deferred out of the first commit flush — mount once
          hydration settles so their effects stay off the first effect flush (#9769). */}
      {isStateLoaded && <PostHydrationListeners />}
      {isStateLoaded && (
        <ErrorBoundary
          variant="component"
          componentName="OnboardingFlow"
          resetKeys={[Number(isStateLoaded)]}
        >
          <Suspense fallback={null}>
            <LazyOnboardingFlow
              availability={availability}
              onRefreshSettings={refreshSettings}
              onComplete={gettingStarted.notifyOnboardingComplete}
            />
          </Suspense>
        </ErrorBoundary>
      )}
      {currentProject !== null && gettingStarted.visible && gettingStarted.checklist && (
        <ErrorBoundary
          variant="component"
          componentName="GettingStartedChecklist"
          resetKeys={[Number(gettingStarted.visible)]}
        >
          <Suspense fallback={null}>
            <LazyGettingStartedChecklist
              checklist={gettingStarted.checklist}
              collapsed={gettingStarted.collapsed}
              onDismiss={gettingStarted.dismiss}
              onToggleCollapse={gettingStarted.toggleCollapse}
              onMarkItem={gettingStarted.markItem}
            />
          </Suspense>
        </ErrorBoundary>
      )}
      <ErrorBoundary
        variant="component"
        componentName="CelebrationConfetti"
        resetKeys={[Number(gettingStarted.showCelebration)]}
      >
        {gettingStarted.showCelebration && (
          <Suspense fallback={null}>
            <LazyCelebrationConfetti />
          </Suspense>
        )}
      </ErrorBoundary>
    </>
  );
}
