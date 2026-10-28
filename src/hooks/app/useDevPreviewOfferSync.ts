import { useEffect } from "react";
import { usePanelStore } from "@/store/panelStore";
import { useProjectStore } from "@/store/projectStore";
import { useProjectPresentationStore } from "@/store/projectPresentationStore";
import { useProjectSettingsStore } from "@/store/projectSettingsStore";
import { useToolbarPreferencesStore } from "@/store/toolbarPreferencesStore";
import { useWorktreeDevServerStore } from "@/store/worktreeDevServerStore";
import { devPreviewOfferReason, useDevPreviewOfferStore } from "@/store/devPreviewOfferStore";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";
import { selectViewProject } from "@/store/viewWorkspace";
import { isLiveDevServerStatus } from "@/lib/worktreeFilters";
import { subscribeProjectViewObservability } from "@/lib/viewCacheState";
import { useSharedPollTick } from "@/hooks/useSharedPollTick";

/**
 * How often a folder that isn't a repository is read again while it doesn't
 * look like a web project. Main hears about a repository's files through its
 * worktree updates; a plain folder has none, so scaffolding one while it is on
 * screen would otherwise go unseen until the view is left and come back to.
 */
const PLAIN_FOLDER_RECHECK_MS = 20_000;

function readFilesAgain(): void {
  const presentation = useProjectPresentationStore.getState();
  // A view whose first read gave up gets another try rather than a refresh it
  // would skip: `refresh` re-reads, `ensureLoaded` reads only what never loaded.
  if (presentation.loaded) presentation.refresh();
  else presentation.ensureLoaded();
}

/**
 * Keeps `devPreviewOfferStore` current for this view's project (#14069). Mount
 * once per view.
 *
 * A preview in use, a configured command, the app-wide switch and a toolbar
 * pin all keep the dev preview offered whatever the project's files say.
 * Main re-reads the files when its root changes in git; coming back to a view
 * reads them again too, and a plain folder is re-read while it is on screen.
 */
export function useDevPreviewOfferSync(): void {
  const viewWorkspaceId = getViewWorkspaceId();
  const projectId = useProjectStore((s) => selectViewProject(viewWorkspaceId, s)?.id ?? null);
  const plainFolder = useProjectStore(
    (s) => selectViewProject(viewWorkspaceId, s)?.gitBacked === false
  );
  const webProject = useProjectPresentationStore((s) =>
    projectId !== null && s.loaded && s.projectId === projectId ? s.webProject : null
  );
  const alwaysShow = useToolbarPreferencesStore((s) => s.launcher.alwaysShowDevServer);
  const pinned = useToolbarPreferencesStore((s) => s.layout.pinnedButtons["dev-server"] === true);
  // Trash is on its way out, so a preview there no longer counts as open.
  const previewOpen = usePanelStore((s) =>
    s.panelIds.some((id) => {
      const panel = s.panelsById[id];
      return panel?.kind === "dev-preview" && panel.location !== "trash";
    })
  );
  const serverLive = useWorktreeDevServerStore((s) =>
    Object.values(s.sessionsByWorktreeId).some(
      (session) => session.projectId === projectId && isLiveDevServerStatus(session.status)
    )
  );
  const commandConfigured = useProjectSettingsStore(
    (s) =>
      projectId !== null &&
      s.projectId === projectId &&
      (s.settings?.devServerCommand?.trim() ?? "") !== ""
  );
  const settingsProjectId = useProjectSettingsStore((s) => s.projectId);
  const settingsLoading = useProjectSettingsStore((s) => s.isLoading);
  const loadSettings = useProjectSettingsStore((s) => s.loadSettings);

  const reason = devPreviewOfferReason({
    alwaysShow,
    pinned,
    inUse: previewOpen || serverLive,
    commandConfigured,
    webProject,
  });

  useEffect(() => {
    useDevPreviewOfferStore.setState({ reason });
  }, [reason]);

  // The sidebar usually loads these already; a view without one still needs
  // to know whether a command is set.
  useEffect(() => {
    if (projectId !== null && settingsProjectId !== projectId && !settingsLoading) {
      void loadSettings(projectId);
    }
  }, [projectId, settingsProjectId, settingsLoading, loadSettings]);

  useEffect(
    () =>
      subscribeProjectViewObservability((observable) => {
        if (observable) readFilesAgain();
      }),
    []
  );

  useSharedPollTick(readFilesAgain, PLAIN_FOLDER_RECHECK_MS, plainFolder && reason === null);
}
