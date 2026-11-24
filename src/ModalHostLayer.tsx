import { Suspense, type ReactNode } from "react";
import { TourHost } from "@/components/Tour/TourHost";
import type { Project, ProjectCreationIdentity } from "@shared/types";
import type { ProjectOpenDisposition } from "@shared/types/windowOpen";
import type { ProjectCloneStartRequest } from "@shared/types/ipc/projectClone";
import type { AgentSessionRecord } from "@shared/types/ipc/agentSessionHistory";
import type { UseProjectSwitcherPaletteReturn } from "./hooks/useProjectSwitcherPalette";
import type { GettingStartedChecklistState } from "./hooks/app/useGettingStartedChecklist";
import type { ReEntrySummaryState } from "./hooks/useReEntrySummary";
import type { UseAgentLauncherReturn } from "./hooks/useAgentLauncher";
import type { PluginDeepLinkState } from "./hooks/app";
import type { SettingsTab } from "./components/Settings";
import type { NonGitFolderStep } from "./components/Project/NonGitFolderDialog";
import type { PluginUiPromptParams } from "@shared/types/pluginUiPrompt";
import { afterCatch, ErrorBoundary } from "./components/ErrorBoundary";
import { StopProjectConfirmDialog } from "./components/Project/StopProjectConfirmDialog";
import { ProjectSwitcherModalLayer } from "./components/Project/ProjectSwitcherModalLayer";
import { useProjectSleepConfirmStore } from "@/store/projectSleepConfirmStore";
import { useWorktreeResourceTeardownConfirmStore } from "@/store/worktreeResourceTeardownConfirmStore";
import { cancelRecipeRunConfirmations } from "@/store/recipeRunConfirmStore";
import {
  cancelScheduleRunConfirmations,
  useScheduleRunConfirmStore,
} from "@/store/scheduleRunConfirmStore";
import {
  declineFailedLayoutApplyConfirmation,
  useLayoutApplyConfirmStore,
} from "@/store/layoutApplyConfirmStore";
import {
  declineGlobalAssistantReplacement,
  useGlobalAssistantReplaceConfirmStore,
} from "@/store/globalAssistantReplaceConfirmStore";
import { dismissFailedUiPrompt, usePluginPromptStore } from "@/store/pluginPromptStore";
import { declineFailedMcpConfirmation } from "@/store/mcpConfirmStore";
import { usePluginConfirmStore } from "@/store/pluginConfirmStore";
import { usePluginMcpConfirmStore } from "@/store/pluginMcpConfirmStore";
import { usePluginCapabilityConfirmStore } from "@/store/pluginCapabilityConfirmStore";
import { usePluginArchiveInstallStore } from "@/store/pluginArchiveInstallStore";
import { declineFailedPanelLimitConfirmation } from "@/store/panelLimitStore";
import { declineFailedGitPushConfirmation } from "@/store/gitPushConfirmStore";
import { declineFailedGitPullRebaseConfirmation } from "@/store/gitPullRebaseConfirmStore";
import { declineFailedFileMutationConfirmation } from "@/store/fileMutationConfirmStore";
import { declineFailedGitWorktreeOperationConfirmation } from "@/store/gitWorktreeOperationConfirmStore";
import { useGitForcePushStore } from "@/store/gitForcePushStore";
import { cancelFailedRecipeConflict } from "@/store/recipeConflictStore";
import { usePilotStore } from "@/store/pilotStore";
import { useCanopyOfferShown } from "@/hooks/app/useCanopyOfferShown";
import { useScratchStore } from "@/store/scratchStore";
import { Toaster } from "./components/ui/toaster";
import { ShortcutHint } from "./components/ui/ShortcutHint";
import { ReEntrySummary } from "./components/ui/ReEntrySummary";
import { TerminalInfoDialogHost } from "./components/Terminal/TerminalInfoDialogHost";
import { PostHydrationListeners } from "./components/PostHydrationListeners";
import { HostFilePickerMount } from "./components/HostFilePicker/HostFilePickerMount";
import { HostSwitchMount } from "./components/HostSwitch/HostSwitchMount";
import { HostsOverviewMount } from "./components/Hosts/Overview/HostsOverviewMount";
import { MaximizeFlights, PanelTransitionOverlay } from "./components/Panel";
import { usePluginManagerStore } from "./store";
import {
  LazyPilotView,
  LazyCanopyOffer,
  LazyCrossWorktreeDiff,
  LazySettingsDialog,
  LazyShortcutReferenceDialog,
  LazyPluginManagerView,
  LazyMcpConfirmDialog,
  LazyPluginConfirmDialog,
  LazyLayoutApplyConfirmDialog,
  LazyRecipeRunConfirmDialog,
  LazyScheduleRunConfirmDialog,
  LazyGlobalAssistantReplaceConfirmDialog,
  LazyPluginArchiveInstallConfirmDialog,
  LazyPluginMcpConfirmDialog,
  LazyPluginQuickPickDialog,
  LazyPluginSendToAgentDialog,
  LazyPluginInputBoxDialog,
  LazyPluginConfirmPromptDialog,
  LazyPluginRunRecipeDialog,
  LazyPluginCapabilityConfirmDialog,
  LazyPanelDialogHost,
  LazyGitInitDialog,
  LazyCreateProjectFolderDialog,
  LazyCloneRepoDialog,
  LazyPanelLimitConfirmDialog,
  LazyDiagnosticsReviewDialogHost,
  LazyGitPushConfirmDialog,
  LazyGitPullRebaseConfirmDialog,
  LazyFileMutationConfirmDialog,
  LazyGitWorktreeOperationConfirmDialog,
  LazyGitForcePushConfirmDialog,
  LazyProjectSleepConfirmDialog,
  LazyWorktreeResourceTeardownConfirmDialog,
  LazyRecipeConflictDialog,
  LazyOnboardingFlow,
  LazyGettingStartedChecklist,
  LazyProjectGroupDialogs,
} from "./lazyPanels";
import { useProjectGroupsStore } from "./store/projectGroupsStore";
import {
  QuickSwitcherHost,
  SendToAgentPaletteHost,
  WorktreePaletteHost,
  QuickCreatePaletteHost,
  PanelPaletteHost,
  ThemePaletteHost,
  ResumeSessionsPaletteHost,
  RecentDictationsPaletteHost,
  LogLevelPaletteHost,
  ActionPaletteHost,
  WorktreeOverviewHost,
} from "./PaletteHosts";

interface ModalHostLayerProps {
  resumeSession: (session: AgentSessionRecord) => Promise<void>;
  handleLaunchAgent: (type: string) => void | Promise<void>;
  defaultTerminalCwd: string | undefined;
  activeWorktreeId: string | null;
  isProjectSwitcherModalOpen: boolean;
  projectSwitcherPalette: UseProjectSwitcherPaletteReturn;
  isWorktreeOverviewOpen: boolean;
  closeWorktreeOverview: () => void;
  selectWorktree: (id: string, options?: { source?: "user" | "focus" }) => void;
  availability: UseAgentLauncherReturn["availability"];
  crossDiffDialog: { isOpen: boolean; initialWorktreeId: string | null };
  shouldMountCrossDiffDialog: boolean;
  closeCrossWorktreeDiff: () => void;
  isSettingsOpen: boolean;
  shouldMountSettings: boolean;
  setIsSettingsOpen: (open: boolean) => void;
  settingsTab: SettingsTab | undefined;
  settingsSubtab: string | undefined;
  settingsSectionId: string | undefined;
  /** Bumped by every targeted open, so a repeat of the same target still navigates. */
  settingsNavNonce: number;
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
  recipeRunConfirmResetKey: string;
  panelLimitResetKey: number;
  diagnosticsReviewResetKey: number;
  gitPushResetKey: number;
  gitPullRebaseResetKey: number;
  fileMutationResetKey: number;
  gitWorktreeOperationResetKey: number;
  gitForcePushResetKey: number;
  projectSleepResetKey: number;
  recipeConflictResetKey: number;
  gitInitDialogOpen: boolean;
  shouldMountGitInitDialog: boolean;
  effectiveGitInitPath: string | null;
  effectiveGitInitIdentity: ProjectCreationIdentity | null;
  effectiveGitInitGroupId: string | null;
  gitInitDialogStep: NonGitFolderStep;
  handleGitInitSuccess: (
    identity?: ProjectCreationIdentity,
    groupId?: string | null
  ) => Promise<void>;
  openWithoutGit: () => Promise<void>;
  closeGitInitDialog: () => void;
  createFolderDialogOpen: boolean;
  shouldMountCreateFolderDialog: boolean;
  closeCreateFolderDialog: () => void;
  cloneRepoDialogOpen: boolean;
  shouldMountCloneRepoDialog: boolean;
  handleCloneSuccess: (
    clonedPath: string,
    identity?: ProjectCreationIdentity,
    options?: { disposition?: ProjectOpenDisposition; groupId?: string }
  ) => Promise<void>;
  startBackgroundClone: (
    request: ProjectCloneStartRequest,
    options?: { disposition?: ProjectOpenDisposition }
  ) => Promise<void>;
  closeCloneRepoDialog: () => void;
  reEntrySummary: ReEntrySummaryState;
  gettingStarted: GettingStartedChecklistState;
}

/**
 * One plugin prompt dialog's boundary. Keyed on the prompt in front only while
 * it is this dialog's kind, so a dialog whose chunk failed retries on its own
 * next prompt and dismisses only that one, never a prompt another dialog owns.
 */
function PluginPromptHost({
  kind,
  componentName,
  children,
}: {
  kind: PluginUiPromptParams["kind"];
  componentName: string;
  children: ReactNode;
}) {
  const promptId = usePluginPromptStore((s) =>
    s.current?.params.kind === kind ? s.current.promptId : ""
  );
  return (
    <ErrorBoundary
      variant="component"
      componentName={componentName}
      resetKeys={[promptId]}
      onError={afterCatch(() => dismissFailedUiPrompt(promptId))}
    >
      <Suspense fallback={null}>{children}</Suspense>
    </ErrorBoundary>
  );
}

/**
 * Every always-mounted or conditionally-lazy palette, dialog, and overlay
 * host in the app shell — one `ErrorBoundary` + `Suspense` pair per lazy
 * child, matching the original inline structure 1:1 so each host's fault
 * isolation and reset-key behavior is unchanged by the move out of AppInner.
 *
 * A host whose dialog answers a waiting request also settles, on failure, the
 * request its reset key names, so a dialog that can't load or render declines
 * its caller, and the queue behind it moves on, instead of waiting for good.
 */
export function ModalHostLayer({
  resumeSession,
  handleLaunchAgent,
  defaultTerminalCwd,
  activeWorktreeId,
  isProjectSwitcherModalOpen,
  projectSwitcherPalette,
  isWorktreeOverviewOpen,
  closeWorktreeOverview,
  selectWorktree,
  availability,
  crossDiffDialog,
  shouldMountCrossDiffDialog,
  closeCrossWorktreeDiff,
  isSettingsOpen,
  shouldMountSettings,
  setIsSettingsOpen,
  settingsTab,
  settingsSubtab,
  settingsSectionId,
  settingsNavNonce,
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
  recipeRunConfirmResetKey,
  panelLimitResetKey,
  diagnosticsReviewResetKey,
  gitPushResetKey,
  gitPullRebaseResetKey,
  fileMutationResetKey,
  gitWorktreeOperationResetKey,
  gitForcePushResetKey,
  projectSleepResetKey,
  recipeConflictResetKey,
  gitInitDialogOpen,
  shouldMountGitInitDialog,
  effectiveGitInitPath,
  effectiveGitInitIdentity,
  effectiveGitInitGroupId,
  gitInitDialogStep,
  handleGitInitSuccess,
  openWithoutGit,
  closeGitInitDialog,
  createFolderDialogOpen,
  shouldMountCreateFolderDialog,
  closeCreateFolderDialog,
  cloneRepoDialogOpen,
  shouldMountCloneRepoDialog,
  handleCloneSuccess,
  startBackgroundClone,
  closeCloneRepoDialog,
  reEntrySummary,
  gettingStarted,
}: ModalHostLayerProps) {
  // Read from the store rather than props: Pilot is opened from the action
  // registry, a keybinding and the project switcher, none of which has a prop
  // path into this layer.
  const isPilotOpen = usePilotStore((s) => s.isOpen);
  const hasProjectGroupDialog = useProjectGroupsStore((s) => s.dialog !== null);
  const isCanopyOfferShown = useCanopyOfferShown();
  const hasScratch = useScratchStore((s) => s.currentScratch !== null);
  // Each Run now question retries a dialog that failed, so none waits on a fallback.
  const scheduleRunConfirmKey = useScheduleRunConfirmStore((s) => s.current?.requestId ?? "");
  const resourceTeardownConfirmKey = useWorktreeResourceTeardownConfirmStore((s) => s.requestSeq);
  const layoutApplyConfirmKey = useLayoutApplyConfirmStore((s) => s.current?.requestId ?? "");
  // Mounted only once a plugin has asked, so a view no plugin asks loads nothing.
  const globalReplaceRequestSeq = useGlobalAssistantReplaceConfirmStore((s) => s.requestSeq);

  return (
    <>
      <QuickSwitcherHost />
      <SendToAgentPaletteHost />
      <WorktreePaletteHost />
      <QuickCreatePaletteHost />
      <PanelPaletteHost
        resumeSession={resumeSession}
        handleLaunchAgent={handleLaunchAgent}
        defaultTerminalCwd={defaultTerminalCwd}
        activeWorktreeId={activeWorktreeId}
      />
      <ProjectSwitcherModalLayer
        isProjectSwitcherModalOpen={isProjectSwitcherModalOpen}
        projectSwitcherPalette={projectSwitcherPalette}
      />
      {/*
        Mounted here, once per view, rather than inside the switcher: the
        switcher renders in more than one place, and its menus open these from
        whichever copy the user is in. Loaded only once one is asked for.
      */}
      {hasProjectGroupDialog && (
        <Suspense fallback={null}>
          <LazyProjectGroupDialogs />
        </Suspense>
      )}
      <StopProjectConfirmDialog
        projectId={projectSwitcherPalette.stopConfirmProjectId}
        isStopping={projectSwitcherPalette.isStoppingProject}
        onClose={() => projectSwitcherPalette.setStopConfirmProjectId(null)}
        onConfirm={projectSwitcherPalette.confirmStopProject}
      />

      <ThemePaletteHost />

      <ResumeSessionsPaletteHost />

      <RecentDictationsPaletteHost />

      <LogLevelPaletteHost />

      <ActionPaletteHost
        onSearchProjects={(query) => projectSwitcherPalette.open("modal", { query })}
      />

      <WorktreeOverviewHost
        isOpen={isWorktreeOverviewOpen}
        onClose={closeWorktreeOverview}
        activeWorktreeId={activeWorktreeId}
        onSelectWorktree={selectWorktree}
      />

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
              navNonce={settingsNavNonce}
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
          onError={afterCatch(() => declineFailedMcpConfirmation(mcpConfirmResetKey))}
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
          onError={afterCatch(() => usePluginConfirmStore.getState().drop(pluginConfirmResetKey))}
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
          onError={afterCatch(() =>
            usePluginMcpConfirmStore.getState().drop(pluginMcpConfirmResetKey)
          )}
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
          onError={afterCatch(() =>
            usePluginArchiveInstallStore.getState().drop(pluginArchiveInstallResetKey)
          )}
        >
          <Suspense fallback={null}>
            <LazyPluginArchiveInstallConfirmDialog />
          </Suspense>
        </ErrorBoundary>
      )}
      {isStateLoaded && (
        <PluginPromptHost kind="quickPick" componentName="PluginQuickPickDialog">
          <LazyPluginQuickPickDialog />
        </PluginPromptHost>
      )}
      {isStateLoaded && (
        <PluginPromptHost kind="sendToAgent" componentName="PluginSendToAgentDialog">
          <LazyPluginSendToAgentDialog />
        </PluginPromptHost>
      )}
      {isStateLoaded && (
        <PluginPromptHost kind="inputBox" componentName="PluginInputBoxDialog">
          <LazyPluginInputBoxDialog />
        </PluginPromptHost>
      )}
      {isStateLoaded && (
        <ErrorBoundary
          variant="component"
          componentName="LayoutApplyConfirmDialog"
          resetKeys={[layoutApplyConfirmKey]}
          onError={afterCatch(() => declineFailedLayoutApplyConfirmation(layoutApplyConfirmKey))}
        >
          <Suspense fallback={null}>
            <LazyLayoutApplyConfirmDialog />
          </Suspense>
        </ErrorBoundary>
      )}
      {isStateLoaded && (
        <ErrorBoundary
          variant="component"
          componentName="RecipeRunConfirmDialog"
          resetKeys={[recipeRunConfirmResetKey]}
          // A held run waits on this dialog; one that can't render must not
          // leave it, and the runner's guard, pending for good.
          onError={() => cancelRecipeRunConfirmations()}
        >
          <Suspense fallback={null}>
            <LazyRecipeRunConfirmDialog />
          </Suspense>
        </ErrorBoundary>
      )}
      {isStateLoaded && (
        <ErrorBoundary
          variant="component"
          componentName="ScheduleRunConfirmDialog"
          resetKeys={[scheduleRunConfirmKey]}
          // A Run now waits on this dialog; one that can't render backs it out.
          onError={() => cancelScheduleRunConfirmations()}
        >
          <Suspense fallback={null}>
            <LazyScheduleRunConfirmDialog />
          </Suspense>
        </ErrorBoundary>
      )}
      {isStateLoaded && globalReplaceRequestSeq > 0 && (
        <ErrorBoundary
          variant="component"
          componentName="GlobalAssistantReplaceConfirmDialog"
          resetKeys={[globalReplaceRequestSeq]}
          // A hand-off nobody can be asked about replaces nothing.
          onError={() => declineGlobalAssistantReplacement()}
        >
          <Suspense fallback={null}>
            <LazyGlobalAssistantReplaceConfirmDialog />
          </Suspense>
        </ErrorBoundary>
      )}
      {isStateLoaded && (
        <PluginPromptHost kind="confirm" componentName="PluginConfirmPromptDialog">
          <LazyPluginConfirmPromptDialog />
        </PluginPromptHost>
      )}
      {isStateLoaded && (
        <PluginPromptHost kind="runRecipe" componentName="PluginRunRecipeDialog">
          <LazyPluginRunRecipeDialog />
        </PluginPromptHost>
      )}
      {isStateLoaded && (
        <ErrorBoundary
          variant="component"
          componentName="PluginCapabilityConfirmDialog"
          resetKeys={[pluginCapabilityConfirmResetKey]}
          onError={afterCatch(() =>
            usePluginCapabilityConfirmStore.getState().drop(pluginCapabilityConfirmResetKey)
          )}
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
        componentName="NonGitFolderDialog"
        resetKeys={[Number(gitInitDialogOpen)]}
      >
        {shouldMountGitInitDialog && effectiveGitInitPath && (
          <Suspense fallback={null}>
            <LazyGitInitDialog
              isOpen={gitInitDialogOpen}
              directoryPath={effectiveGitInitPath}
              initialStep={gitInitDialogStep}
              initialIdentity={effectiveGitInitIdentity}
              initialGroupId={effectiveGitInitGroupId}
              onOpenWithoutGit={openWithoutGit}
              onInitSuccess={handleGitInitSuccess}
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
              onStartBackground={startBackgroundClone}
              onCancel={closeCloneRepoDialog}
            />
          </Suspense>
        )}
      </ErrorBoundary>

      <PanelTransitionOverlay />
      <MaximizeFlights />
      {isStateLoaded && (
        <ErrorBoundary
          variant="component"
          componentName="PanelLimitConfirmDialog"
          resetKeys={[panelLimitResetKey]}
          onError={() => declineFailedPanelLimitConfirmation(panelLimitResetKey)}
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

      {isStateLoaded && <HostFilePickerMount />}
      {isStateLoaded && <HostSwitchMount />}
      {isStateLoaded && <HostsOverviewMount />}

      {isStateLoaded && (
        <ErrorBoundary
          variant="component"
          componentName="GitPushConfirmDialog"
          resetKeys={[gitPushResetKey]}
          onError={() => declineFailedGitPushConfirmation(gitPushResetKey)}
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
          onError={() => declineFailedGitPullRebaseConfirmation(gitPullRebaseResetKey)}
        >
          <Suspense fallback={null}>
            <LazyGitPullRebaseConfirmDialog />
          </Suspense>
        </ErrorBoundary>
      )}

      {isStateLoaded && (
        <ErrorBoundary
          variant="component"
          componentName="FileMutationConfirmDialog"
          resetKeys={[fileMutationResetKey]}
          onError={() => declineFailedFileMutationConfirmation(fileMutationResetKey)}
        >
          <Suspense fallback={null}>
            <LazyFileMutationConfirmDialog />
          </Suspense>
        </ErrorBoundary>
      )}

      {isStateLoaded && (
        <ErrorBoundary
          variant="component"
          componentName="GitWorktreeOperationConfirmDialog"
          resetKeys={[gitWorktreeOperationResetKey]}
          onError={() =>
            declineFailedGitWorktreeOperationConfirmation(gitWorktreeOperationResetKey)
          }
        >
          <Suspense fallback={null}>
            <LazyGitWorktreeOperationConfirmDialog />
          </Suspense>
        </ErrorBoundary>
      )}

      {isStateLoaded && (
        <ErrorBoundary
          variant="component"
          componentName="GitForcePushConfirmDialog"
          resetKeys={[gitForcePushResetKey]}
          onError={() =>
            useGitForcePushStore.getState().resolveConfirmation(gitForcePushResetKey, false)
          }
        >
          <Suspense fallback={null}>
            <LazyGitForcePushConfirmDialog />
          </Suspense>
        </ErrorBoundary>
      )}

      {isStateLoaded && (
        <ErrorBoundary
          variant="component"
          componentName="ProjectSleepConfirmDialog"
          resetKeys={[projectSleepResetKey]}
          // A failed lazy import never reaches the dialog's own boundary; settle
          // the request the action is awaiting rather than leave it to hang.
          onError={() => useProjectSleepConfirmStore.getState().resolveConfirmation(false)}
        >
          <Suspense fallback={null}>
            <LazyProjectSleepConfirmDialog />
          </Suspense>
        </ErrorBoundary>
      )}

      {isStateLoaded && (
        <ErrorBoundary
          variant="component"
          componentName="WorktreeResourceTeardownConfirmDialog"
          resetKeys={[resourceTeardownConfirmKey]}
          // A failed lazy import never reaches the dialog's own boundary; settle
          // the request the action is awaiting rather than leave it to hang.
          onError={() =>
            useWorktreeResourceTeardownConfirmStore.getState().resolveConfirmation(false)
          }
        >
          <Suspense fallback={null}>
            <LazyWorktreeResourceTeardownConfirmDialog />
          </Suspense>
        </ErrorBoundary>
      )}

      {isStateLoaded && (
        <ErrorBoundary
          variant="component"
          componentName="RecipeConflictDialog"
          resetKeys={[recipeConflictResetKey]}
          onError={() => cancelFailedRecipeConflict(recipeConflictResetKey)}
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
              hasWorkspace={currentProject !== null || hasScratch}
              onRefreshSettings={refreshSettings}
              onComplete={gettingStarted.notifyOnboardingComplete}
            />
          </Suspense>
        </ErrorBoundary>
      )}
      {isStateLoaded && <TourHost />}
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
        componentName="PilotView"
        resetKeys={[Number(isPilotOpen)]}
      >
        {isPilotOpen && (
          <Suspense fallback={null}>
            <LazyPilotView />
          </Suspense>
        )}
      </ErrorBoundary>
      <ErrorBoundary
        variant="component"
        componentName="CanopyOffer"
        resetKeys={[Number(isCanopyOfferShown)]}
      >
        {isCanopyOfferShown && (
          <Suspense fallback={null}>
            <LazyCanopyOffer />
          </Suspense>
        )}
      </ErrorBoundary>
    </>
  );
}
