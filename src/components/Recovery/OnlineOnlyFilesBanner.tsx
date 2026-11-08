import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { hostFileManagerRevealLabel, isRemoteWindow } from "@/hooks/useHostPlatform";
import { systemClient } from "@/clients/systemClient";
import { logError } from "@/utils/logger";
import { useGlobalBannerDismissalStore } from "@/store/globalBannerDismissalStore";
import { useOnlineOnlyFilesStore } from "@/store/onlineOnlyFilesStore";
import { useProjectStore } from "@/store/projectStore";
import { selectViewProject } from "@/store/viewWorkspace";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";
import { getOnlineOnlyFilesCopy } from "@/utils/onlineOnlyFilesCopy";

export function OnlineOnlyFilesBanner() {
  const files = useOnlineOnlyFilesStore((s) => s.files);
  const dismiss = useGlobalBannerDismissalStore((s) => s.dismiss);
  const projectPath = useProjectStore((s) => selectViewProject(getViewWorkspaceId(), s)?.path);

  const remote = isRemoteWindow();
  const copy = files ? getOnlineOnlyFilesCopy(files, remote) : null;
  if (!copy) return null;

  return (
    <InlineStatusBanner
      title={copy.title}
      description={copy.description}
      severity="info"
      role="status"
      // The count changes every few seconds while files arrive, and each change
      // would be read out.
      ariaLive="off"
      onClose={() => dismiss("online-only-files")}
      closeAriaLabel="Dismiss online-only files notice"
      actions={
        // The provider's control is on the folder's own menu, so take them to it.
        // A remote window's Finder isn't the one that can see this path.
        projectPath && !remote
          ? [
              {
                id: "reveal",
                label: hostFileManagerRevealLabel(),
                variant: "primary",
                onClick: () => {
                  systemClient.showItemInFolder(projectPath).catch((error: unknown) => {
                    logError("Failed to show project folder", error);
                  });
                },
              },
            ]
          : undefined
      }
    />
  );
}
