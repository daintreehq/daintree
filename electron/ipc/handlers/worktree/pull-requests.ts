// eager-import-allow: reads PR/auth settings via store.get synchronously in the IPC handler
import { CHANNELS } from "../../channels.js";
import { store } from "../../../store.js";
import type { HandlerDependencies } from "../../types.js";
import type {
  AttachIssuePayload,
  DetachIssuePayload,
  IssueAssociation,
} from "../../../../shared/types/ipc/worktree.js";
import type { PRServiceStatus } from "../../../../shared/types/workspace-host.js";
import { defineIpcNamespace, op } from "../../define.js";

export function registerWorktreePullRequestHandlers(deps: HandlerDependencies): () => void {
  const handleWorktreePRRefresh = async (): Promise<void> => {
    if (!deps.worktreeService) {
      return;
    }
    await deps.worktreeService.refreshPullRequests();
  };

  const handleWorktreePRStatus = async (): Promise<PRServiceStatus | null> => {
    if (!deps.worktreeService) {
      return null;
    }
    return await deps.worktreeService.getPRStatus();
  };

  const handleWorktreeAttachIssue = async (payload: AttachIssuePayload): Promise<void> => {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid payload for worktree:attach-issue");
    }

    const { worktreeId, issueNumber, issueTitle } = payload;

    if (typeof worktreeId !== "string" || !worktreeId.trim()) {
      throw new Error("Invalid worktreeId: must be a non-empty string");
    }
    if (typeof issueNumber !== "number" || !Number.isInteger(issueNumber) || issueNumber <= 0) {
      throw new Error("Invalid issueNumber: must be a positive integer");
    }
    if (typeof issueTitle !== "string") {
      throw new Error("Invalid issueTitle: must be a string");
    }

    const association: IssueAssociation = {
      issueNumber,
      issueTitle,
    };

    const currentMap = store.get("worktreeIssueMap") ?? {};
    store.set("worktreeIssueMap", { ...currentMap, [worktreeId]: association });
  };

  const handleWorktreeDetachIssue = async (payload: DetachIssuePayload): Promise<void> => {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid payload for worktree:detach-issue");
    }

    const { worktreeId } = payload;

    if (typeof worktreeId !== "string" || !worktreeId.trim()) {
      throw new Error("Invalid worktreeId: must be a non-empty string");
    }

    const currentMap = store.get("worktreeIssueMap") ?? {};
    const { [worktreeId]: _removed, ...rest } = currentMap;
    store.set("worktreeIssueMap", rest);
  };

  const handleWorktreeGetAllIssueAssociations = async (): Promise<
    Record<string, IssueAssociation>
  > => {
    return store.get("worktreeIssueMap") ?? {};
  };

  const namespace = defineIpcNamespace({
    name: "worktreePullRequests",
    ops: {
      prRefresh: op(CHANNELS.WORKTREE_PR_REFRESH, handleWorktreePRRefresh),
      prStatus: op(CHANNELS.WORKTREE_PR_STATUS, handleWorktreePRStatus),
      attachIssue: op(CHANNELS.WORKTREE_ATTACH_ISSUE, handleWorktreeAttachIssue),
      detachIssue: op(CHANNELS.WORKTREE_DETACH_ISSUE, handleWorktreeDetachIssue),
      getAllIssueAssociations: op(
        CHANNELS.WORKTREE_GET_ALL_ISSUE_ASSOCIATIONS,
        handleWorktreeGetAllIssueAssociations
      ),
    },
  });

  return namespace.register();
}
