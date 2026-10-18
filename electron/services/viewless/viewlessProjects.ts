import { z } from "zod";
import { CHANNELS } from "../../ipc/channels.js";
import type { ActionDispatchResult } from "../../../shared/types/actions.js";
import type { Project } from "../../../shared/types/project.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import type { ViewlessActionRequest, ViewlessDeps } from "./ViewlessActionExecutor.js";
import {
  viewlessFailure as failure,
  viewlessSuccess as success,
  viewlessValidationFailure as validationFailure,
} from "./viewlessResult.js";

const DetectRunnersArgsSchema = z.object({ projectId: z.string().optional() }).optional();

export async function runProjectGetAll(
  _request: ViewlessActionRequest,
  project: Project,
  deps: ViewlessDeps
): Promise<ActionDispatchResult> {
  try {
    const projects = await deps.invoke<unknown[]>(project.id, CHANNELS.PROJECT_GET_ALL, []);
    return success({ projects });
  } catch (err) {
    return failure("EXECUTION_ERROR", formatErrorMessage(err, "Failed to list projects"));
  }
}

/** Runners for the named project, else the one this call is bound to, as a view defaults to its own. */
export async function runProjectDetectRunners(
  request: ViewlessActionRequest,
  project: Project,
  deps: ViewlessDeps
): Promise<ActionDispatchResult> {
  const parsed = DetectRunnersArgsSchema.safeParse(request.args);
  if (!parsed.success) return validationFailure(request.actionId, parsed.error);
  const projectId = parsed.data?.projectId ?? request.context?.projectId ?? project.id;
  try {
    const runners = await deps.invoke<unknown[]>(project.id, CHANNELS.PROJECT_DETECT_RUNNERS, [
      projectId,
    ]);
    return success({ runners });
  } catch (err) {
    return failure("EXECUTION_ERROR", formatErrorMessage(err, "Failed to detect runners"));
  }
}
