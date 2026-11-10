import { homedir } from "node:os";
import { detectCloudSyncService } from "../../../shared/utils/cloudSyncDetection.js";
import type { ProjectOnlineOnlyFiles } from "../../../shared/types/onlineOnlyFiles.js";
import { getProjectOnlineOnlyService } from "../../services/ProjectOnlineOnlyService.js";
import { defineIpcNamespace, op } from "../define.js";
import { resolveScopedProjectForIpcContext } from "../projectContext.js";
import type { HandlerDependencies, IpcContext } from "../types.js";
import { ONLINE_ONLY_FILES_METHOD_CHANNELS } from "./onlineOnlyFiles.preload.js";

export function createOnlineOnlyFilesNamespace(deps: HandlerDependencies) {
  // Holds nothing and starts nothing until a project in a cloud folder is watched.
  const service = getProjectOnlineOnlyService();

  const namespace = defineIpcNamespace({
    name: "onlineOnlyFiles",
    ops: {
      watch: op(
        ONLINE_ONLY_FILES_METHOD_CHANNELS.watch,
        async (ctx: IpcContext): Promise<ProjectOnlineOnlyFiles | null> => {
          // Only macOS flags placeholders, so this is the whole cost elsewhere.
          if (process.platform !== "darwin") return null;

          const project = resolveScopedProjectForIpcContext(ctx, deps)?.project;
          const location = project ? detectCloudSyncService(project.path, homedir(), "mac") : null;
          if (!project || !location) {
            // A view rebound away from a cloud project stops holding it.
            service.release(ctx.endpoint);
            return null;
          }

          return service.watch(
            // find prints a root without its trailing slash, and the probe compares against that.
            { id: project.id, path: project.path.replace(/\/+$/, ""), service: location },
            ctx.endpoint
          );
        },
        { withContext: true }
      ),
      unwatch: op(
        ONLINE_ONLY_FILES_METHOD_CHANNELS.unwatch,
        async (ctx: IpcContext): Promise<void> => {
          service.release(ctx.endpoint);
        },
        { withContext: true }
      ),
    },
  });

  return { namespace, dispose: () => service.dispose() };
}

export function registerOnlineOnlyFilesHandlers(deps: HandlerDependencies): () => void {
  const { namespace, dispose } = createOnlineOnlyFilesNamespace(deps);
  const namespaceCleanup = namespace.register();
  return () => {
    dispose();
    namespaceCleanup();
  };
}
