import { ipcMain } from "electron";
import { CHANNELS } from "../../channels.js";
import { store } from "../../../store.js";
import type { HandlerDependencies } from "../../types.js";
import type {
  AttachIssuePayload,
  DetachIssuePayload,
  IssueAssociation,
} from "../../../../shared/types/ipc/worktree.js";

export function registerWorktreePullRequestHandlers(deps: HandlerDependencies): () => void {
  const handlers: Array<() => void> = [];

  const handleWorktreePRRefresh = async () => {
    if (!deps.worktreeService) {
      return;
    }
    await deps.worktreeService.refreshPullRequests();
  };
  ipcMain.handle(CHANNELS.WORKTREE_PR_REFRESH, handleWorktreePRRefresh);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.WORKTREE_PR_REFRESH));

  const handleWorktreePRStatus = async () => {
    if (!deps.worktreeService) {
      return null;
    }
    return await deps.worktreeService.getPRStatus();
  };
  ipcMain.handle(CHANNELS.WORKTREE_PR_STATUS, handleWorktreePRStatus);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.WORKTREE_PR_STATUS));

  const handleWorktreeAttachIssue = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: AttachIssuePayload
  ): Promise<void> => {
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
  ipcMain.handle(CHANNELS.WORKTREE_ATTACH_ISSUE, handleWorktreeAttachIssue);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.WORKTREE_ATTACH_ISSUE));

  const handleWorktreeDetachIssue = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: DetachIssuePayload
  ): Promise<void> => {
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
  ipcMain.handle(CHANNELS.WORKTREE_DETACH_ISSUE, handleWorktreeDetachIssue);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.WORKTREE_DETACH_ISSUE));

  const handleWorktreeGetIssueAssociation = async (
    _event: Electron.IpcMainInvokeEvent,
    worktreeId: string
  ): Promise<IssueAssociation | null> => {
    if (typeof worktreeId !== "string" || !worktreeId.trim()) {
      throw new Error("Invalid worktreeId: must be a non-empty string");
    }

    const currentMap = store.get("worktreeIssueMap") ?? {};
    return currentMap[worktreeId] ?? null;
  };
  ipcMain.handle(CHANNELS.WORKTREE_GET_ISSUE_ASSOCIATION, handleWorktreeGetIssueAssociation);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.WORKTREE_GET_ISSUE_ASSOCIATION));

  const handleWorktreeGetAllIssueAssociations = async (): Promise<
    Record<string, IssueAssociation>
  > => {
    return store.get("worktreeIssueMap") ?? {};
  };
  ipcMain.handle(
    CHANNELS.WORKTREE_GET_ALL_ISSUE_ASSOCIATIONS,
    handleWorktreeGetAllIssueAssociations
  );
  handlers.push(() => ipcMain.removeHandler(CHANNELS.WORKTREE_GET_ALL_ISSUE_ASSOCIATIONS));

  return () => handlers.forEach((cleanup) => cleanup());
}
