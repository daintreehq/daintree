import { CHANNELS } from "../channels.js";
import { projectViewManagersFrom } from "../../window/activeProjectIds.js";
import { sleepProject } from "../../services/projectSleep.js";
import { defineIpcNamespace, op } from "../define.js";
import type { HandlerDependencies } from "../types.js";
import type { ProjectSleepResult } from "../../../shared/types/ipc/project.js";

/**
 * `project:sleep` — the user's Sleep project. The teardown itself lives in
 * `sleepProject` (`electron/services/projectSleep.ts`), shared with the idle
 * reminder and idle auto-close so all three leave a project in the same state.
 *
 * Lives in its own `defineIpcNamespace` block rather than the hand-written
 * `project` namespace so its `IpcInvokeMap` entry is codegen-generated — new
 * channels must not grow the hand-written ratchet (`check:ipc-handwritten`).
 */
export function registerProjectSleepHandlers(deps: HandlerDependencies): () => void {
  const namespace = defineIpcNamespace({
    name: "projectSleep",
    ops: {
      sleepProject: op(
        CHANNELS.PROJECT_SLEEP,
        async (projectId: string): Promise<ProjectSleepResult> => {
          // Resolved before the sleep starts: it is read synchronously at the
          // commit, and PluginService stays off the handler's static graph.
          const { pluginService } = await import("../../services/PluginService.js");
          const pluginWork = (id: string) => pluginService.getProjectPluginWork(id);
          const outcome = await sleepProject(
            projectId,
            { initiator: "user" },
            {
              ptyClient: deps.ptyClient,
              workspaceClient: deps.worktreeService,
              projectViewManagers: projectViewManagersFrom(deps.windowRegistry),
              pluginWork,
            }
          );
          // A user sleep is never skipped — only a policy backs off — so
          // anything but "slept" found the project already asleep.
          if (outcome.status !== "slept") {
            return { terminalsKilled: 0, rendererViewsEvicted: 0, workspaceEvicted: false };
          }
          const { terminalsKilled, rendererViewsEvicted, workspaceEvicted, pluginWorkStopped } =
            outcome;
          return {
            terminalsKilled,
            rendererViewsEvicted,
            workspaceEvicted,
            ...(pluginWorkStopped ? { pluginWorkStopped } : {}),
          };
        }
      ),
    },
  });

  return namespace.register();
}
