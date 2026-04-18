import { CHANNELS } from "../../channels.js";
import { store } from "../../../store.js";
import type { HandlerDependencies } from "../../types.js";
import type {
  AttachIssuePayload,
  DetachIssuePayload,
  IssueAssociation,
} from "../../../../shared/types/ipc/worktree.js";
import { typedHandle } from "../../utils.js";

export function registerWorktreePullRequestHandlers(deps: HandlerDependencies): () => void {
  const handlers: Array<() => void> = [];

  const handleWorktreePRRefresh = async () => {
    if (!deps.worktreeService) {
      return;
    }
    await deps.worktreeService.refreshPullRequests();
  };
  handlers.push(typedHandle(CHANNELS.WORKTREE_PR_REFRESH, handleWorktreePRRefresh));

  const handleWorktreePRStatus = async () => {
    if (!deps.worktreeService) {
      return null;
    }
    return await deps.worktreeService.getPRStatus();
  };
  handlers.push(typedHandle(CHANNELS.WORKTREE_PR_STATUS, handleWorktreePRStatus));

  const handleWorktreeAttachIssue = async (payload: AttachIssuePayload): Promise<void> => {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid payload for worktree:attach-issue");
    }

    const { worktreeId, issueNumber, issueTitle, issueState, issueUrl } = payload;

    if (typeof worktreeId !== "string" || !worktreeId.trim()) {
      throw new Error("Invalid worktreeId: must be a non-empty string");
    }
    if (typeof issueNumber !== "number" || !Number.isInteger(issueNumber) || issueNumber <= 0) {
      throw new Error("Invalid issueNumber: must be a positive integer");
    }
    if (typeof issueTitle !== "string") {
      throw new Error("Invalid issueTitle: must be a string");
    }
    if (issueState !== "OPEN" && issueState !== "CLOSED") {
      throw new Error("Invalid issueState: must be 'OPEN' or 'CLOSED'");
    }
    if (typeof issueUrl !== "string" || !issueUrl.trim()) {
      throw new Error("Invalid issueUrl: must be a non-empty string");
    }

    const association: IssueAssociation = {
      issueNumber,
      issueTitle,
      issueState,
      issueUrl,
    };

    const currentMap = store.get("worktreeIssueMap") ?? {};
    store.set("worktreeIssueMap", { ...currentMap, [worktreeId]: association });
  };
  handlers.push(typedHandle(CHANNELS.WORKTREE_ATTACH_ISSUE, handleWorktreeAttachIssue));

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
  handlers.push(typedHandle(CHANNELS.WORKTREE_DETACH_ISSUE, handleWorktreeDetachIssue));

  const handleWorktreeGetIssueAssociation = async (
    worktreeId: string
  ): Promise<IssueAssociation | null> => {
    if (typeof worktreeId !== "string" || !worktreeId.trim()) {
      throw new Error("Invalid worktreeId: must be a non-empty string");
    }

    const currentMap = store.get("worktreeIssueMap") ?? {};
    return currentMap[worktreeId] ?? null;
  };
  handlers.push(
    typedHandle(CHANNELS.WORKTREE_GET_ISSUE_ASSOCIATION, handleWorktreeGetIssueAssociation)
  );

  const handleWorktreeGetAllIssueAssociations = async (): Promise<
    Record<string, IssueAssociation>
  > => {
    return store.get("worktreeIssueMap") ?? {};
  };
  handlers.push(
    typedHandle(CHANNELS.WORKTREE_GET_ALL_ISSUE_ASSOCIATIONS, handleWorktreeGetAllIssueAssociations)
  );

  return () => handlers.forEach((cleanup) => cleanup());
}
