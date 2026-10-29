import { logWarn } from "@/utils/logger";

type DevPreviewResumeListener = (panelIds: ReadonlySet<string>) => void;

const listeners = new Set<DevPreviewResumeListener>();

/**
 * Called when dev servers this view stopped for a worktree delete should run
 * again because the delete was abandoned and the worktree is still there
 * (#15002). Main dropped those sessions outright, so only the panels
 * themselves hold the config to start them with.
 */
export function onDevPreviewResume(listener: DevPreviewResumeListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function resumeDevPreviews(panelIds: readonly string[]): void {
  if (panelIds.length === 0) return;
  const ids: ReadonlySet<string> = new Set(panelIds);
  for (const listener of [...listeners]) {
    try {
      listener(ids);
    } catch (error) {
      logWarn("[DevPreviewResume] A listener failed", { error });
    }
  }
}
