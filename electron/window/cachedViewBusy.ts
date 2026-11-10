import type { CachedViewReleaseBlock } from "../../shared/types/appError.js";
import { getProjectHeldElsewhereMessage } from "../../shared/utils/projectOpenErrors.js";
import { AppError } from "../utils/errorTypes.js";

/**
 * A project another window keeps only cached, and can't let go of: it backs a
 * running assistant, unsaved work, an MCP request, a save or a dictation
 * (#13291). The request fails rather than switching that window to the
 * project, and says which hold it met (#16724), so a hold that lasts isn't
 * offered a retry that can't succeed. `showable` is false where this machine
 * can't bring that window to the project when asked.
 */
export function cachedViewBusy(
  projectName: string,
  reason: CachedViewReleaseBlock,
  options: { showable?: boolean } = {}
): AppError {
  return new AppError({
    code: "PROJECT_HELD_ELSEWHERE",
    message: `Another window's cached view of ${projectName} can't be released (${reason})`,
    userMessage: getProjectHeldElsewhereMessage(projectName, reason),
    details: {
      code: "PROJECT_HELD_ELSEWHERE",
      reason,
      showable: options.showable ?? true,
    },
  });
}
