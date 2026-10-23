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

/**
 * Keeps `devPreviewOfferStore` current for this view's project (#14069). Mount
 * once per view.
 *
 * A preview in use, a configured command, the app-wide switch and a toolbar
 * pin all keep the dev preview offered whatever the project's files say.
 * Main re-reads the files when its root changes in git; coming back to a view
 * reads them again too, which is what reaches a folder that isn't a repository.
 */
export function useDevPreviewOfferSync(): void {
  const viewWorkspaceId = getViewWorkspaceId();
  const projectId = useProjectStore((s) => selectViewProject(viewWorkspaceId, s)?.id ?? null);
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
        if (!observable) return;
        const presentation = useProjectPresentationStore.getState();
        if (presentation.loaded) presentation.refresh();
      }),
    []
  );
}
