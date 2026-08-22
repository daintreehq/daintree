import path from "path";
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
let coordinatorPromise:
  | Promise<
      typeof import("../../services/ProjectRelocationCoordinator.js").projectRelocationCoordinator
    >
  | undefined;

async function getCoordinator() {
  return (coordinatorPromise ??= import("../../services/ProjectRelocationCoordinator.js").then(
    ({ projectRelocationCoordinator }) => projectRelocationCoordinator
  ));
}

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
  // Require an absolute path: a relative value (e.g. ".") would otherwise resolve
  // against the main-process CWD inside the coordinator, silently reattaching to
  // an arbitrary folder.
  if (!path.isAbsolute(newPath)) {
    throw new Error("Destination path must be absolute");
  }
  return { projectId, mode, newPath };
}

export const projectRelocationNamespace = defineIpcNamespace({
  name: "projectRelocation",
  ops: {
    preview: op(
      PROJECT_RELOCATION_METHOD_CHANNELS.preview,
      async (request: RelocationRequest): Promise<RelocationPreview> => {
        const coordinator = await getCoordinator();
        if (handlerDeps) coordinator.configure(handlerDeps);
        return coordinator.previewRelocate(validateRelocationRequest(request));
      }
    ),
    apply: op(
      PROJECT_RELOCATION_METHOD_CHANNELS.apply,
      async (request: RelocationRequest): Promise<Project> => {
        const coordinator = await getCoordinator();
        if (handlerDeps) coordinator.configure(handlerDeps);
        return coordinator.relocate(validateRelocationRequest(request));
      }
    ),
  },
});

export function registerProjectRelocationHandlers(deps: HandlerDependencies): () => void {
  handlerDeps = deps;
  return projectRelocationNamespace.register();
}
