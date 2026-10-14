import { AppError } from "../utils/errorTypes.js";

/**
 * A project another window keeps only cached, and can't let go of yet: it
 * backs a running assistant or an MCP request (#13291). The request fails
 * rather than switching that window to the project.
 */
export function cachedViewBusy(projectName: string): AppError {
  return new AppError({
    code: "PROJECT_OPEN_FAILED",
    message: `Another window's cached view of ${projectName} can't be released`,
    userMessage: `"${projectName}" is still busy in another window. Try again in a moment.`,
  });
}
