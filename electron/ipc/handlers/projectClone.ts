import { defineIpcNamespace, op } from "../define.js";
import type { IpcContext } from "../types.js";
import { PROJECT_CLONE_METHOD_CHANNELS } from "./projectClone.preload.js";
import { getProjectCloneService } from "../../services/projectClone/ProjectCloneService.js";
import { normalizeCreationGroupId, normalizeCreationIdentity } from "./projectCrud/crud.js";
import { AppError } from "../../utils/errorTypes.js";
import type {
  ProjectCloneJobSnapshot,
  ProjectCloneStartRequest,
  ProjectCloneStartResult,
} from "../../../shared/types/ipc/projectClone.js";

/**
 * Background clones run on this machine for this machine's own views. A host's
 * remote views clone through the host flows, which keep the dialog's wait.
 */
function assertLocalCaller(ctx: IpcContext): void {
  if (ctx.endpoint?.kind === "remote-view") {
    throw new AppError({
      code: "UNSUPPORTED",
      message: "Background clones run only on this machine",
    });
  }
}

function requireProjectId(projectId: unknown): string {
  if (typeof projectId !== "string" || !projectId) {
    throw new AppError({ code: "VALIDATION", message: "projectId is required" });
  }
  return projectId;
}

export const projectCloneNamespace = defineIpcNamespace({
  name: "projectClone",
  ops: {
    start: op(
      PROJECT_CLONE_METHOD_CHANNELS.start,
      async (
        ctx: IpcContext,
        request: ProjectCloneStartRequest
      ): Promise<ProjectCloneStartResult> => {
        assertLocalCaller(ctx);
        if (!request || typeof request !== "object") {
          throw new AppError({ code: "VALIDATION", message: "Invalid clone request" });
        }
        const identity = normalizeCreationIdentity(request.identity);
        const groupId = normalizeCreationGroupId(request.groupId);
        return getProjectCloneService().start(
          {
            url: request.url,
            parentPath: request.parentPath,
            folderName: request.folderName,
            shallowClone: request.shallowClone === true,
          },
          { ...(identity ? { identity } : {}), ...(groupId ? { groupId } : {}) }
        );
      },
      { withContext: true }
    ),
    getJob: op(
      PROJECT_CLONE_METHOD_CHANNELS.getJob,
      async (projectId: string): Promise<ProjectCloneJobSnapshot | null> =>
        getProjectCloneService().getSnapshot(requireProjectId(projectId))
    ),
    stop: op(
      PROJECT_CLONE_METHOD_CHANNELS.stop,
      async (ctx: IpcContext, projectId: string): Promise<void> => {
        assertLocalCaller(ctx);
        getProjectCloneService().cancel(requireProjectId(projectId));
      },
      { withContext: true }
    ),
    retry: op(
      PROJECT_CLONE_METHOD_CHANNELS.retry,
      async (ctx: IpcContext, projectId: string): Promise<void> => {
        assertLocalCaller(ctx);
        await getProjectCloneService().retry(requireProjectId(projectId));
      },
      { withContext: true }
    ),
  },
});

export function registerProjectCloneHandlers(): () => void {
  return projectCloneNamespace.register();
}
