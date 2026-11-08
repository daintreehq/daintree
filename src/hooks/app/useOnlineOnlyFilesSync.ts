import { useEffect, useRef } from "react";
import { notify } from "@/lib/notify";
import { isRemoteWindow } from "@/hooks/useHostPlatform";
import { actionService } from "@/services/ActionService";
import { onHostResync } from "@/store/hostResyncSignal";
import { selectOnlineOnlyOutstanding, useOnlineOnlyFilesStore } from "@/store/onlineOnlyFilesStore";
import { useProjectStore } from "@/store/projectStore";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";
import { getOnlineOnlyFilesInboxCopy } from "@/utils/onlineOnlyFilesCopy";
import type { Project } from "@shared/types";
import { gitStatusWaitsForDownload } from "@shared/utils/onlineOnlyFiles";

/**
 * The view's own seeded workspace rather than `currentProject`, which is broadcast
 * to every view and would move a cached one off the project it shows. It doesn't
 * wait for the project list, or the path-based warning could get in first: Main
 * answers `watch` from the sender, and null for anything that isn't a project.
 */
function selectWatchedWorkspaceId(state: {
  projects: readonly Project[];
  currentProject: Project | null;
}): string | null {
  const viewId = getViewWorkspaceId();
  if (viewId === null) return state.currentProject?.id ?? null;
  return state.projects.find((project) => project.id === viewId)?.status === "closed"
    ? null
    : viewId;
}

/**
 * Holds this view's project under watch and keeps the store current. Main decides
 * whether any of this applies, so a project it doesn't apply to costs one `watch`
 * answering null.
 */
export function useOnlineOnlyFilesSync(): void {
  const projectId = useProjectStore(selectWatchedWorkspaceId);

  useEffect(() => {
    const store = useOnlineOnlyFilesStore.getState();
    const api = window.electron?.onlineOnlyFiles;
    if (projectId === null || !api) {
      store.reset();
      return;
    }

    let live = true;
    const ask = () => {
      store.ask();
      api.watch().then(
        (files) => {
          if (live) store.answer(files);
        },
        () => {
          // Not knowing has to look like today, not like a wait with no end.
          if (live) store.answer(null);
        }
      );
    };

    const offChanged = api.onChanged((files) => {
      if (live && files.projectId === projectId) store.answer(files);
    });
    // A link that dropped took this view's hold with it.
    const offResync = onHostResync(ask);
    ask();

    return () => {
      live = false;
      offChanged();
      offResync();
      store.reset();
      void api.unwatch().catch(() => {});
    };
  }, [projectId]);

  const outstanding = useOnlineOnlyFilesStore(selectOnlineOnlyOutstanding);
  const service = useOnlineOnlyFilesStore((s) => s.files?.service ?? null);
  const inboxed = useRef(false);
  useEffect(() => {
    if (!outstanding) {
      inboxed.current = false;
      return;
    }
    if (inboxed.current || service === null) return;
    inboxed.current = true;
    const copy = getOnlineOnlyFilesInboxCopy(service, isRemoteWindow());
    // The banner is the live surface. This keeps the notice findable when a
    // higher-priority banner holds the slot, or after the user dismisses it.
    notify({
      type: "info",
      priority: "low",
      title: copy.title,
      message: copy.description,
      supersedeKey: `online-only-files:${projectId}`,
      countable: false,
      context: { eventKind: "host" },
    });
  }, [outstanding, service, projectId]);

  // A load that failed on `.git` placeholders has no monitor left to resume, and
  // the promise is that nobody has to reopen the project.
  const gitWaits = useOnlineOnlyFilesStore((s) => gitStatusWaitsForDownload(s.files));
  const gitWaited = useRef(false);
  useEffect(() => {
    const released = gitWaited.current && !gitWaits;
    gitWaited.current = gitWaits;
    // Disabled unless a load really did fail, so this is a no-op otherwise.
    if (released && projectId !== null) void actionService.dispatch("worktree.retryProjectLoad");
  }, [gitWaits, projectId]);
}
