import { homedir } from "node:os";
import { detectCloudSyncService } from "../../../shared/utils/cloudSyncDetection.js";
import type { ProjectOnlineOnlyFiles } from "../../../shared/types/onlineOnlyFiles.js";
import type { ProjectOnlineOnlyService } from "../../services/ProjectOnlineOnlyService.js";
import { defineIpcNamespace, op } from "../define.js";
import { resolveScopedProjectForIpcContext } from "../projectContext.js";
import type { HandlerDependencies, IpcContext } from "../types.js";
import { ONLINE_ONLY_FILES_METHOD_CHANNELS } from "./onlineOnlyFiles.preload.js";

export function createOnlineOnlyFilesNamespace(deps: HandlerDependencies) {
  // Loaded by the first project that can use it. Everything else answers before this.
  let service: ProjectOnlineOnlyService | null = null;

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
            service?.release(ctx.endpoint);
            return null;
          }

          if (!service) {
            const { ProjectOnlineOnlyService } =
              await import("../../services/ProjectOnlineOnlyService.js");
            service ??= new ProjectOnlineOnlyService();
          }
          return service.watch(
            { id: project.id, path: project.path, service: location },
            ctx.endpoint
          );
        },
        { withContext: true }
      ),
      unwatch: op(
        ONLINE_ONLY_FILES_METHOD_CHANNELS.unwatch,
        async (ctx: IpcContext): Promise<void> => {
          service?.release(ctx.endpoint);
        },
        { withContext: true }
      ),
    },
  });

  return { namespace, dispose: () => service?.dispose() };
}

export function registerOnlineOnlyFilesHandlers(deps: HandlerDependencies): () => void {
  const { namespace, dispose } = createOnlineOnlyFilesNamespace(deps);
  const namespaceCleanup = namespace.register();
  return () => {
    dispose();
    namespaceCleanup();
  };
}
