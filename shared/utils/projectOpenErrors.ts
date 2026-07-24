import type { AppErrorCode } from "../types/appError.js";

/**
 * User-facing copy for the folder-open failures classified by the pre-flight
 * stat in `electron/services/projectOpenPreflight.ts` (#11409).
 *
 * Shared by the native dialog (`electron/menu.ts`) and the renderer toast
 * (`src/store/projectStore.ts`) so the two surfaces can't drift the way the
 * three independent message-matching copies did before. `NOT_A_GIT_REPO` is
 * deliberately absent — that stays the guided git-init path.
 */

export type ProjectOpenRecovery = "remove-from-recent" | "choose-folder" | "retry";

export interface ProjectOpenFailure {
  title: string;
  message: string;
  recovery: ProjectOpenRecovery;
  /**
   * Whether the filesystem proved this path is dead — gone, or no longer a
   * folder — so a stored project row pointing at it can be offered for removal.
   *
   * False for everything that only proves the path is *unreachable*: a timeout,
   * ESTALE, EIO, a permission failure, a malformed path. Those can't show the
   * project is gone, and deleting its row on that evidence would destroy state
   * over an unproven claim — the absent-vs-unreadable distinction from #11258.
   */
  removable: boolean;
}

/** Label for the single recovery action each failure offers. */
export const PROJECT_OPEN_RECOVERY_LABELS: Record<ProjectOpenRecovery, string> = {
  "remove-from-recent": "Remove from recent",
  "choose-folder": "Choose another folder",
  retry: "Try again",
};

/**
 * Named so the copy reads naturally when the caller has no path to show. The
 * renderer often doesn't: `sanitizeErrorForRenderer` scrubs absolute paths out
 * of every error message crossing IPC, so a path must come from the caller's
 * own state or not at all.
 */
function describe(directoryPath: string | undefined): string {
  return directoryPath ? `"${directoryPath}"` : "That folder";
}

/**
 * Copy for a classified folder-open failure, or `null` if the code isn't one of
 * them (the caller then falls back to its own generic handling).
 *
 * The returned `recovery` is the baseline for the code. A caller that knows the
 * path is a stored project row upgrades it via {@link withRemoveFromRecent} —
 * the table can't know that on its own.
 */
export function getProjectOpenFailure(
  code: AppErrorCode,
  directoryPath?: string
): ProjectOpenFailure | null {
  const subject = describe(directoryPath);

  switch (code) {
    case "NOT_FOUND":
      return {
        title: "Couldn't open folder",
        message: `${subject} isn't there anymore. It may have been moved, renamed, or deleted, or it's on a drive that isn't connected.`,
        recovery: "choose-folder",
        removable: true,
      };
    case "NOT_A_DIRECTORY":
      return {
        title: "Couldn't open folder",
        message: `${subject} is a file, not a folder. Pick the folder that contains the project.`,
        recovery: "choose-folder",
        removable: true,
      };
    case "INVALID_PATH":
      return {
        title: "Couldn't open folder",
        message: `${subject} can't be used as a project. The path is either too long or points through a symbolic link that loops back on itself.`,
        recovery: "choose-folder",
        removable: false,
      };
    case "PERMISSION":
      return {
        title: "Couldn't open folder",
        message: `Daintree doesn't have permission to read ${directoryPath ? `"${directoryPath}"` : "that folder"}. Check the folder's permissions and try again.`,
        recovery: "retry",
        removable: false,
      };
    case "DUBIOUS_OWNERSHIP":
      return {
        title: "Couldn't open repository",
        message: `Git won't open ${directoryPath ? `"${directoryPath}"` : "that folder"} because it's owned by a different user. Add it to Git's safe.directory list and try again.`,
        recovery: "retry",
        removable: false,
      };
    case "GIT_NOT_INSTALLED":
      return {
        title: "Couldn't find Git",
        message:
          "Daintree needs Git to open a project, and it isn't on your PATH. Install Git and try again.",
        recovery: "retry",
        removable: false,
      };
    case "PROJECT_OPEN_FAILED":
      return {
        title: "Couldn't open folder",
        message: `Something went wrong opening ${directoryPath ? `"${directoryPath}"` : "that folder"}. The folder may be on a drive that isn't responding, or it may no longer be a working repository.`,
        recovery: "retry",
        removable: false,
      };
    default:
      return null;
  }
}

/**
 * Offer removal from the Recent Projects list instead of a folder picker.
 *
 * Only a row the filesystem proved dead qualifies — the folder is gone, or the
 * path is now a file. A path that merely failed to respond
 * (`PROJECT_OPEN_FAILED` from a timeout, ESTALE, or EIO) or that we couldn't
 * read (`PERMISSION`) is unreadable, not absent: deleting its project row would
 * destroy state over an unproven claim — the absent-vs-unreadable distinction
 * from #11258.
 */
export function withRemoveFromRecent(failure: ProjectOpenFailure): ProjectOpenFailure {
  if (!failure.removable) return failure;
  return { ...failure, recovery: "remove-from-recent" };
}
