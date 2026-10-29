import { logWarn } from "@/utils/logger";

export interface DevPreviewResumeRequest {
  worktreeId: string;
  panelIds: ReadonlySet<string>;
}

type DevPreviewResumeListener = (request: DevPreviewResumeRequest) => void | Promise<unknown>;

const listeners = new Set<DevPreviewResumeListener>();

/**
 * Called when dev servers this view stopped for a worktree delete should run
 * again because the delete was abandoned and the worktree is still there
 * (#15002). Main dropped those sessions outright, so only the panels
 * themselves hold the config to start them with. A listener returns the work it
 * started so the next delete of the worktree can wait it out.
 */
export function onDevPreviewResume(listener: DevPreviewResumeListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Settles once every listener's restart has been handed to Main, or failed. */
export function resumeDevPreviews(worktreeId: string, panelIds: readonly string[]): Promise<void> {
  if (panelIds.length === 0) return Promise.resolve();
  const request: DevPreviewResumeRequest = { worktreeId, panelIds: new Set(panelIds) };
  const pending: Promise<unknown>[] = [];
  for (const listener of [...listeners]) {
    try {
      const result = listener(request);
      if (result) pending.push(result);
    } catch (error) {
      logWarn("[DevPreviewResume] A listener failed", { error });
    }
  }
  return Promise.allSettled(pending).then((results) => {
    for (const result of results) {
      if (result.status === "rejected") {
        logWarn("[DevPreviewResume] A listener failed", { error: result.reason });
      }
    }
  });
}
