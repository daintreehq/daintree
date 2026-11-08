import type { OnlineOnlyFilesSide, ProjectOnlineOnlyFiles } from "../types/onlineOnlyFiles.js";

/** Whether a walk saw anything still online-only. An incomplete zero saw nothing, so it says nothing. */
export function hasOnlineOnlyEntries(side: OnlineOnlyFilesSide | null | undefined): boolean {
  return !!side && (side.files + side.directories > 0 || side.rootOnlineOnly === true);
}

/**
 * Whether git status holds off for this project, decided in one place so the
 * host's gate and the notice's wording can't disagree.
 *
 * Only `.git` counts, because that is what git blocks on. An incomplete zero
 * doesn't hold: a linked worktree's `.git` pointer reports one forever, and
 * holding on it would leave a fully downloaded project with no status at all.
 * Git is killed and backed off if that zero turns out to be hiding placeholders.
 */
export function gitStatusWaitsForDownload(files: ProjectOnlineOnlyFiles | null): boolean {
  return hasOnlineOnlyEntries(files?.git);
}
