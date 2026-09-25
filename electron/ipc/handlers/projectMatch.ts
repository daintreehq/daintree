import { defineIpcNamespace, op } from "../define.js";
import { PROJECT_MATCH_METHOD_CHANNELS } from "./projectMatch.preload.js";
import { getProjectAcrossHostsService } from "../../services/projectAcrossHosts/index.js";
import type {
  FindProjectMatchPayload,
  FindWorktreeForBranchPayload,
  PendingHostSetup,
  ProjectMatchCandidate,
  ScanProjectMatchPayload,
  TakePendingHostSetupPayload,
  WorktreeForBranch,
} from "../../../shared/types/ipc/projectMatch.js";

/**
 * The host's answers about its own projects. Host-classified: a remote
 * window's calls run here on its host.
 */
export const projectMatchNamespace = defineIpcNamespace({
  name: "projectMatch",
  ops: {
    find: op(
      PROJECT_MATCH_METHOD_CHANNELS.find,
      async (payload: FindProjectMatchPayload): Promise<ProjectMatchCandidate[]> =>
        getProjectAcrossHostsService().match(payload)
    ),
    scan: op(
      PROJECT_MATCH_METHOD_CHANNELS.scan,
      async (payload: ScanProjectMatchPayload): Promise<ProjectMatchCandidate[]> =>
        getProjectAcrossHostsService().scan(payload)
    ),
    findWorktreeForBranch: op(
      PROJECT_MATCH_METHOD_CHANNELS.findWorktreeForBranch,
      async (payload: FindWorktreeForBranchPayload): Promise<WorktreeForBranch> =>
        getProjectAcrossHostsService().findWorktreeForBranch(payload)
    ),
    takePendingSetup: op(
      PROJECT_MATCH_METHOD_CHANNELS.takePendingSetup,
      async (payload: TakePendingHostSetupPayload): Promise<PendingHostSetup | null> =>
        getProjectAcrossHostsService().takePendingSetup(payload?.projectId)
    ),
  },
});

export function registerProjectMatchHandlers(): () => void {
  return projectMatchNamespace.register();
}
