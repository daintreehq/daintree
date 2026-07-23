import { projectRelocationCoordinator } from "../../services/ProjectRelocationCoordinator.js";
import { defineIpcNamespace, op } from "../define.js";
import { PROJECT_RELOCATION_METHOD_CHANNELS } from "./projectRelocation.preload.js";
import type { HandlerDependencies } from "../types.js";
import type { Project } from "../../types/index.js";
import type {
  RelocationPreview,
  RelocationRequest,
} from "../../../shared/types/projectRelocation.js";

// Captured at registration so the ops can configure the coordinator with the
// live runtime deps (PtyClient, WorkspaceClient, WindowRegistry, …) it needs to
// quiesce/rebind an open project — mirroring the inline `configure(deps)` the
// legacy `project:locate` handler does per call.
let handlerDeps: HandlerDependencies | undefined;

/**
 * Validate an untrusted renderer relocation request into the exact shape the
 * coordinator accepts. No silent fallback defaults (#7880) — a malformed field
 * throws rather than substituting a guessed value on a destructive submit.
 */
function validateRelocationRequest(request: RelocationRequest): {
  projectId: string;
  mode: "move" | "reattach";
  newPath: string;
} {
  if (!request || typeof request !== "object") {
    throw new Error("Invalid relocation request");
  }
  const { projectId, mode, newPath } = request;
  if (typeof projectId !== "string" || !projectId) {
    throw new Error("Invalid project ID");
  }
  if (mode !== "move" && mode !== "reattach") {
    throw new Error(`Invalid relocation mode: ${String(mode)}`);
  }
  if (typeof newPath !== "string" || !newPath) {
    throw new Error("Invalid destination path");
  }
  return { projectId, mode, newPath };
}

export const projectRelocationNamespace = defineIpcNamespace({
  name: "projectRelocation",
  ops: {
    preview: op(
      PROJECT_RELOCATION_METHOD_CHANNELS.preview,
      async (request: RelocationRequest): Promise<RelocationPreview> => {
        if (handlerDeps) projectRelocationCoordinator.configure(handlerDeps);
        return projectRelocationCoordinator.previewRelocate(validateRelocationRequest(request));
      }
    ),
    apply: op(
      PROJECT_RELOCATION_METHOD_CHANNELS.apply,
      async (request: RelocationRequest): Promise<Project> => {
        if (handlerDeps) projectRelocationCoordinator.configure(handlerDeps);
        return projectRelocationCoordinator.relocate(validateRelocationRequest(request));
      }
    ),
  },
});

export function registerProjectRelocationHandlers(deps: HandlerDependencies): () => void {
  handlerDeps = deps;
  return projectRelocationNamespace.register();
}
