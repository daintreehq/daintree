import { defineIpcNamespace, op } from "../define.js";
import { pendingRemoteHostsHandler } from "../../remote/pendingHandler.js";
import { PROJECT_MATCH_METHOD_CHANNELS } from "./projectMatch.preload.js";
import type {
  FindProjectMatchPayload,
  ProjectMatchCandidate,
} from "../../../shared/types/ipc/projectMatch.js";

export const projectMatchNamespace = defineIpcNamespace({
  name: "projectMatch",
  ops: {
    find: op(
      PROJECT_MATCH_METHOD_CHANNELS.find,
      async (_payload: FindProjectMatchPayload): Promise<ProjectMatchCandidate[]> =>
        pendingRemoteHostsHandler(PROJECT_MATCH_METHOD_CHANNELS.find)
    ),
  },
});

export function registerProjectMatchHandlers(): () => void {
  return projectMatchNamespace.register();
}
