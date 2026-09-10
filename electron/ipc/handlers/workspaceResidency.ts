import { z } from "zod";
import { defineIpcNamespace, opValidated } from "../define.js";
import { WORKSPACE_RESIDENCY_METHOD_CHANNELS } from "./workspaceResidency.preload.js";
import {
  isWorkspaceKeepResident,
  setWorkspaceKeepResident,
} from "../../services/workspaceResidency.js";

const WorkspaceIdSchema = z.object({ workspaceId: z.string().min(1) });
const SetResidencySchema = WorkspaceIdSchema.extend({ keepResident: z.boolean() });

/**
 * The user's "keep this workspace resident" grant (#12313).
 *
 * Its own namespace, and deliberately not an `ActionService` action: the action
 * manifest is the MCP tool surface, so an action here would let a bound client
 * grant itself the residency #11790 refused to give it automatically. Reaching
 * this needs the renderer, which needs the user.
 */
export const workspaceResidencyNamespace = defineIpcNamespace({
  name: "workspaceResidency",
  ops: {
    get: opValidated(
      WORKSPACE_RESIDENCY_METHOD_CHANNELS.get,
      WorkspaceIdSchema,
      (payload): boolean => isWorkspaceKeepResident(payload.workspaceId)
    ),
    set: opValidated(
      WORKSPACE_RESIDENCY_METHOD_CHANNELS.set,
      SetResidencySchema,
      (payload): void => {
        const { workspaceId, keepResident } = payload;
        // Not validated against the project catalog on purpose. A grant for a
        // workspace that does not exist protects nothing — eviction only ever
        // applies it to a live view — so refusing here would buy no safety and
        // would make the toggle fail during a project move, when the id is
        // stable but the record is briefly in flight.
        setWorkspaceKeepResident(workspaceId, keepResident);
      }
    ),
  },
});

export function registerWorkspaceResidencyHandlers(): () => void {
  return workspaceResidencyNamespace.register();
}
