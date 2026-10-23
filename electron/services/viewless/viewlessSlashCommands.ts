import { CHANNELS } from "../../ipc/channels.js";
import type { ActionDispatchResult } from "../../../shared/types/actions.js";
import type { Project } from "../../../shared/types/project.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import type { ViewlessActionRequest, ViewlessDeps } from "./ViewlessActionExecutor.js";
import { SlashCommandsListArgsSchema } from "./viewlessArgsSchemas.js";
import {
  viewlessFailure as failure,
  viewlessSuccess as success,
  viewlessValidationFailure as validationFailure,
} from "./viewlessResult.js";

/**
 * An agent CLI's slash commands, project-local ones included, for a project
 * with no frontend attached (#14122): the same handler the view's action
 * reaches, so a usage check that confirms its command first works on a host
 * nobody has open. The project defaults to the one the call is bound to, as a
 * view defaults to its own; an id names another of the host's projects, and
 * the id wins over a path, as it does in a view.
 */
export async function runSlashCommandsList(
  request: ViewlessActionRequest,
  project: Project,
  deps: ViewlessDeps
): Promise<ActionDispatchResult> {
  const parsed = SlashCommandsListArgsSchema.safeParse(request.args);
  if (!parsed.success) return validationFailure(request.actionId, parsed.error);
  const args = parsed.data ?? {};

  let projectPath = project.path;
  if (args.projectId !== undefined) {
    const named = args.projectId === project.id ? project : deps.getProject(args.projectId);
    if (!named) {
      return failure(
        "VALIDATION_ERROR",
        `This host has no project with id ${args.projectId}. project.getAll names its projects.`
      );
    }
    projectPath = named.path;
  } else if (args.projectPath !== undefined) {
    projectPath = args.projectPath;
  }

  try {
    const commands = await deps.invoke<unknown[]>(project.id, CHANNELS.SLASH_COMMANDS_LIST, [
      { agentId: args.agentId ?? "claude", projectPath },
    ]);
    return success({ commands });
  } catch (err) {
    return failure("EXECUTION_ERROR", formatErrorMessage(err, "Failed to list slash commands"));
  }
}
